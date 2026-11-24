// Conector de la fábrica con Antigravity por `agy acp` (Agent Client Protocol por stdio, SDK oficial).
// Frontera de seguridad: el revisor nunca escribe. Toda `session/request_permission` se contesta con la opción de
// rechazo (o `cancelled` si no la hay) y cualquier otra petición del agente (escribir archivos, terminales...) con error.
//
// Comprobado contra agy 1.5.9 sin llamar al modelo (`initialize`, `session/new` y ajustes de sesión no consumen):
// - Modelo: `session/set_model` con el id completo (`gemini-4-hydrogen-xhigh`) fija el modelo y el nivel de
//   razonamiento; un id desconocido da el error -32602. `session/set_config_option` también vale, pero por partes
//   (`model` = id base y `thought_level` = esfuerzo). `agy acp` no admite `--settings`.
// - Aislamiento: con el directorio de datos de la persona, la sesión ACP arranca sus MCP (`mcp_config.json`), carga
//   sus skills y plugins y aplica sus ajustes, incluida su lista `permissions.allow`, que aprobaría órdenes sin
//   preguntar. `--include-default-customizations=false` no cambia nada de eso. `--gemini-dir <carpeta temporal>` sí:
//   sin MCP, sin skills ni plugins de la persona, con los ajustes por defecto y la autenticación del llavero intacta.
// - Siguen activas las personalizaciones del repo (`.agents/`): sus skills e instrucciones pasan por los permisos,
//   pero sus hooks y los MCP de sus plugins ejecutan código sin preguntar. `.gemini/` del repo (settings.json con
//   `mcpServers`, `tools.discoveryCommand` o `permissions.allow`, `mcp_config.json`, skills) no se cargó en
//   `session/new`; durante un turno no se puede comprobar sin modelo. Por eso se aplica una lista blanca: solo
//   `skills`, `rules` y `workflows` en `.agents/` (y variantes), sin `.gemini/` ni enlaces simbólicos; si no, no se
//   abre la sesión.
// - El modo `default` pide permiso antes de editar y de ejecutar órdenes. Si la sesión abre o pasa a otro modo, se
//   cancela. `/teamwork`, `/boost` y `/swarm` son órdenes de barra que la fábrica no envía; que sus subagentes pasen
//   por los mismos permisos no se puede comprobar sin llamar al modelo.
// Modo escritura (opción explícita `escritura: { raiz, ordenesPermitidas }`, usada por `nexakit encargar`): la sesión
// se abre con `cwd` exactamente en la raíz canónica y `session/request_permission` se aprueba (siempre con la opción
// «permitir una vez», nunca «siempre») solo si todas las rutas están dentro de la raíz, sin enlaces simbólicos ni `..`,
// y, si es una orden, coincide exactamente con `ordenesPermitidas` y no está encadenada. El resto se rechaza y se
// anota. Las reglas persistentes de la persona (`permissions.allow`) no se aplican gracias a `--gemini-dir`; las del
// repo (`.gemini/`) se rechazan por la lista blanca de personalizaciones, que sigue vigente en este modo.
// Órdenes en modo escritura, comprobado con una sesión real contra agy 1.5.14 en macOS (`gemini-3.8-flash-low`, unos
// 11 000 tokens; no hay subcomando para ejecutar una orden en el sandbox sin el modelo): con `--sandbox`, la orden
// `npm test` aprobada corre en el sandbox (el binario usa `/usr/bin/sandbox-exec`) y su script no pudo escribir fuera del `cwd` (carpeta personal, carpeta
// hermana, el `node_modules` enlazado, `.git/hooks` y `.git/config` del repo real; también desde un `sh` hijo), ni leer
// fuera de él, ni usar la red (DNS y HTTPS: ENOTFOUND). Sí pudo escribir en `/tmp` y en el `TMPDIR` del sistema, que
// no son el repo. Tampoco pudo escribir dentro del `cwd` cuando este cuelga de una carpeta oculta (`~/.nexakit/...`):
// las órdenes que generan archivos fallan, pero no escapan. La petición llega como `kind: execute`, `name: run_command`
// y `rawInput` = { CommandLine, BypassSandbox, WaitMsBeforeAsync, toolSummary } (repetido en `args`); salir del sandbox
// (`BypassSandbox` distinto de `false`) se rechaza siempre. Solo en macOS: en Linux y Windows no se verificó y no se
// aprueba ninguna orden (`ORDENES_ACTIVAS`).
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { client, ndJsonStream, PROTOCOL_VERSION, RequestError } from '@agentclientprotocol/sdk';
import type {
  AnyMessage,
  ClientCapabilities,
  ClientConnection,
  ContentBlock,
  InitializeRequest,
  NewSessionRequest,
  PromptRequest,
  RequestPermissionResponse,
  SessionNotification,
} from '@agentclientprotocol/sdk';
import { resolveCliInvocation } from '../../../src/cli-executable.js';
import { hallazgosJsonSchema, InformeEstacion } from '../esquemas.js';
import { barrerGrupo, LANZAR_EN_GRUPO, terminarArbol } from '../jsonrpc.js';
import { nombreSeguro, type AlProgreso, type Conector, type Encargo, type ResultadoEstacion } from './tipos.js';

const NO_INSTALADO = 'Antigravity no está instalado';
const HALLAZGOS_INVALIDOS = 'El revisor no devolvió hallazgos válidos';
const CANCELADA = 'La revisión se canceló';
const INSTRUCCION_ESQUEMA = 'Responde solo con JSON que cumpla este esquema';
const CORRECCION = 'Tu respuesta anterior no cumplía el esquema.';
const TIEMPO_PETICION_MS = 60_000;
const TIEMPO_CANCELACION_MS = 10_000;
const TIEMPO_CIERRE_SESION_MS = 5_000;
const GRACIA_CIERRE_MS = 2_000;
const MAX_SALIDA_ERROR = 64 * 1024;
const MAX_DETALLE = 500;
/** Tope de avisos de modo guardados para sesiones aún sin registrar. */
const MAX_MODOS_SIN_SESION = 256;
/** Argumentos de `agy acp`; detrás va `--gemini-dir <carpeta aislada>`. */
const ARGUMENTOS_ACP = ['acp', '--sandbox', '--process-per-session', '--disable-telemetry'];
/** Modo de Antigravity que pide permiso antes de editar y de ejecutar órdenes. */
const MODO_CON_PERMISOS = 'default';
const SUFIJO_ESFUERZO = /-(low|medium|high|xhigh)$/u;
/** Ni lectura ni escritura de archivos por el cliente, ni terminales. */
const CAPACIDADES_CLIENTE: ClientCapabilities = { fs: { readTextFile: false, writeTextFile: false }, terminal: false };
const RAICES_PERSONALIZACION = ['.agents', '.agent', '_agents', '_agent'];
/** Lo único que se admite dentro de esas carpetas: instrucciones que pasan por los permisos. */
const PERSONALIZACIONES_ADMITIDAS = new Set(['skills', 'rules', 'workflows']);
/** Carpeta de configuración de Gemini/Antigravity en el repo: nunca se admite. */
const CONFIG_GEMINI = '.gemini';
const TIPOS_IMAGEN: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

export interface OpcionesConectorAntigravity {
  /** Ejecutable que se lanza; por defecto se resuelve `agy` (sin shell, también `agy.cmd` en Windows). */
  orden?: string;
  /** Argumentos previos a `acp` (solo con `orden`). */
  argsPrefijo?: string[];
  /**
   * Modo escritura, explícito y acotado: solo se aprueban permisos sobre rutas dentro de `raiz` y órdenes que
   * coincidan exactamente con `ordenesPermitidas`. Sin esta opción se rechaza todo permiso.
   */
  escritura?: { raiz: string; ordenesPermitidas: string[] };
}

/** Modo escritura ya validado: raíz canónica y órdenes recortadas. */
interface Escritura {
  raiz: string;
  /** La raíz tal como se pidió (absoluta, normalizada), para aceptar rutas que la usen como prefijo. */
  raizPedida: string;
  ordenes: Set<string>;
}

/** Tipos de petición de permiso que el modo escritura puede llegar a aprobar. */
const TIPOS_APROBABLES = new Set(['read', 'edit', 'delete', 'move', 'search', 'execute']);
/**
 * El modo escritura aprueba órdenes de `ordenesPermitidas` (coincidencia exacta) solo donde se verificó el `--sandbox`
 * de `agy`: en macOS (ver la cabecera). En Linux y Windows no se verificó, así que allí no se aprueba ninguna orden
 * (una orden permitida, como `npm test`, ejecuta código del worktree).
 */
export const ORDENES_ACTIVAS = process.platform === 'darwin';
const MOTIVO_ORDENES_DESACTIVADAS = 'órdenes desactivadas en Antigravity fuera de macOS: su sandbox solo se verificó en macOS';
/** Encadenados, redirecciones y sustituciones: una orden con cualquiera se rechaza aunque empiece por una permitida. */
const ENCADENADO = /[;&|<>`\n\r]|\$\(/u;
/** Componentes que el agente no puede escribir dentro de la raíz (personalización, hooks y metadatos de git). */
export const COMPONENTES_PROTEGIDOS = new Set(['.git', '.gemini', '.agents', '.agent', '_agents', '_agent', '.claude', '.codex', '.nexakit', '.vscode', '.husky']);

/** Un componente de ruta protegido, sin distinguir mayúsculas ni los puntos y espacios finales (que Windows ignora). */
export function esComponenteProtegido(parte: string): boolean {
  return COMPONENTES_PROTEGIDOS.has(parte.toLowerCase().replace(/[. ]+$/u, ''));
}

/** Claves de `rawInput` que contienen una ruta (nombres normalizados: minúsculas y sin `_` ni `-`). */
const CLAVES_RUTA = new Set(['path', 'filepath', 'absolutepath', 'targetfile', 'file', 'directory', 'directorypath', 'dir', 'searchpath', 'oldpath', 'newpath', 'from', 'to', 'source', 'destination', 'dest']);
const CLAVES_TEXTO = ['content', 'contents', 'text', 'newtext', 'oldtext', 'newstring', 'oldstring', 'replacement', 'description', 'instruction'];
const CLAVES_LECTURA = ['offset', 'limit', 'line', 'startline', 'endline'];
const CLAVES_BUSQUEDA = ['query', 'pattern', 'glob', 'include', 'exclude', 'regex', 'casesensitive'];
/** Lista cerrada de claves de `rawInput` admitidas por tipo de petición; cualquier otra rechaza la petición. */
const CLAVES_ADMITIDAS: Record<string, Set<string>> = {
  edit: new Set([...CLAVES_RUTA, ...CLAVES_TEXTO]),
  delete: new Set(CLAVES_RUTA),
  move: new Set(CLAVES_RUTA),
  read: new Set([...CLAVES_RUTA, ...CLAVES_LECTURA]),
  search: new Set([...CLAVES_RUTA, ...CLAVES_BUSQUEDA]),
  // agy 1.5.14 (`run_command`) manda `CommandLine`, `BypassSandbox`, `WaitMsBeforeAsync` y `toolSummary`.
  execute: new Set(['command', 'commandline', 'cwd', 'bypasssandbox', 'waitmsbeforeasync', 'toolsummary', 'toolaction']),
};
/** Claves informativas de una orden (texto que el agente pone para la persona); no cambian lo que se ejecuta. */
const CLAVES_ORDEN_INFORMATIVAS = new Set(['toolsummary', 'toolaction']);
/** Tipos que escriben: sus rutas no pueden tocar los componentes protegidos. */
const TIPOS_ESCRITURA = new Set(['edit', 'delete', 'move']);

/** JSON con las claves ordenadas, para comparar dos objetos sin depender del orden. */
function canonico(valor: unknown): string {
  if (Array.isArray(valor)) return `[${valor.map(canonico).join(',')}]`;
  if (esObjeto(valor)) {
    return `{${Object.keys(valor).sort().map((k) => `${JSON.stringify(k)}:${canonico(valor[k])}`).join(',')}}`;
  }
  return JSON.stringify(valor) ?? 'undefined';
}

function normalizarClave(clave: string): string {
  return clave.toLowerCase().replace(/[_-]/gu, '');
}

/** Ruta absoluta y existente de una carpeta; devuelve su ruta canónica. */
function validarRaizEscritura(raiz: unknown): string {
  if (typeof raiz !== 'string' || !path.isAbsolute(raiz)) {
    throw new Error(`La raíz de escritura debe ser una ruta absoluta: ${recortar(String(raiz))}`);
  }
  try {
    if (!statSync(raiz).isDirectory()) throw new Error('no es una carpeta');
    return realpathSync(raiz);
  } catch {
    throw new Error(`La raíz de escritura no existe o no es una carpeta: ${recortar(raiz)}`);
  }
}

function dentroDe(raiz: string, ruta: string): boolean {
  const relativa = path.relative(raiz, ruta);
  return relativa === '' || (!relativa.startsWith('..') && !path.isAbsolute(relativa));
}

/**
 * Comprueba una ruta pedida por el agente: devuelve el motivo del rechazo o null si es aceptable. Sin seguir enlaces:
 * cada componente existente entre la raíz y la ruta se mira con `lstat`; uno que sea un enlace simbólico la rechaza.
 * Una ruta que aún no existe vale si su ancestro existente más cercano está dentro y no es un enlace.
 */
export function motivoRutaRechazada(escritura: { raiz: string; raizPedida?: string }, pedida: string, escribe = false): string | null {
  if (pedida.length === 0 || pedida.includes('\0')) return 'ruta vacía o inválida';
  // `~`, variables y URIs los expandiría la herramienta del agente, no el sistema de archivos: no se aceptan.
  if (pedida.startsWith('~') || pedida.includes('$') || pedida.includes('%')) return `ruta con expansión de ~ o de variables: ${recortar(pedida)}`;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(pedida)) {
    const unidad = process.platform === 'win32' && /^[A-Za-z]:[\\/]/u.test(pedida);
    if (!unidad) return `ruta con esquema o unidad no admitida: ${recortar(pedida)}`;
  }
  if (process.platform === 'win32' && pedida.slice(2).includes(':')) return `ruta con «:» no admitido: ${recortar(pedida)}`;
  if (pedida.split(/[\\/]+/u).includes('..')) return `la ruta contiene «..»: ${recortar(pedida)}`;
  let absoluta = path.isAbsolute(pedida) ? path.normalize(pedida) : path.join(escritura.raiz, pedida);
  const alias = escritura.raizPedida;
  if (alias !== undefined && alias !== escritura.raiz && dentroDe(alias, absoluta)) {
    absoluta = path.join(escritura.raiz, path.relative(alias, absoluta));
  }
  if (!dentroDe(escritura.raiz, absoluta)) return `la ruta queda fuera de la raíz del encargo: ${recortar(pedida)}`;
  const partes = path.relative(escritura.raiz, absoluta).split(path.sep).filter(Boolean);
  if (escribe) {
    if (partes.length === 0) return `la ruta es la raíz del encargo: ${recortar(pedida)}`;
    const glob = partes.find((parte) => /[*?[]/u.test(parte));
    if (glob !== undefined) return `componente con metacaracteres de glob «${glob}»: ${recortar(pedida)}`;
    const protegida = partes.find(esComponenteProtegido);
    if (protegida !== undefined) return `escritura en un componente protegido «${protegida}»: ${recortar(pedida)}`;
  }
  let actual = escritura.raiz;
  for (const parte of partes) {
    actual = path.join(actual, parte);
    let datos;
    try {
      datos = lstatSync(actual);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      return `no se pudo comprobar la ruta: ${recortar(pedida)}`;
    }
    if (datos.isSymbolicLink()) return `la ruta pasa por un enlace simbólico: ${recortar(pedida)}`;
  }
  return null;
}

/** Rutas y órdenes que declara una petición de permiso, con el motivo de rechazo si algo no se reconoce. */
interface PeticionAnalizada {
  rutas: string[];
  orden: string | null;
  cwd: string | null;
  motivo: string | null;
}

/**
 * Lee la petición con una lista cerrada de claves por tipo: una clave desconocida, un valor de ruta que no es texto
 * o una orden que no es un texto de `rawInput.command` rechazan la petición (nunca se usa el título).
 */
function analizarPeticion(tipo: string, llamada: Record<string, unknown>): PeticionAnalizada {
  const resultado: PeticionAnalizada = { rutas: [], orden: null, cwd: null, motivo: null };
  const rechazo = (motivo: string): PeticionAnalizada => ({ ...resultado, motivo });
  if (Array.isArray(llamada['locations'])) {
    for (const l of llamada['locations']) {
      if (!esObjeto(l) || typeof l['path'] !== 'string') return rechazo('ubicación sin ruta de texto');
      resultado.rutas.push(l['path']);
    }
  }
  if (Array.isArray(llamada['content'])) {
    for (const c of llamada['content']) {
      if (esObjeto(c) && c['type'] === 'diff') {
        if (typeof c['path'] !== 'string') return rechazo('diff sin ruta de texto');
        resultado.rutas.push(c['path']);
      }
    }
  }
  const crudo = llamada['rawInput'];
  if (crudo === undefined || crudo === null) return resultado;
  if (!esObjeto(crudo)) return rechazo('rawInput no es un objeto');
  const admitidas = CLAVES_ADMITIDAS[tipo] ?? new Set<string>();
  for (const [clave, valor] of Object.entries(crudo)) {
    const normal = normalizarClave(clave);
    if (!admitidas.has(normal)) return rechazo(`campo no reconocido: ${recortar(clave)}`);
    if (tipo === 'execute') {
      if (normal === 'bypasssandbox') {
        // Salir del sandbox nunca se aprueba: solo vale `false` explícito.
        if (valor !== false) return rechazo('la orden pide ejecutarse fuera del sandbox (BypassSandbox)');
      } else if (normal === 'waitmsbeforeasync') {
        if (typeof valor !== 'number' || !Number.isFinite(valor)) return rechazo(`el campo ${clave} no es un número`);
      } else if (typeof valor !== 'string') {
        return rechazo(`el campo ${clave} no es un texto`);
      } else if (normal === 'command' || normal === 'commandline') {
        if (resultado.orden !== null) return rechazo('la petición trae más de una orden');
        resultado.orden = valor.trim();
      } else if (normal === 'cwd') {
        resultado.cwd = valor;
      } else if (!CLAVES_ORDEN_INFORMATIVAS.has(normal)) {
        return rechazo(`campo no reconocido: ${recortar(clave)}`);
      }
    } else if (CLAVES_RUTA.has(normal)) {
      if (typeof valor !== 'string') return rechazo(`el campo ${clave} no es un texto`);
      resultado.rutas.push(valor);
    }
  }
  return resultado;
}

/**
 * Motivo por el que el modo escritura rechaza una petición de permiso, o null si se puede aprobar. Función pura
 * (`ordenesActivas` solo se cambia en pruebas).
 */
export function motivoPermisoRechazado(
  escritura: { raiz: string; raizPedida?: string; ordenes: ReadonlySet<string> },
  llamada: Record<string, unknown>,
  ordenesActivas: boolean = ORDENES_ACTIVAS,
): string | null {
  const tipo = texto(llamada['kind']);
  if (tipo === null || !TIPOS_APROBABLES.has(tipo)) return `tipo de petición no admitido: ${tipo ?? 'desconocido'}`;
  if (tipo === 'execute' && !ordenesActivas) return MOTIVO_ORDENES_DESACTIVADAS;
  // agy repite la entrada de la orden en `args`: si dice otra cosa que `rawInput`, no se sabe cuál se ejecuta.
  if (tipo === 'execute' && llamada['args'] !== undefined && canonico(llamada['args']) !== canonico(llamada['rawInput'])) {
    return 'la orden trae args distintos de rawInput';
  }
  const peticion = analizarPeticion(tipo, llamada);
  if (peticion.motivo !== null) return peticion.motivo;
  const escribe = TIPOS_ESCRITURA.has(tipo);
  for (const ruta of peticion.rutas) {
    const motivo = motivoRutaRechazada(escritura, ruta, escribe);
    if (motivo !== null) return motivo;
  }
  if (tipo === 'execute') {
    const orden = peticion.orden;
    if (orden === null || orden === '') return 'orden no reconocible';
    if (ENCADENADO.test(orden)) return `orden encadenada o con redirección: ${recortar(orden)}`;
    if (!escritura.ordenes.has(orden)) return `orden no permitida: ${recortar(orden)}`;
    if (peticion.cwd !== null) {
      let canonica: string | null = null;
      try {
        canonica = path.isAbsolute(peticion.cwd) ? realpathSync(peticion.cwd) : null;
      } catch {
        canonica = null;
      }
      if (canonica !== escritura.raiz) return `el directorio de la orden no es la raíz del encargo: ${recortar(peticion.cwd)}`;
    }
    return null;
  }
  if (peticion.rutas.length === 0) return 'la petición no declara ninguna ruta';
  return null;
}

class ErrorNoInstalado extends Error {
  constructor() {
    super(NO_INSTALADO);
    this.name = 'ErrorNoInstalado';
  }
}

/** No se pudo garantizar que la sesión no tenga una vía para escribir sin pedir permiso. */
class ErrorAislamiento extends Error {
  constructor(mensaje: string) {
    super(mensaje);
    this.name = 'ErrorAislamiento';
  }
}

class ErrorProceso extends Error {
  constructor(mensaje: string) {
    super(mensaje);
    this.name = 'ErrorProceso';
  }
}

interface Invocacion {
  orden: string;
  argsPrefijo: string[];
}

async function resolverInvocacion(opciones: OpcionesConectorAntigravity): Promise<Invocacion> {
  if (opciones.orden !== undefined) return { orden: opciones.orden, argsPrefijo: opciones.argsPrefijo ?? [] };
  try {
    const { executable, argsPrefix } = await resolveCliInvocation({ name: 'agy' });
    return { orden: executable, argsPrefijo: argsPrefix };
  } catch {
    throw new ErrorNoInstalado();
  }
}

function esObjeto(valor: unknown): valor is Record<string, unknown> {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor);
}

function texto(valor: unknown): string | null {
  return typeof valor === 'string' ? valor : null;
}

function recortar(valor: string): string {
  return valor.length > MAX_DETALLE ? `${valor.slice(0, MAX_DETALLE)}…` : valor;
}

function mensajeDe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pausa(ms: number): Promise<void> {
  return new Promise((resolver) => setTimeout(resolver, ms).unref());
}

function existe(ruta: string): boolean {
  return lstatSync(ruta, { throwIfNoEntry: false }) !== undefined;
}

/** Una carpeta de verdad (no un enlace simbólico ni un archivo). */
function esCarpetaReal(ruta: string): boolean {
  return lstatSync(ruta, { throwIfNoEntry: false })?.isDirectory() === true;
}

/**
 * Personalizaciones del repo que la fábrica no admite, desde `raiz` hasta la raíz del repo (la carpeta con `.git`),
 * ambas incluidas. Lista blanca: en `.agents/` (y variantes) solo `skills`, `rules` y `workflows`, como carpetas
 * reales; cualquier otra entrada, un enlace simbólico o una carpeta `.gemini/` cuentan.
 */
export function personalizacionesPeligrosas(raiz: string): string[] {
  const halladas: string[] = [];
  let carpeta = path.resolve(raiz);
  for (;;) {
    const gemini = path.join(carpeta, CONFIG_GEMINI);
    if (existe(gemini)) halladas.push(gemini);
    for (const base of RAICES_PERSONALIZACION) {
      const raizPersonal = path.join(carpeta, base);
      if (!existe(raizPersonal)) continue;
      if (!esCarpetaReal(raizPersonal)) {
        halladas.push(raizPersonal);
        continue;
      }
      let entradas: string[];
      try {
        entradas = readdirSync(raizPersonal);
      } catch {
        halladas.push(raizPersonal);
        continue;
      }
      for (const nombre of entradas.sort()) {
        const ruta = path.join(raizPersonal, nombre);
        if (!PERSONALIZACIONES_ADMITIDAS.has(nombre) || !esCarpetaReal(ruta)) halladas.push(ruta);
      }
    }
    if (existe(path.join(carpeta, '.git'))) break;
    const padre = path.dirname(carpeta);
    if (padre === carpeta) break;
    carpeta = padre;
  }
  return halladas;
}

function analizarInforme(crudo: string): InformeEstacion | null {
  const recortado = crudo.trim();
  const sinVallas = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/u.exec(recortado)?.[1] ?? recortado;
  let datos: unknown;
  try {
    datos = JSON.parse(sinVallas);
  } catch {
    return null;
  }
  const informe = InformeEstacion.safeParse(datos);
  return informe.success ? informe.data : null;
}

function conEsquema(texto: string): ContentBlock {
  return { type: 'text', text: `${texto}\n\n${INSTRUCCION_ESQUEMA}:\n${JSON.stringify(hallazgosJsonSchema())}` };
}

async function leerImagenes(rutas: string[]): Promise<ContentBlock[]> {
  return Promise.all(rutas.map(async (ruta): Promise<ContentBlock> => {
    const mimeType = TIPOS_IMAGEN[path.extname(ruta).toLowerCase()];
    if (mimeType === undefined) throw new Error(`formato de imagen no admitido: ${ruta}`);
    return { type: 'image', mimeType, data: (await readFile(ruta)).toString('base64') };
  }));
}

/** Modo con que abrió la sesión, según `modes` y la opción `mode`; null si no lo dice o se contradicen. */
function modoDeSesion(sesion: Record<string, unknown>): string | null {
  const modo = esObjeto(sesion['modes']) ? texto(sesion['modes']['currentModeId']) : null;
  // `configOptions` que existe pero no es una lista: no se entiende, no se da por buena.
  if (sesion['configOptions'] !== undefined && sesion['configOptions'] !== null && !Array.isArray(sesion['configOptions'])) return null;
  const opciones = Array.isArray(sesion['configOptions']) ? sesion['configOptions'] : [];
  const opcion = opciones.find((o: unknown) => esObjeto(o) && o['id'] === 'mode');
  const valor = esObjeto(opcion) ? texto(opcion['currentValue']) : null;
  // Una opción `mode` sin valor no dice en qué modo está: no se da por buena.
  if (opcion !== undefined && valor === null) return null;
  if (modo !== null && valor !== null && modo !== valor) return null;
  return modo ?? valor;
}

/**
 * Modo que anuncia una notificación `session/update` en crudo (antes de que el SDK la valide y pueda descartarla):
 * `undefined` si no habla del modo, o el modo (null si no se entiende) si lo hace.
 */
export function modoAnunciado(update: unknown): string | null | undefined {
  if (!esObjeto(update)) return undefined;
  if (update['sessionUpdate'] === 'current_mode_update') return texto(update['currentModeId']);
  if (update['sessionUpdate'] !== 'config_option_update') return undefined;
  if (!Array.isArray(update['configOptions'])) return null;
  const opcion = update['configOptions'].find((o: unknown) => esObjeto(o) && o['id'] === 'mode');
  if (opcion === undefined) return undefined;
  return esObjeto(opcion) ? texto(opcion['currentValue']) : null;
}

const carpetasAisladas = new Set<string>();
let limpiezaAlSalir = false;

/** Borra una carpeta aislada sin lanzar nunca: un fallo (EBUSY, EPERM, ENOTEMPTY...) solo deja la carpeta. */
export function borrarCarpetaAislada(carpeta: string, borrar: typeof rmSync = rmSync): boolean {
  try {
    borrar(carpeta, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    carpetasAisladas.delete(carpeta);
    return true;
  } catch {
    return false;
  }
}

/** Registra la carpeta para borrarla también si Node sale sin cerrar el conector (Ctrl+C, una caída...). */
function registrarCarpetaAislada(carpeta: string): void {
  carpetasAisladas.add(carpeta);
  if (limpiezaAlSalir) return;
  limpiezaAlSalir = true;
  process.on('exit', () => {
    for (const pendiente of [...carpetasAisladas]) borrarCarpetaAislada(pendiente);
  });
}

function errorModo(modo: string | null): ErrorAislamiento {
  return new ErrorAislamiento(
    `Antigravity usa el modo «${modo ?? 'desconocido'}», que no pide permiso antes de editar; se detuvo la revisión`,
  );
}

interface Fin {
  motivo: string;
  noEncontrado: boolean;
}

interface Proceso {
  conexion: ClientConnection;
  hijo: ChildProcess;
  terminado: Promise<Fin>;
  /** Carpeta de datos aislada de Antigravity (`--gemini-dir`); se borra cuando el proceso termina. */
  carpeta: string;
  salidaError: () => string;
  listo: Promise<void>;
  cierreSesiones: boolean;
  imagenes: boolean;
}

type Desenlace =
  | { tipo: 'fin'; parada: string }
  | { tipo: 'abortado' }
  | { tipo: 'inseguro'; modo: string }
  | { tipo: 'muerto'; motivo: string };

interface EnCurso {
  alProgreso?: AlProgreso;
  resultado: ResultadoEstacion;
  /** Texto del agente en el turno actual. */
  texto: string;
  alertarModo: (modo: string) => void;
  modoInseguro: Promise<Desenlace>;
}

function esperarAborto(señal: AbortSignal): { promesa: Promise<Desenlace>; quitar: () => void } {
  let quitar = () => {};
  const promesa = new Promise<Desenlace>((resolver) => {
    const alAbortar = () => resolver({ tipo: 'abortado' });
    señal.addEventListener('abort', alAbortar, { once: true });
    quitar = () => señal.removeEventListener('abort', alAbortar);
  });
  return { promesa, quitar };
}

class ConectorAntigravity implements Conector {
  readonly ia = 'antigravity' as const;
  private readonly opciones: OpcionesConectorAntigravity;
  private proceso: Proceso | undefined;
  private readonly sesiones = new Map<string, EnCurso>();
  /**
   * Último modo anunciado por sesiones que aún no están registradas (el aviso puede llegar antes de la respuesta de
   * `session/new` o antes de que se reanude su `await`); se comprueba al registrar la sesión.
   */
  private readonly modosSinSesion = new Map<string, string | null>();
  private cerrado = false;
  private readonly escritura: Escritura | undefined;

  constructor(opciones: OpcionesConectorAntigravity, escritura?: Escritura) {
    this.opciones = opciones;
    this.escritura = escritura;
  }

  async catalogo(): Promise<Array<{ modelo: string; esfuerzos: string[] }>> {
    const proceso = await this.asegurarProceso();
    // Una carpeta vacía como espacio de trabajo: el catálogo no carga personalizaciones de ningún repo.
    const vacia = path.join(proceso.carpeta, 'vacia');
    mkdirSync(vacia, { recursive: true, mode: 0o700 });
    const sesion = await this.pedir(proceso, 'session/new', { cwd: vacia, mcpServers: [] } satisfies NewSessionRequest);
    const id = esObjeto(sesion) ? texto(sesion['sessionId']) : null;
    if (id !== null) {
      this.modosSinSesion.delete(id);
      void this.cerrarSesion(proceso, id);
    }
    const modelos = esObjeto(sesion) && esObjeto(sesion['models']) ? sesion['models']['availableModels'] : undefined;
    if (!Array.isArray(modelos)) return [];
    return modelos
      .map((m: unknown) => (esObjeto(m) ? texto(m['modelId']) : null))
      .filter((modelo): modelo is string => modelo !== null && nombreSeguro(modelo))
      .map((modelo) => {
        const esfuerzo = SUFIJO_ESFUERZO.exec(modelo)?.[1];
        return { modelo, esfuerzos: esfuerzo === undefined ? [] : [esfuerzo] };
      });
  }

  async ejecutar(encargo: Encargo, señal: AbortSignal, alProgreso?: AlProgreso): Promise<ResultadoEstacion> {
    const resultado: ResultadoEstacion = { estado: 'fallida', crudo: '', modeloInformado: null, tokens: null, denegaciones: [] };
    if (this.escritura !== undefined) resultado.aprobaciones = [];
    const cancelada = (): ResultadoEstacion => ({ ...resultado, estado: 'cancelada', motivo: CANCELADA });
    if (señal.aborted) return cancelada();
    let sessionId: string | null = null;
    let proceso: Proceso | undefined;
    const aborto = esperarAborto(señal);
    try {
      // Antes de abrir la sesión: los hooks del repo podrían ejecutarse al empezar. Lista blanca, falla cerrado.
      const peligrosas = personalizacionesPeligrosas(encargo.raiz);
      if (peligrosas.length > 0) {
        throw new ErrorAislamiento(
          `El repo tiene personalizaciones de Antigravity que la fábrica no admite (solo skills, rules y workflows en .agents/, sin .gemini/ ni enlaces simbólicos): ${peligrosas.join(', ')}`,
        );
      }
      // Modo escritura: la sesión se abre exactamente en la raíz autorizada; si el encargo apunta a otra, falla cerrado.
      let cwd = encargo.raiz;
      if (this.escritura !== undefined) {
        let canonica: string | null = null;
        try {
          canonica = realpathSync(encargo.raiz);
        } catch {
          canonica = null;
        }
        if (canonica !== this.escritura.raiz) {
          throw new ErrorAislamiento('En modo escritura la raíz del encargo debe ser exactamente la carpeta escribible; se rechaza para no tocar otro repositorio.');
        }
        cwd = this.escritura.raiz;
      }
      const imagenes = await leerImagenes(encargo.imagenes ?? []);
      proceso = await this.asegurarProceso();
      if (imagenes.length > 0 && !proceso.imagenes) throw new Error('el agente no admite imágenes');
      if (señal.aborted) return cancelada();

      const sesion = await this.pedir(proceso, 'session/new', { cwd, mcpServers: [] } satisfies NewSessionRequest);
      const id = esObjeto(sesion) ? texto(sesion['sessionId']) : null;
      if (id === null || !esObjeto(sesion)) throw new Error('Antigravity no devolvió el identificador de la sesión');
      sessionId = id;
      let alertarModo: (modo: string) => void = () => {};
      const modoInseguro = new Promise<Desenlace>((resolver) => {
        alertarModo = (modo) => resolver({ tipo: 'inseguro', modo });
      });
      const enCurso: EnCurso = { resultado, texto: '', alertarModo, modoInseguro, ...(alProgreso !== undefined ? { alProgreso } : {}) };
      this.sesiones.set(id, enCurso);
      const anunciado = this.modosSinSesion.get(id);
      this.modosSinSesion.delete(id);
      if (anunciado !== undefined && anunciado !== MODO_CON_PERMISOS) throw errorModo(anunciado);
      const modo = modoDeSesion(sesion);
      if (modo !== MODO_CON_PERMISOS) throw errorModo(modo);

      try {
        await this.pedir(proceso, 'session/set_model', { sessionId: id, modelId: encargo.modelo });
      } catch (error) {
        if (error instanceof ErrorProceso) throw error;
        throw new Error(`no acepta el modelo «${encargo.modelo}»: ${mensajeDe(error)}`);
      }
      resultado.modeloInformado = encargo.modelo;
      if (señal.aborted) return cancelada();

      let informe: InformeEstacion | null = null;
      // Modo escritura: sin esquema de hallazgos ni reintento; el texto final del agente es el resumen de lo hecho.
      const prompts: ContentBlock[][] = this.escritura === undefined
        ? [[conEsquema(encargo.instrucciones), ...imagenes], [conEsquema(CORRECCION)]]
        : [[{ type: 'text', text: encargo.instrucciones }, ...imagenes]];
      for (const prompt of prompts) {
        const desenlace = await this.turno(proceso, id, enCurso, prompt, aborto.promesa);
        resultado.crudo = enCurso.texto;
        if (desenlace.tipo === 'abortado') return cancelada();
        if (desenlace.tipo === 'inseguro') throw errorModo(desenlace.modo);
        if (desenlace.tipo === 'muerto') {
          return { ...resultado, motivo: `El proceso de Antigravity terminó antes de acabar la revisión: ${desenlace.motivo}` };
        }
        if (desenlace.parada === 'cancelled' && señal.aborted) return cancelada();
        if (desenlace.parada !== 'end_turn') return { ...resultado, motivo: `Antigravity no completó la revisión: ${desenlace.parada}` };
        informe = this.escritura === undefined ? analizarInforme(enCurso.texto) : { hallazgos: [], resumen: enCurso.texto.trim() };
        if (informe !== null) break;
      }
      if (informe === null) return { ...resultado, motivo: HALLAZGOS_INVALIDOS };
      return { ...resultado, estado: 'ok', informe };
    } catch (error) {
      if (error instanceof ErrorNoInstalado) return { ...resultado, motivo: NO_INSTALADO };
      if (error instanceof ErrorAislamiento) return { ...resultado, motivo: error.message };
      if (señal.aborted) return cancelada();
      if (error instanceof ErrorProceso) {
        return { ...resultado, motivo: `El proceso de Antigravity terminó antes de acabar la revisión: ${error.message}` };
      }
      return { ...resultado, motivo: `Antigravity falló: ${mensajeDe(error)}` };
    } finally {
      aborto.quitar();
      if (sessionId !== null) {
        this.sesiones.delete(sessionId);
        if (proceso) void this.cerrarSesion(proceso, sessionId);
      }
    }
  }

  async cerrar(): Promise<void> {
    this.cerrado = true;
    const proceso = this.proceso;
    this.proceso = undefined;
    if (!proceso) return;
    proceso.conexion.close();
    proceso.hijo.stdin?.end();
    const terminado = proceso.terminado.then(() => true);
    if (!(await Promise.race([terminado, pausa(GRACIA_CIERRE_MS).then(() => false)]))) {
      terminarArbol(proceso.hijo, 'SIGTERM');
      if (!(await Promise.race([terminado, pausa(GRACIA_CIERRE_MS).then(() => false)]))) terminarArbol(proceso.hijo, 'SIGKILL');
    }
    await proceso.terminado;
  }

  /** Un turno (`session/prompt`); si se aborta o el agente sale del modo con permisos, envía `session/cancel`. */
  private async turno(proceso: Proceso, sessionId: string, enCurso: EnCurso, prompt: ContentBlock[], abortado: Promise<Desenlace>): Promise<Desenlace> {
    enCurso.texto = '';
    const peticion = proceso.conexion.agent.request('session/prompt', { sessionId, prompt } satisfies PromptRequest);
    peticion.catch(() => undefined);
    const desenlace = await Promise.race([
      peticion.then(
        (r): Desenlace => ({ tipo: 'fin', parada: texto(esObjeto(r) ? r['stopReason'] : null) ?? 'desconocida' }),
        async (error: unknown): Promise<Desenlace> => {
          throw await this.errorDeProceso(proceso, error);
        },
      ),
      abortado,
      enCurso.modoInseguro,
      proceso.terminado.then((fin): Desenlace => ({ tipo: 'muerto', motivo: this.motivoCompleto(proceso, fin) })),
    ]);
    if (desenlace.tipo === 'abortado' || desenlace.tipo === 'inseguro') {
      await proceso.conexion.agent.notify('session/cancel', { sessionId }).catch(() => undefined);
      await Promise.race([peticion.catch(() => undefined), pausa(TIEMPO_CANCELACION_MS)]);
    }
    return desenlace;
  }

  /** Petición al agente con tiempo máximo; si el proceso muere antes, lanza `ErrorProceso`. */
  private async pedir(proceso: Proceso, metodo: string, params: unknown, timeoutMs = TIEMPO_PETICION_MS): Promise<unknown> {
    const peticion = proceso.conexion.agent.request<unknown, unknown>(metodo, params, {
      cancellationSignal: AbortSignal.timeout(timeoutMs),
      stopWaitingOnCancel: true,
    });
    peticion.catch(() => undefined);
    const muerto = proceso.terminado.then((fin): never => {
      throw new ErrorProceso(this.motivoCompleto(proceso, fin));
    });
    muerto.catch(() => undefined);
    try {
      return await Promise.race([peticion, muerto]);
    } catch (error) {
      if (error instanceof RequestError && error.code === -32800) {
        throw new Error(`la petición «${metodo}» superó el tiempo de espera de ${timeoutMs} ms`);
      }
      throw await this.errorDeProceso(proceso, error);
    }
  }

  /**
   * Un error que no viene del agente (la conexión se cerró) suele llegar justo antes de que el proceso termine:
   * se espera un poco para informar del fin del proceso en vez del cierre de la conexión.
   */
  private async errorDeProceso(proceso: Proceso, error: unknown): Promise<unknown> {
    if (error instanceof RequestError || error instanceof ErrorProceso) return error;
    const fin = await Promise.race([proceso.terminado, pausa(GRACIA_CIERRE_MS).then(() => null)]);
    return fin === null ? error : new ErrorProceso(this.motivoCompleto(proceso, fin));
  }

  private async cerrarSesion(proceso: Proceso, sessionId: string): Promise<void> {
    if (!proceso.cierreSesiones) return;
    await this.pedir(proceso, 'session/close', { sessionId }, TIEMPO_CIERRE_SESION_MS).catch(() => undefined);
  }

  private motivoCompleto(proceso: Proceso, fin: Fin): string {
    const cola = proceso.salidaError().trim();
    return cola ? `${fin.motivo}. Salida de error: ${cola}` : fin.motivo;
  }

  /** Un proceso `agy acp` por conector, con `initialize` una sola vez; si muere, el siguiente uso lo relanza. */
  private async asegurarProceso(): Promise<Proceso> {
    if (this.cerrado) throw new Error('El conector de Antigravity está cerrado');
    if (!this.proceso) {
      const invocacion = await resolverInvocacion(this.opciones);
      if (this.cerrado) throw new Error('El conector de Antigravity está cerrado');
      if (!this.proceso) {
        const proceso = this.lanzar(invocacion);
        this.proceso = proceso;
        const olvidar = () => {
          if (this.proceso === proceso) this.proceso = undefined;
        };
        void proceso.terminado.then(olvidar);
        proceso.listo.catch(olvidar);
      }
    }
    const proceso = this.proceso;
    if (!proceso) throw new Error('El proceso de Antigravity terminó al arrancar');
    await proceso.listo;
    return proceso;
  }

  private lanzar(invocacion: Invocacion): Proceso {
    // `mkdtemp` crea la carpeta con permisos 0o700.
    const carpeta = mkdtempSync(path.join(tmpdir(), 'nexakit-agy-'));
    registrarCarpetaAislada(carpeta);
    const hijo = spawn(invocacion.orden, [...invocacion.argsPrefijo, ...ARGUMENTOS_ACP, '--gemini-dir', carpeta], {
      // Nunca el directorio de trabajo de quien llama: Antigravity cargaría sus personalizaciones.
      cwd: carpeta,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
      // En su propio grupo (fuera de Windows): al cerrar se termina también a sus descendientes.
      detached: LANZAR_EN_GRUPO,
    });
    hijo.on('exit', () => barrerGrupo(hijo));
    let salidaError = Buffer.alloc(0);
    hijo.stderr?.on('data', (trozo: Buffer) => {
      const total = Buffer.concat([salidaError, trozo]);
      salidaError = total.length > MAX_SALIDA_ERROR ? total.subarray(total.length - MAX_SALIDA_ERROR) : total;
    });
    hijo.stdin?.on('error', () => {
      // El cierre del proceso (EPIPE incluido) se informa por 'close'.
    });
    const terminado = new Promise<Fin>((resolver) => {
      hijo.on('error', (error: NodeJS.ErrnoException) => {
        resolver({ motivo: `no se pudo lanzar el proceso: ${error.message}`, noEncontrado: error.code === 'ENOENT' });
      });
      hijo.on('close', (codigo: number | null, senal: NodeJS.Signals | null) => {
        const como = codigo !== null ? `con código de salida ${codigo}` : `por la señal ${senal ?? 'desconocida'}`;
        resolver({ motivo: `el proceso terminó ${como}`, noEncontrado: false });
      });
    });
    void terminado.then(() => borrarCarpetaAislada(carpeta));

    if (!hijo.stdin || !hijo.stdout) throw new Error('no se pudo abrir la entrada y la salida del proceso');
    const crudo = ndJsonStream(
      Writable.toWeb(hijo.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(hijo.stdout) as ReadableStream<Uint8Array>,
    );
    // El modo se vigila en crudo: el SDK descarta (sin avisar al manejador) las notificaciones que no valida.
    const vigilarModo = new TransformStream<AnyMessage, AnyMessage>({
      transform: (mensaje, controlador) => {
        this.vigilarModo(mensaje);
        controlador.enqueue(mensaje);
      },
    });
    const flujo = { writable: crudo.writable, readable: crudo.readable.pipeThrough(vigilarModo) };
    const app = client({ name: 'nexakit-fabrica' })
      // Sin validar la forma: una petición de permiso inesperada también se rechaza (y queda registrada).
      .onRequest('session/request_permission', (params: unknown) => params, ({ params }) => this.rechazarPermiso(params))
      .onRequest('*', ({ method, params }) => this.denegarPeticion(method, params))
      .onNotification('session/update', ({ params }) => this.alActualizar(params));
    const conexion = app.connect(flujo);
    void terminado.then(() => conexion.close());

    const proceso: Proceso = {
      conexion,
      hijo,
      terminado,
      carpeta,
      salidaError: () => salidaError.toString('utf8'),
      listo: Promise.resolve(),
      cierreSesiones: false,
      imagenes: false,
    };
    proceso.listo = this.inicializar(proceso);
    return proceso;
  }

  private async inicializar(proceso: Proceso): Promise<void> {
    const params: InitializeRequest = {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: CAPACIDADES_CLIENTE,
      clientInfo: { name: 'nexakit-fabrica', title: 'Fábrica de revisión de nexakit', version: '1' },
    };
    let respuesta: unknown;
    try {
      respuesta = await this.pedir(proceso, 'initialize', params);
    } catch (error) {
      await this.forzarFin(proceso);
      const fin = await Promise.race([proceso.terminado, pausa(0).then(() => null)]);
      if (fin?.noEncontrado) throw new ErrorNoInstalado();
      throw error;
    }
    const capacidades = esObjeto(respuesta) && esObjeto(respuesta['agentCapabilities']) ? respuesta['agentCapabilities'] : {};
    const sesiones = esObjeto(capacidades['sessionCapabilities']) ? capacidades['sessionCapabilities'] : {};
    const prompt = esObjeto(capacidades['promptCapabilities']) ? capacidades['promptCapabilities'] : {};
    proceso.cierreSesiones = esObjeto(sesiones['close']);
    proceso.imagenes = prompt['image'] === true;
  }

  private async forzarFin(proceso: Proceso): Promise<void> {
    proceso.conexion.close();
    terminarArbol(proceso.hijo, 'SIGTERM');
    await Promise.race([proceso.terminado, pausa(GRACIA_CIERRE_MS)]);
  }

  private alActualizar(params: SessionNotification): void {
    const enCurso = this.sesiones.get(params.sessionId);
    if (!enCurso) return;
    const actualizacion = params.update;
    switch (actualizacion.sessionUpdate) {
      case 'agent_message_chunk':
        if (actualizacion.content.type === 'text') enCurso.texto += actualizacion.content.text;
        break;
      case 'usage_update':
        enCurso.resultado.tokens = { entrada: 0, salida: 0, total: actualizacion.used };
        try {
          enCurso.alProgreso?.({ tokens: actualizacion.used });
        } catch {
          // Quien escucha el avance nunca debe romper la revisión.
        }
        break;
      default:
        break;
    }
  }

  /** Falla cerrado si una sesión en curso anuncia un modo que no es `default` o uno que no se entiende. */
  private vigilarModo(mensaje: AnyMessage): void {
    if (!('method' in mensaje) || mensaje.method !== 'session/update' || 'id' in mensaje) return;
    const params: unknown = mensaje.params;
    if (!esObjeto(params)) return;
    const sessionId = texto(params['sessionId']);
    if (sessionId === null) return;
    const modo = modoAnunciado(params['update']);
    if (modo === undefined) return;
    const enCurso = this.sesiones.get(sessionId);
    if (!enCurso) {
      // Se guarda el último y el peor: un aviso inseguro no lo borra uno `default` posterior.
      const previo = this.modosSinSesion.get(sessionId);
      if (previo === undefined || previo === MODO_CON_PERMISOS) this.modosSinSesion.set(sessionId, modo);
      if (this.modosSinSesion.size > MAX_MODOS_SIN_SESION) this.modosSinSesion.delete(this.modosSinSesion.keys().next().value as string);
      return;
    }
    if (modo !== MODO_CON_PERMISOS) enCurso.alertarModo(modo ?? 'desconocido');
  }

  /**
   * Petición de permiso. Sin modo escritura se rechaza siempre: la opción de rechazo si la hay; si no, `cancelled`.
   * Con él, se aprueba (opción «permitir una vez») solo lo que `motivoDenegacion` no objeta; lo demás se anota.
   */
  private rechazarPermiso(params: unknown): RequestPermissionResponse {
    const p = esObjeto(params) ? params : {};
    const sessionId = texto(p['sessionId']);
    const enCurso = sessionId === null ? undefined : this.sesiones.get(sessionId);
    const llamada = esObjeto(p['toolCall']) ? p['toolCall'] : {};
    const detalle = texto(llamada['title']) ?? texto(llamada['kind']) ?? 'sin detalle';
    const opciones = Array.isArray(p['options']) ? p['options'].filter(esObjeto) : [];
    let motivo: string | null = null;
    if (this.escritura !== undefined) {
      motivo = enCurso === undefined ? 'sesión desconocida' : motivoPermisoRechazado(this.escritura, llamada);
      if (motivo === null) {
        const permitir = opciones.find((o) => o['kind'] === 'allow_once' && typeof o['optionId'] === 'string');
        if (permitir) {
          enCurso?.resultado.aprobaciones?.push({ tipo: 'session/request_permission', detalle: recortar(`Permiso aprobado: ${detalle}`) });
          return { outcome: { outcome: 'selected', optionId: permitir['optionId'] as string } };
        }
        motivo = 'no hay opción de permitir una vez';
      }
    }
    enCurso?.resultado.denegaciones.push({
      tipo: 'session/request_permission',
      detalle: recortar(`Permiso denegado: ${detalle}${motivo === null ? '' : ` (${motivo})`}`),
    });
    for (const tipo of ['reject_once', 'reject_always']) {
      const opcion = opciones.find((o) => o['kind'] === tipo && typeof o['optionId'] === 'string');
      if (opcion) return { outcome: { outcome: 'selected', optionId: opcion['optionId'] as string } };
    }
    return { outcome: { outcome: 'cancelled' } };
  }

  /** Cualquier otra petición del agente (escribir archivos, terminales, preguntas...) se contesta con error. */
  private denegarPeticion(metodo: string, params: unknown): never {
    const sessionId = esObjeto(params) ? texto(params['sessionId']) : null;
    const enCurso = sessionId === null ? undefined : this.sesiones.get(sessionId);
    enCurso?.resultado.denegaciones.push({ tipo: metodo, detalle: recortar(`Petición denegada: ${metodo}`) });
    throw new RequestError(-32601, `La fábrica de revisión no atiende «${metodo}»`);
  }
}

export async function crearConectorAntigravity(opciones: OpcionesConectorAntigravity = {}): Promise<Conector> {
  let escritura: Escritura | undefined;
  if (opciones.escritura !== undefined) {
    escritura = {
      raiz: validarRaizEscritura(opciones.escritura.raiz),
      raizPedida: path.normalize(opciones.escritura.raiz),
      ordenes: new Set(opciones.escritura.ordenesPermitidas.map((o) => o.trim()).filter((o) => o !== '' && !ENCADENADO.test(o))),
    };
  }
  return new ConectorAntigravity(opciones, escritura);
}
