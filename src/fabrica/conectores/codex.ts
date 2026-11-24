// Conector de la fábrica con Codex por `codex app-server` (JSON-RPC por stdio).
// Frontera de seguridad: por defecto el revisor trabaja en un hilo de solo lectura (`approvalPolicy: untrusted`), toda
// petición de escritura se deniega y una orden solo se aprueba si coincide EXACTAMENTE con una de `ordenesPermitidas`.
// El modo escritura es opcional y explícito (`escritura: { raiz, tmp? }`): `workspace-write` acotado a esa raíz (que
// debe ser también el cwd) y a su carpeta temporal, sin red y con un CODEX_HOME aislado sin reglas de execpolicy. Ahí
// `approvalPolicy` es `never`: Codex no pide aprobación, así que `ordenesPermitidas` NO se aplica (es una guía que se
// comunica a la IA) y la frontera real es el sandbox. En macOS el modo escritura acota también la LECTURA: en vez de
// `workspace-write` (que deja leer todo el disco), el hilo corre con el perfil de permisos `nexakit-encargo` del
// CODEX_HOME aislado (`default_permissions`): disco legible salvo la carpeta personal, vetada entrada a entrada excepto el
// camino hasta la copia y su carpeta temporal (escritura), el `node_modules` real enlazado y el gitdir común del repo
// (lectura), la instalación de node y de Codex y el CODEX_HOME aislado; las órdenes corren con HOME = la carpeta temporal.
// Se comprueba que Codex activó el perfil (falla cerrado). Comprobado con codex-cli 0.171.0 (`codex sandbox -P`,
// `command/exec` y un encargo real). Riesgo residual: fuera de la carpeta personal todo es legible (TMPDIR de la persona,
// /tmp, /Volumes); lo creado en ella después de arrancar no queda vetado; en Linux y Windows sigue `workspace-write`, que
// deja leer todo el disco. Quien encarga revisa el diff y el resumen antes de aplicarlo.
import { execFile } from 'node:child_process';
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync, type Dirent } from 'node:fs';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { resolveCliInvocation } from '../../../src/cli-executable.js';
import { hallazgosJsonSchema, InformeEstacion } from '../esquemas.js';
import { ClienteJsonRpc, ErrorProceso } from '../jsonrpc.js';
import { nombreSeguro, type AlProgreso, type Conector, type Denegacion, type Encargo, type ResultadoEstacion } from './tipos.js';
import type { ApplyPatchApprovalResponse } from '../protocolos/codex/ApplyPatchApprovalResponse.js';
import type { ExecCommandApprovalParams } from '../protocolos/codex/ExecCommandApprovalParams.js';
import type { ExecCommandApprovalResponse } from '../protocolos/codex/ExecCommandApprovalResponse.js';
import type { InitializeParams } from '../protocolos/codex/InitializeParams.js';
import type { JsonValue } from '../protocolos/codex/serde_json/JsonValue.js';
import type { ConfigReadParams } from '../protocolos/codex/v2/ConfigReadParams.js';
import type { ListMcpServerStatusParams } from '../protocolos/codex/v2/ListMcpServerStatusParams.js';
import type { CommandExecutionRequestApprovalParams } from '../protocolos/codex/v2/CommandExecutionRequestApprovalParams.js';
import type { CommandExecutionRequestApprovalResponse } from '../protocolos/codex/v2/CommandExecutionRequestApprovalResponse.js';
import type { FileChangeRequestApprovalResponse } from '../protocolos/codex/v2/FileChangeRequestApprovalResponse.js';
import type { McpServerElicitationRequestResponse } from '../protocolos/codex/v2/McpServerElicitationRequestResponse.js';
import type { ModelListParams } from '../protocolos/codex/v2/ModelListParams.js';
import type { ModelListResponse } from '../protocolos/codex/v2/ModelListResponse.js';
import type { PermissionsRequestApprovalResponse } from '../protocolos/codex/v2/PermissionsRequestApprovalResponse.js';
import type { ThreadStartParams } from '../protocolos/codex/v2/ThreadStartParams.js';
import type { ThreadTokenUsageUpdatedNotification } from '../protocolos/codex/v2/ThreadTokenUsageUpdatedNotification.js';
import type { ToolRequestUserInputResponse } from '../protocolos/codex/v2/ToolRequestUserInputResponse.js';
import type { TurnInterruptParams } from '../protocolos/codex/v2/TurnInterruptParams.js';
import type { TurnStartParams } from '../protocolos/codex/v2/TurnStartParams.js';
import type { UserInput } from '../protocolos/codex/v2/UserInput.js';

const NO_INSTALADO = 'Codex no está instalado';
/** En modo escritura el turno no pide hallazgos: pide solo un resumen breve de lo hecho. */
const ESQUEMA_RESUMEN: JsonValue = {
  type: 'object',
  properties: { resumen: { type: 'string' } },
  required: ['resumen'],
  additionalProperties: false,
};
const HALLAZGOS_INVALIDOS = 'El revisor no devolvió hallazgos válidos';
const CANCELADA = 'La revisión se canceló';
const RECHAZO = 'La fábrica de revisión no permite escrituras ni órdenes que la estación no declare.';
const TIEMPO_PETICION_MS = 60_000;
const TIEMPO_INTERRUPCION_MS = 10_000;
const TIEMPO_VERSION_MS = 10_000;
const MAX_PAGINAS_MODELOS = 20;
const MAX_DETALLE = 500;
/** `src/fabrica/protocolos/codex/VERSION`; la ruta vale igual desde `src/fabrica/conectores` y desde `dist/fabrica/conectores`. */
const RUTA_VERSION_TIPOS = new URL('../../../src/fabrica/protocolos/codex/VERSION', import.meta.url);
const MAX_PAGINAS_MCP = 20;
const SHELLS = new Set(['bash', 'zsh', 'sh']);
/** Carpetas del sistema desde las que se reconoce un shell dado por ruta absoluta (fuera de Windows). */
const CARPETAS_SHELL = new Set(['/bin', '/usr/bin']);
/** Palabra sin comillas, espacios ni metacaracteres de shell. */
const PALABRA_SIMPLE = /^[A-Za-z0-9_@%+=:,./-]+$/;
/** Lo que convierte un guion en más de una orden, o redirige: se deniega siempre. */
const METACARACTERES_GUION = /[\n\r;&|`<>]|\$\(/u;
/** Caracteres de control (salvo el tabulador): una orden que los contenga no se interpreta. */
const CONTROL = /[\u0000-\u0008\u000a-\u001f\u007f]/u;
/**
 * Funciones de Codex que dan herramientas fuera del sandbox (apps, plugins con MCP, uso del ordenador o del navegador,
 * subagentes, imágenes). Se desactivan en cada hilo de revisión. Comprobado con codex-cli 0.167.2.
 */
const FUNCIONES_DESACTIVADAS = [
  'apps',
  'plugins',
  'computer_use',
  'browser_use',
  'browser_use_external',
  'in_app_browser',
  'multi_agent',
  'image_generation',
];

export interface OpcionesConectorCodex {
  /** Ejecutable que se lanza; por defecto se resuelve `codex` (sin shell, también `codex.cmd` en Windows). */
  orden?: string;
  /** Argumentos previos a `app-server` o `--version` (solo con `orden`). */
  argsPrefijo?: string[];
  /**
   * Modo escritura, explícito y acotado: el hilo y el turno usan `workspace-write` con esa carpeta escribible (y `tmp`,
   * si se da, que además se exporta como TMPDIR, TMP y TEMP), sin red y sin aprobaciones. Sin esta opción el conector
   * es de solo lectura, como siempre.
   */
  escritura?: { raiz: string; tmp?: string };
  /** Solo para pruebas: plataforma con la que se decide si se acota la lectura (por defecto, la del proceso). */
  plataforma?: NodeJS.Platform;
  /** Carpeta personal cuya lectura se veta en el modo escritura (por defecto, `os.homedir()`). */
  home?: string;
}

export interface VersionTiposCodex {
  /** Versión con la que se generaron los tipos vendorizados. */
  tipos: string;
  /** Salida de `codex --version`, o null si no se pudo obtener. */
  instalada: string | null;
  aviso: string | null;
}

class ErrorNoInstalado extends Error {
  constructor() {
    super(NO_INSTALADO);
    this.name = 'ErrorNoInstalado';
  }
}

/** No se pudo garantizar que el hilo no tenga herramientas MCP que corren fuera del sandbox. */
class ErrorAislamiento extends Error {
  constructor(mensaje: string) {
    super(mensaje);
    this.name = 'ErrorAislamiento';
  }
}

interface Invocacion {
  orden: string;
  argsPrefijo: string[];
}

async function resolverInvocacion(opciones: OpcionesConectorCodex): Promise<Invocacion> {
  if (opciones.orden !== undefined) return { orden: opciones.orden, argsPrefijo: opciones.argsPrefijo ?? [] };
  try {
    const { executable, argsPrefix } = await resolveCliInvocation({ name: 'codex' });
    return { orden: executable, argsPrefijo: argsPrefix };
  } catch {
    throw new ErrorNoInstalado();
  }
}

/**
 * CODEX_HOME desechable para el modo escritura. Las reglas `allow` de `~/.codex/rules` dejan correr órdenes fuera
 * del sandbox y `codex app-server` no tiene opción para ignorarlas, así que el servidor arranca con un home propio
 * (0o700) que solo enlaza `auth.json` del real y trae una configuración mínima, sin `rules/`.
 */
export async function crearHomeAislado(
  entorno: NodeJS.ProcessEnv = process.env,
  base: string = os.tmpdir(),
  configuracion: (ruta: string) => string = () => '',
): Promise<{ ruta: string; borrar: () => Promise<void> }> {
  const ruta = await mkdtemp(path.join(base, 'nexakit-codex-home-'));
  const borrar = () => rm(ruta, { recursive: true, force: true });
  try {
    const real = entorno['CODEX_HOME'] ?? path.join(os.homedir(), '.codex');
    try {
      await symlink(path.join(real, 'auth.json'), path.join(ruta, 'auth.json'));
    } catch {
      // Sin autenticación enlazada Codex fallará al iniciar sesión, nunca al revés.
    }
    await writeFile(path.join(ruta, 'config.toml'), `# Configuración mínima de un encargo de nexakit.\n${configuracion(ruta)}`, { mode: 0o600 });
  } catch (error) {
    await borrar();
    throw error;
  }
  return { ruta, borrar };
}

/** Perfil de permisos (`[permissions.<id>]` de la config de Codex) con el que corre el modo escritura en macOS. */
export const PERFIL_ENCARGO = 'nexakit-encargo';
/** Tope de entradas vetadas: más allá, el encargo no arranca (falla cerrado). */
const MAX_VETOS = 20_000;
/** Codex no veta una ruta con caracteres de patrón (`a[b]`, `x*`): ni literal ni como patrón (comprobado con 0.171.0). */
const CARACTERES_PATRON = /[*?[\]{}\\]/u;

export interface EntradaDisco {
  /** Ruta absoluta y canónica, o `:root` (todo el disco). */
  ruta: string;
  acceso: 'read' | 'write' | 'none';
}

/** `ruta` es `carpeta` o está dentro de ella (rutas absolutas y canónicas). */
function contiene(carpeta: string, ruta: string): boolean {
  const relativa = path.relative(carpeta, ruta);
  return relativa === '' || (relativa !== '..' && !relativa.startsWith(`..${path.sep}`) && !path.isAbsolute(relativa));
}

/**
 * Rutas que hay que vetar para que no se pueda leer nada de `carpeta` salvo `permitidas`. Codex veta con
 * `deny file-read*`, que incluye los metadatos: vetar la carpeta entera rompería `realpath` de cualquier ruta interior
 * (node no arranca). Por eso se vetan, una a una, las entradas hermanas del camino hasta cada ruta permitida: las
 * carpetas de ese camino se pueden listar, pero nada de lo que cuelga de ellas fuera del camino. Los enlaces no se
 * siguen (se vetan como entrada). Lanza si una entrada no se puede vetar (nombre con caracteres de patrón) o si hay
 * demasiadas: el encargo no arranca.
 */
export function vetosDeLectura(carpeta: string, permitidas: readonly string[]): string[] {
  const vetos: string[] = [];
  const vetar = (ruta: string): void => {
    if (CARACTERES_PATRON.test(path.basename(ruta))) {
      throw new Error(`No se puede vetar la lectura de ${recortar(ruta)}: Codex no acepta nombres con * ? [ ] { } o \\; renómbrala para encargar con Codex`);
    }
    vetos.push(ruta);
    if (vetos.length > MAX_VETOS) throw new Error(`Hay más de ${MAX_VETOS} rutas que vetar a Codex en ${recortar(carpeta)}`);
  };
  const recorrer = (dir: string): void => {
    if (permitidas.some((p) => contiene(p, dir))) return;
    const interiores = permitidas.filter((p) => contiene(dir, p));
    if (interiores.length === 0) {
      vetar(dir);
      return;
    }
    let entradas: Dirent[];
    try {
      entradas = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      throw new Error(`No se pudo listar ${recortar(dir)} para vetar su lectura a Codex: ${mensajeDe(error)}`);
    }
    for (const entrada of entradas) {
      const ruta = path.join(dir, entrada.name);
      if (entrada.isDirectory() && interiores.some((p) => contiene(ruta, p))) recorrer(ruta);
      else if (!permitidas.some((p) => contiene(p, ruta))) vetar(ruta);
    }
  };
  recorrer(carpeta);
  return vetos;
}

/**
 * Entradas del perfil del modo escritura: todo el disco legible salvo la carpeta personal, que se veta entera excepto
 * el camino hasta las raíces escribibles (escritura) y lo imprescindible para trabajar (solo lectura).
 */
export function perfilDeEncargo(opciones: { home: string; escribibles: string[]; legibles: string[] }): EntradaDisco[] {
  const home = canonica(opciones.home);
  const escribibles = [...new Set(opciones.escribibles.map(canonica))];
  // Una lectura que abarque la carpeta personal (un ejecutable en `/bin` da el prefijo `/`) anularía el veto: se ignora.
  const candidatas = [...new Set(opciones.legibles.map(canonica))].filter((r) => !contiene(r, home));
  const legibles = candidatas.filter((r) =>
    !escribibles.some((e) => contiene(e, r)) && !candidatas.some((otra) => otra !== r && contiene(otra, r)));
  return [
    { ruta: ':root', acceso: 'read' },
    ...vetosDeLectura(home, [...escribibles, ...legibles]).map((ruta): EntradaDisco => ({ ruta, acceso: 'none' })),
    ...legibles.map((ruta): EntradaDisco => ({ ruta, acceso: 'read' })),
    ...escribibles.map((ruta): EntradaDisco => ({ ruta, acceso: 'write' })),
  ];
}

/** Cadena básica de TOML: JSON ya escapa comillas, barras y controles salvo DEL. */
function cadenaToml(valor: string): string {
  return JSON.stringify(valor).replace(/\u007f/gu, '\\u007F');
}

/**
 * Config del CODEX_HOME aislado con el perfil del encargo como permisos por defecto, sin red. `homeOrdenes` es el HOME
 * de las órdenes que lance Codex: el real está vetado y git o npm fallarían al leer su configuración.
 */
export function configDePerfil(entradas: readonly EntradaDisco[], homeOrdenes?: string): string {
  return [
    `default_permissions = ${cadenaToml(PERFIL_ENCARGO)}`,
    '',
    `[permissions.${PERFIL_ENCARGO}.filesystem]`,
    ...entradas.map((e) => `${cadenaToml(e.ruta)} = ${cadenaToml(e.acceso)}`),
    '',
    `[permissions.${PERFIL_ENCARGO}.network]`,
    'enabled = false',
    ...(homeOrdenes === undefined ? [] : ['', '[shell_environment_policy.set]', `HOME = ${cadenaToml(homeOrdenes)}`]),
    '',
  ].join('\n');
}

/** Carpeta de instalación de un ejecutable (`<prefijo>/bin/x` da `<prefijo>`), siguiendo enlaces; null si no existe. */
function prefijoDe(ejecutable: string): string | null {
  if (!path.isAbsolute(ejecutable)) return null;
  try {
    return path.dirname(path.dirname(realpathSync(ejecutable)));
  } catch {
    return null;
  }
}

/**
 * Lo que el worktree necesita leer fuera de sí: el `node_modules` real al que apunta su enlace y el gitdir común del
 * repo (sin él, `git status` falla). Se lee antes de que Codex toque la copia.
 */
function lecturasDelWorktree(raiz: string): string[] {
  const lecturas: string[] = [];
  const nodeModules = path.join(raiz, 'node_modules');
  try {
    if (lstatSync(nodeModules).isSymbolicLink()) lecturas.push(realpathSync(nodeModules));
  } catch {
    // Sin node_modules enlazado no hay nada que leer.
  }
  try {
    const punteroGit = path.join(raiz, '.git');
    if (lstatSync(punteroGit).isFile()) {
      const gitdir = /^gitdir: (.+)$/mu.exec(readFileSync(punteroGit, 'utf8'))?.[1]?.trim();
      if (gitdir !== undefined) {
        const propio = realpathSync(path.resolve(raiz, gitdir));
        let comun = propio;
        try {
          comun = realpathSync(path.resolve(propio, readFileSync(path.join(propio, 'commondir'), 'utf8').trim()));
        } catch {
          // Sin `commondir` el gitdir es el común.
        }
        lecturas.push(propio, comun);
      }
    }
  } catch {
    // Sin `.git` de worktree, git no tiene nada fuera que leer.
  }
  return lecturas;
}

function esObjeto(valor: unknown): valor is Record<string, unknown> {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor);
}

function texto(valor: unknown): string | null {
  return typeof valor === 'string' ? valor : null;
}

/** Resumen de un turno de escritura: el campo `resumen` si la respuesta es el JSON pedido, y si no, el texto tal cual. */
function resumenDeEscritura(crudo: string): string {
  try {
    const datos: unknown = JSON.parse(crudo);
    if (esObjeto(datos) && typeof datos['resumen'] === 'string') return datos['resumen'];
  } catch {
    // No es JSON: se usa el texto.
  }
  return crudo.trim();
}

function recortar(valor: string): string {
  return valor.length > MAX_DETALLE ? `${valor.slice(0, MAX_DETALLE)}…` : valor;
}

function mensajeDe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Parte una orden como lo haría un shell POSIX, solo con comillas simples, dobles y barra invertida.
 * Devuelve null si no es segura de interpretar: caracteres de control (saltos de línea incluidos), comillas sin
 * cerrar o expansiones dentro de comillas dobles.
 */
function partirOrden(orden: string): string[] | null {
  if (CONTROL.test(orden)) return null;
  const palabras: string[] = [];
  let actual = '';
  let enPalabra = false;
  for (let i = 0; i < orden.length; i++) {
    const c = orden[i] as string;
    if (c === "'") {
      const fin = orden.indexOf("'", i + 1);
      if (fin === -1) return null;
      actual += orden.slice(i + 1, fin);
      enPalabra = true;
      i = fin;
    } else if (c === '"') {
      let j = i + 1;
      for (; j < orden.length && orden[j] !== '"'; j++) {
        const d = orden[j] as string;
        if (d === '$' || d === '`') return null;
        if (d === '\\') {
          const siguiente = orden[j + 1];
          if (siguiente === undefined) return null;
          actual += '"\\$`'.includes(siguiente) ? siguiente : `\\${siguiente}`;
          j++;
        } else {
          actual += d;
        }
      }
      if (j >= orden.length) return null;
      enPalabra = true;
      i = j;
    } else if (c === '\\') {
      const siguiente = orden[i + 1];
      if (siguiente === undefined) return null;
      actual += siguiente;
      enPalabra = true;
      i++;
    } else if (c === ' ' || c === '\t') {
      if (enPalabra) palabras.push(actual);
      actual = '';
      enPalabra = false;
    } else {
      actual += c;
      enPalabra = true;
    }
  }
  if (enPalabra) palabras.push(actual);
  return palabras;
}

/**
 * Un shell se reconoce por su nombre sin carpeta (`bash`) o por su ruta absoluta en una carpeta del sistema
 * (`/bin/zsh`, `/usr/bin/bash`; en Windows, `<SystemRoot>\System32\bash.exe`). `./tools/bash` no cuenta.
 */
export function esShellDelSistema(
  programa: string,
  plataforma: NodeJS.Platform = process.platform,
  raizSistema: string | undefined = process.env['SystemRoot'],
): boolean {
  if (!programa.includes('/') && !programa.includes('\\')) return SHELLS.has(programa);
  if (plataforma === 'win32') {
    if (!raizSistema || !path.win32.isAbsolute(raizSistema)) return false;
    const system32 = path.win32.join(raizSistema, 'System32').toLowerCase();
    const nombre = path.win32.basename(programa).toLowerCase();
    return path.win32.dirname(programa).toLowerCase() === system32 && nombre.endsWith('.exe') && SHELLS.has(nombre.slice(0, -4));
  }
  return CARPETAS_SHELL.has(path.posix.dirname(programa)) && SHELLS.has(path.posix.basename(programa));
}

/**
 * Orden que se compara con `ordenesPermitidas`: el guion de `<shell del sistema> -c|-lc '<guion>'` (sin saltos de
 * línea, `;`, `&`, `|`, `` ` ``, `$(` ni redirecciones, y solo sin espacios en los extremos), o las palabras simples
 * unidas por un espacio. Cualquier otra forma da null.
 */
function ordenComparable(argv: string[]): string | null {
  const [programa, opcion, guion] = argv;
  if (argv.length === 3 && programa !== undefined && guion !== undefined && esShellDelSistema(programa) &&
      (opcion === '-c' || opcion === '-lc')) {
    return METACARACTERES_GUION.test(guion) ? null : guion.trim();
  }
  if (argv.length === 0 || !argv.every((palabra) => PALABRA_SIMPLE.test(palabra))) return null;
  return argv.join(' ');
}

/** La comparación es exacta (solo se quitan los espacios de los extremos): `npm test && rm -rf x` no es `npm test`. */
export function ordenPermitida(argv: string[] | null, permitidas: readonly string[]): boolean {
  if (argv === null) return false;
  const comparable = ordenComparable(argv);
  if (comparable === null || comparable === '') return false;
  return permitidas.some((permitida) => permitida.trim() === comparable);
}

function canonica(ruta: string): string {
  try {
    return realpathSync(ruta);
  } catch {
    return path.resolve(ruta);
  }
}

function dentroDeRaiz(cwd: string | null, raiz: string): boolean {
  if (cwd === null) return true;
  const relativa = path.relative(canonica(raiz), canonica(path.resolve(raiz, cwd)));
  return relativa === '' || (!relativa.startsWith('..') && !path.isAbsolute(relativa));
}

interface FinTurno {
  estado: string;
  error: string | null;
}

interface EnCurso {
  encargo: Encargo;
  resultado: ResultadoEstacion;
  terminarTurno: (fin: FinTurno) => void;
  alProgreso?: AlProgreso;
}

interface Proceso {
  cliente: ClienteJsonRpc;
  listo: Promise<void>;
}

type Desenlace = { tipo: 'turno'; fin: FinTurno } | { tipo: 'abortado' } | { tipo: 'muerto'; motivo: string };

function esperarAborto(señal: AbortSignal): { promesa: Promise<Desenlace>; quitar: () => void } {
  let quitar = () => {};
  const promesa = new Promise<Desenlace>((resolver) => {
    const alAbortar = () => resolver({ tipo: 'abortado' });
    señal.addEventListener('abort', alAbortar, { once: true });
    quitar = () => señal.removeEventListener('abort', alAbortar);
  });
  return { promesa, quitar };
}

class ConectorCodex implements Conector {
  readonly ia = 'codex' as const;
  private readonly opciones: OpcionesConectorCodex;
  private proceso: Proceso | undefined;
  private homeAislado: { ruta: string; borrar: () => Promise<void> } | undefined;
  private borrado: Promise<void> = Promise.resolve();
  private readonly hilos = new Map<string, EnCurso>();
  private cerrado = false;
  /** Ruta absoluta y canónica de la carpeta escribible del encargo; undefined si el conector es de solo lectura. */
  private readonly raizEscritura: string | undefined;
  /** Carpeta temporal propia del encargo (canónica), también escribible; undefined si no hay. */
  private readonly tmpEscritura: string | undefined;
  /**
   * Modo escritura con lectura acotada (solo macOS, donde está comprobado): el hilo corre con el perfil
   * `PERFIL_ENCARGO` del CODEX_HOME aislado en vez de `workspace-write`, que deja leer todo el disco.
   */
  private readonly lecturaAcotada: boolean;

  constructor(opciones: OpcionesConectorCodex, raizEscritura?: string, tmpEscritura?: string) {
    this.opciones = opciones;
    this.raizEscritura = raizEscritura;
    this.tmpEscritura = tmpEscritura;
    this.lecturaAcotada = raizEscritura !== undefined && (opciones.plataforma ?? process.platform) === 'darwin';
  }

  /** Config del CODEX_HOME aislado: el perfil de lectura acotada si toca; si no, ninguna. */
  private configDeHome(invocacion: Invocacion, codexHome: string): string {
    if (!this.lecturaAcotada || this.raizEscritura === undefined) return '';
    const legibles = [
      ...lecturasDelWorktree(this.raizEscritura),
      // El node con el que corre nexakit, el ejecutable de Codex (su ayudante de disco se relanza dentro del sandbox) y
      // el CODEX_HOME aislado (atajos de `apply_patch`).
      ...[process.execPath, invocacion.orden, invocacion.argsPrefijo[0] ?? '']
        .map(prefijoDe)
        .filter((r): r is string => r !== null),
      codexHome,
    ];
    const entradas = perfilDeEncargo({
      home: this.opciones.home ?? os.homedir(),
      escribibles: this.raicesEscribibles(this.raizEscritura),
      legibles,
    });
    return configDePerfil(entradas, this.tmpEscritura);
  }

  /** Raíces escribibles del modo escritura: la del encargo y, si hay, su carpeta temporal. */
  private raicesEscribibles(raiz: string): string[] {
    return this.tmpEscritura === undefined ? [raiz] : [raiz, this.tmpEscritura];
  }

  async catalogo(): Promise<Array<{ modelo: string; esfuerzos: string[] }>> {
    const cliente = await this.asegurarCliente();
    const modelos: Array<{ modelo: string; esfuerzos: string[] }> = [];
    let cursor: string | null = null;
    for (let pagina = 0; pagina < MAX_PAGINAS_MODELOS; pagina++) {
      const params: ModelListParams = cursor === null ? {} : { cursor };
      const respuesta: unknown = await cliente.solicitar<ModelListResponse>('model/list', params, { timeoutMs: TIEMPO_PETICION_MS });
      if (!esObjeto(respuesta)) break;
      const datos = Array.isArray(respuesta['data']) ? respuesta['data'] : [];
      for (const modelo of datos) {
        // Un nombre de modelo raro no pasa aguas abajo: se descarta aquí.
        if (!esObjeto(modelo) || typeof modelo['model'] !== 'string' || !nombreSeguro(modelo['model'])) continue;
        const opciones = Array.isArray(modelo['supportedReasoningEfforts']) ? modelo['supportedReasoningEfforts'] : [];
        const esfuerzos = opciones
          .map((opcion: unknown) => (esObjeto(opcion) ? texto(opcion['reasoningEffort']) : null))
          .filter((esfuerzo): esfuerzo is string => esfuerzo !== null && nombreSeguro(esfuerzo));
        modelos.push({ modelo: modelo['model'], esfuerzos });
      }
      cursor = texto(respuesta['nextCursor']) || null;
      if (cursor === null) break;
    }
    return modelos;
  }

  async ejecutar(encargo: Encargo, señal: AbortSignal, alProgreso?: AlProgreso): Promise<ResultadoEstacion> {
    const resultado: ResultadoEstacion = { estado: 'fallida', crudo: '', modeloInformado: null, tokens: null, denegaciones: [] };
    const cancelada = (): ResultadoEstacion => ({ ...resultado, estado: 'cancelada', motivo: CANCELADA });
    if (señal.aborted) return cancelada();
    let threadId: string | null = null;
    const aborto = esperarAborto(señal);
    try {
      const cliente = await this.asegurarCliente();
      if (señal.aborted) return cancelada();

      if (this.raizEscritura !== undefined && canonica(encargo.raiz) !== this.raizEscritura) {
        return { ...resultado, motivo: 'En modo escritura la raíz del encargo debe ser exactamente la carpeta escribible; se rechaza para no tocar otro repositorio.' };
      }
      const cwd = this.raizEscritura ?? encargo.raiz;
      const paramsHilo: ThreadStartParams = {
        model: encargo.modelo,
        cwd,
        // Con lectura acotada no se da `sandbox`: pisaría el perfil por defecto del CODEX_HOME aislado.
        ...(this.lecturaAcotada ? {} : { sandbox: this.raizEscritura === undefined ? 'read-only' : 'workspace-write' }),
        approvalPolicy: this.raizEscritura === undefined ? 'untrusted' : 'never',
        // Las aprobaciones las contesta este conector, nunca un revisor automático de Codex.
        approvalsReviewer: 'user',
        // Hilo efímero: no ensucia el historial de Codex de la persona.
        ephemeral: true,
        // Sin servidores MCP ni funciones con herramientas que corren fuera del sandbox.
        config: await this.configAislada(cliente, cwd),
      };
      const hilo: unknown = await cliente.solicitar('thread/start', paramsHilo, { timeoutMs: TIEMPO_PETICION_MS });
      const idHilo = esObjeto(hilo) && esObjeto(hilo['thread']) ? texto(hilo['thread']['id']) : null;
      if (idHilo === null) throw new Error('Codex no devolvió el identificador del hilo');
      threadId = idHilo;
      if (this.lecturaAcotada) {
        // Falla cerrado: un Codex que no aplique el perfil dejaría leer todo el disco.
        const activo = esObjeto(hilo) && esObjeto(hilo['activePermissionProfile']) ? texto(hilo['activePermissionProfile']['id']) : null;
        if (activo !== PERFIL_ENCARGO) {
          throw new ErrorAislamiento(`Codex no aplicó el perfil de permisos ${PERFIL_ENCARGO} que acota la lectura (perfil activo: ${activo ?? 'ninguno'}); actualiza Codex`);
        }
      }
      resultado.modeloInformado = esObjeto(hilo) ? texto(hilo['model']) : null;

      let terminarTurno: (fin: FinTurno) => void = () => {};
      const turnoTerminado = new Promise<Desenlace>((resolver) => {
        terminarTurno = (fin) => resolver({ tipo: 'turno', fin });
      });
      // Se registra antes de `turn/start`: sus notificaciones pueden llegar antes que la respuesta.
      this.hilos.set(idHilo, { encargo, resultado, terminarTurno, ...(alProgreso !== undefined ? { alProgreso } : {}) });
      await this.comprobarAislamiento(cliente, idHilo);
      if (señal.aborted) return cancelada();

      const entrada: UserInput[] = [
        { type: 'text', text: encargo.instrucciones, text_elements: [] },
        ...(encargo.imagenes ?? []).map((ruta): UserInput => ({ type: 'localImage', path: ruta })),
      ];
      const paramsTurno: TurnStartParams = {
        threadId: idHilo,
        input: entrada,
        ...(this.raizEscritura !== undefined ? { cwd: this.raizEscritura } : {}),
        model: encargo.modelo,
        ...(encargo.esfuerzo !== null ? { effort: encargo.esfuerzo } : {}),
        outputSchema: (this.raizEscritura === undefined ? hallazgosJsonSchema() : ESQUEMA_RESUMEN) as JsonValue,
        // Con lectura acotada el turno hereda el perfil del hilo: una `sandboxPolicy` lo sustituiría.
        ...(this.lecturaAcotada ? {} : {
          sandboxPolicy: this.raizEscritura === undefined
            ? { type: 'readOnly', networkAccess: false }
            : {
              type: 'workspaceWrite',
              writableRoots: this.raicesEscribibles(this.raizEscritura),
              networkAccess: false,
              // Solo la raíz y la carpeta temporal del encargo: ni el directorio temporal de la persona ni /tmp.
              excludeTmpdirEnvVar: true,
              excludeSlashTmp: true,
            },
        } satisfies Pick<TurnStartParams, 'sandboxPolicy'>),
        approvalPolicy: this.raizEscritura === undefined ? 'untrusted' : 'never',
        approvalsReviewer: 'user',
      };
      const turno: unknown = await cliente.solicitar('turn/start', paramsTurno, { timeoutMs: TIEMPO_PETICION_MS });
      const turnId = esObjeto(turno) && esObjeto(turno['turn']) ? texto(turno['turn']['id']) : null;
      if (turnId === null) throw new Error('Codex no devolvió el identificador del turno');

      const desenlace = await Promise.race([
        turnoTerminado,
        aborto.promesa,
        cliente.terminado.then((fin): Desenlace => ({ tipo: 'muerto', motivo: fin.motivo })),
      ]);
      if (desenlace.tipo === 'abortado') {
        const interrupcion: TurnInterruptParams = { threadId: idHilo, turnId };
        await cliente.solicitar('turn/interrupt', interrupcion, { timeoutMs: TIEMPO_INTERRUPCION_MS }).catch(() => undefined);
        return cancelada();
      }
      if (desenlace.tipo === 'muerto') {
        return { ...resultado, motivo: `El proceso de Codex terminó antes de acabar la revisión: ${desenlace.motivo}` };
      }
      return this.cerrarTurno(resultado, desenlace.fin, señal);
    } catch (error) {
      if (error instanceof ErrorNoInstalado) return { ...resultado, motivo: NO_INSTALADO };
      if (error instanceof ErrorAislamiento) return { ...resultado, motivo: error.message };
      if (señal.aborted) return cancelada();
      if (error instanceof ErrorProceso) {
        return { ...resultado, motivo: `El proceso de Codex terminó antes de acabar la revisión: ${error.message}` };
      }
      return { ...resultado, motivo: `Codex falló: ${mensajeDe(error)}` };
    } finally {
      aborto.quitar();
      if (threadId !== null) this.hilos.delete(threadId);
    }
  }

  async cerrar(): Promise<void> {
    this.cerrado = true;
    const proceso = this.proceso;
    this.proceso = undefined;
    try {
      if (proceso) await proceso.cliente.cerrar();
    } finally {
      await this.borrarHomeAislado();
    }
  }

  /** Los borrados se encadenan: quien llama espera también al que ya estaba en marcha. */
  private borrarHomeAislado(): Promise<void> {
    const home = this.homeAislado;
    this.homeAislado = undefined;
    if (home) this.borrado = this.borrado.then(() => home.borrar().catch(() => undefined));
    return this.borrado;
  }

  /**
   * `config` del hilo: desactiva cada servidor MCP de la configuración efectiva en la raíz (la de la persona y la del
   * proyecto) y las funciones con herramientas fuera del sandbox. `mcp_servers = {}` no sirve: Codex fusiona la
   * tabla en vez de sustituirla; hay que desactivarlos por nombre.
   */
  private async configAislada(cliente: ClienteJsonRpc, raiz: string): Promise<{ [clave: string]: JsonValue }> {
    const params: ConfigReadParams = { cwd: raiz };
    const leida: unknown = await cliente.solicitar('config/read', params, { timeoutMs: TIEMPO_PETICION_MS });
    const config = esObjeto(leida) ? leida['config'] : undefined;
    const servidores = esObjeto(config) && esObjeto(config['mcp_servers']) ? Object.keys(config['mcp_servers']) : [];
    return {
      mcp_servers: Object.fromEntries(servidores.map((nombre) => [nombre, { enabled: false }])),
      features: Object.fromEntries(FUNCIONES_DESACTIVADAS.map((funcion) => [funcion, false])),
      ...(this.raizEscritura === undefined || this.lecturaAcotada ? {} : {
        // Defensa en profundidad: la configuración de la persona no ensancha la política hasta el primer turno.
        sandbox_workspace_write: {
          writable_roots: this.raicesEscribibles(this.raizEscritura),
          network_access: false,
          exclude_tmpdir_env_var: true,
          exclude_slash_tmp: true,
        },
      }),
    };
  }

  /** Falla cerrado: si el hilo conserva algún servidor MCP activo o con herramientas, no se empieza el turno. */
  private async comprobarAislamiento(cliente: ClienteJsonRpc, threadId: string): Promise<void> {
    const activos: string[] = [];
    let cursor: string | null = null;
    for (let pagina = 0; ; pagina++) {
      if (pagina >= MAX_PAGINAS_MCP) throw new ErrorAislamiento('No se pudo comprobar que los servidores MCP de Codex estén desactivados');
      const params: ListMcpServerStatusParams = { threadId, detail: 'toolsAndAuthOnly', ...(cursor === null ? {} : { cursor }) };
      let respuesta: unknown;
      try {
        respuesta = await cliente.solicitar('mcpServerStatus/list', params, { timeoutMs: TIEMPO_PETICION_MS });
      } catch (error) {
        if (error instanceof ErrorProceso) throw error;
        throw new ErrorAislamiento(`No se pudo comprobar que los servidores MCP de Codex estén desactivados: ${mensajeDe(error)}`);
      }
      if (!esObjeto(respuesta) || !Array.isArray(respuesta['data'])) {
        throw new ErrorAislamiento('No se pudo comprobar que los servidores MCP de Codex estén desactivados');
      }
      for (const servidor of respuesta['data']) {
        const nombre = esObjeto(servidor) ? texto(servidor['name']) ?? 'sin nombre' : 'sin nombre';
        const herramientas = esObjeto(servidor) && esObjeto(servidor['tools']) ? Object.keys(servidor['tools']).length : 0;
        if (!esObjeto(servidor) || servidor['runtimeStatus'] !== 'disabled' || herramientas > 0) activos.push(nombre);
      }
      cursor = texto(respuesta['nextCursor']) || null;
      if (cursor === null) break;
    }
    if (activos.length > 0) {
      throw new ErrorAislamiento(`Codex mantiene activos servidores MCP que podrían escribir: ${activos.join(', ')}`);
    }
  }

  private cerrarTurno(resultado: ResultadoEstacion, fin: FinTurno, señal: AbortSignal): ResultadoEstacion {
    if (fin.estado === 'completed' && this.raizEscritura !== undefined) {
      // En modo escritura lo que importa son los cambios del worktree; la respuesta es solo un resumen.
      return { ...resultado, estado: 'ok', informe: { hallazgos: [], resumen: resumenDeEscritura(resultado.crudo) } };
    }
    if (fin.estado === 'completed') {
      let datos: unknown;
      try {
        datos = JSON.parse(resultado.crudo);
      } catch {
        return { ...resultado, motivo: HALLAZGOS_INVALIDOS };
      }
      const informe = InformeEstacion.safeParse(datos);
      if (!informe.success) return { ...resultado, motivo: HALLAZGOS_INVALIDOS };
      return { ...resultado, estado: 'ok', informe: informe.data };
    }
    if (fin.estado === 'interrupted' && señal.aborted) return { ...resultado, estado: 'cancelada', motivo: CANCELADA };
    const detalle = fin.error ?? 'sin detalle';
    if (fin.estado === 'interrupted') return { ...resultado, motivo: `Codex interrumpió la revisión: ${detalle}` };
    return { ...resultado, motivo: `Codex no completó la revisión: ${detalle}` };
  }

  /** Un proceso `app-server` por conector, con `initialize` una sola vez; si muere, el siguiente uso lo relanza. */
  private async asegurarCliente(): Promise<ClienteJsonRpc> {
    if (this.cerrado) throw new Error('El conector de Codex está cerrado');
    if (!this.proceso) {
      const invocacion = await resolverInvocacion(this.opciones);
      if (this.cerrado) throw new Error('El conector de Codex está cerrado');
      if (!this.proceso) {
        let env: NodeJS.ProcessEnv | undefined;
        if (this.raizEscritura !== undefined) {
          await this.borrarHomeAislado();
          const home = await crearHomeAislado(process.env, os.tmpdir(), (ruta) => this.configDeHome(invocacion, ruta));
          this.homeAislado = home;
          const tmp = this.tmpEscritura;
          env = { ...process.env, CODEX_HOME: home.ruta, ...(tmp === undefined ? {} : { TMPDIR: tmp, TMP: tmp, TEMP: tmp }) };
          if (this.cerrado) {
            await this.borrarHomeAislado();
            throw new Error('El conector de Codex está cerrado');
          }
        }
        const cliente = ClienteJsonRpc.lanzar(invocacion.orden, [...invocacion.argsPrefijo, 'app-server'], {
          cwd: process.cwd(),
          ...(env !== undefined ? { env } : {}),
        });
        cliente.alNotificar((metodo, params) => this.alNotificar(metodo, params));
        cliente.alSolicitar((metodo, params) => Promise.resolve(this.alSolicitar(metodo, params)));
        const proceso: Proceso = { cliente, listo: this.inicializar(cliente) };
        this.proceso = proceso;
        const olvidar = () => {
          if (this.proceso === proceso) this.proceso = undefined;
        };
        void cliente.terminado.then(() => {
          olvidar();
          if (this.proceso === undefined) void this.borrarHomeAislado();
        });
        proceso.listo.catch(olvidar);
      }
    }
    const proceso = this.proceso;
    if (!proceso) throw new Error('El proceso de Codex terminó al arrancar');
    await proceso.listo;
    return proceso.cliente;
  }

  private async inicializar(cliente: ClienteJsonRpc): Promise<void> {
    const params: InitializeParams = {
      clientInfo: { name: 'nexakit-fabrica', title: 'Fábrica de revisión de nexakit', version: '1' },
      capabilities: null,
    };
    try {
      await cliente.solicitar('initialize', params, { timeoutMs: TIEMPO_PETICION_MS });
    } catch (error) {
      await cliente.cerrar();
      if (error instanceof ErrorProceso && error.codigo === null && /ENOENT/u.test(error.message)) throw new ErrorNoInstalado();
      throw error;
    }
    cliente.notificar('initialized', undefined);
  }

  private enCursoDe(params: Record<string, unknown>): EnCurso | undefined {
    const id = texto(params['threadId']) ?? texto(params['conversationId']);
    return id === null ? undefined : this.hilos.get(id);
  }

  private alNotificar(metodo: string, params: unknown): void {
    if (!esObjeto(params)) return;
    const enCurso = this.enCursoDe(params);
    if (!enCurso) return;
    if (metodo === 'item/completed') {
      const item = params['item'];
      if (!esObjeto(item) || item['type'] !== 'agentMessage' || typeof item['text'] !== 'string') return;
      // Los comentarios intermedios no son la respuesta final.
      if (item['phase'] === 'commentary' || item['phase'] === 'partial_answer') return;
      enCurso.resultado.crudo = item['text'];
    } else if (metodo === 'thread/tokenUsage/updated') {
      const uso = (params as Partial<ThreadTokenUsageUpdatedNotification>).tokenUsage;
      const total: unknown = esObjeto(uso) ? uso.total : undefined;
      if (!esObjeto(total)) return;
      const { inputTokens, outputTokens, totalTokens } = total;
      if (typeof inputTokens !== 'number' || typeof outputTokens !== 'number' || typeof totalTokens !== 'number') return;
      enCurso.resultado.tokens = { entrada: inputTokens, salida: outputTokens, total: totalTokens };
      try {
        enCurso.alProgreso?.({ tokens: totalTokens });
      } catch {
        // Quien escucha el avance nunca debe romper la revisión.
      }
    } else if (metodo === 'turn/completed') {
      const turno = params['turn'];
      if (!esObjeto(turno)) return;
      const error = esObjeto(turno['error']) ? texto(turno['error']['message']) : null;
      enCurso.terminarTurno({ estado: texto(turno['status']) ?? 'desconocido', error });
    }
  }

  /** Contesta las peticiones del servidor. Todo lo que pueda escribir se deniega, siempre. */
  private alSolicitar(metodo: string, params: unknown): unknown {
    const p = esObjeto(params) ? params : {};
    const enCurso = this.enCursoDe(p);
    const denegar = (detalle: string) => {
      const denegacion: Denegacion = { tipo: metodo, detalle: recortar(detalle) };
      enCurso?.resultado.denegaciones.push(denegacion);
    };
    switch (metodo) {
      case 'item/fileChange/requestApproval': {
        denegar(`Cambio de archivos denegado: ${texto(p['reason']) ?? 'sin motivo'}`);
        return { decision: 'decline' } satisfies FileChangeRequestApprovalResponse;
      }
      case 'applyPatchApproval': {
        const archivos = esObjeto(p['fileChanges']) ? Object.keys(p['fileChanges']).join(', ') : '';
        denegar(`Parche denegado: ${archivos || 'sin archivos'}`);
        return { decision: { denied: { rejection: RECHAZO } } } satisfies ApplyPatchApprovalResponse;
      }
      case 'item/permissions/requestApproval': {
        denegar(`Permisos adicionales denegados: ${texto(p['reason']) ?? 'sin motivo'}`);
        return { permissions: {}, scope: 'turn' } satisfies PermissionsRequestApprovalResponse;
      }
      case 'item/commandExecution/requestApproval': {
        const datos = p as Partial<CommandExecutionRequestApprovalParams>;
        const orden = texto(datos.command) ?? '';
        if (this.aprobarOrden(enCurso, (datos.kind ?? 'command') === 'command' && datos.networkApprovalContext == null,
            partirOrden(orden), texto(datos.cwd))) {
          return { decision: 'accept' } satisfies CommandExecutionRequestApprovalResponse;
        }
        denegar(`Orden denegada: ${orden || 'sin orden'}`);
        return { decision: 'decline' } satisfies CommandExecutionRequestApprovalResponse;
      }
      case 'execCommandApproval': {
        // Versión antigua de la aprobación de órdenes: mismas reglas.
        const datos = p as Partial<ExecCommandApprovalParams>;
        const argv = Array.isArray(datos.command) && datos.command.every((a) => typeof a === 'string') ? datos.command : null;
        if (this.aprobarOrden(enCurso, true, argv, texto(datos.cwd))) {
          return { decision: 'approved' } satisfies ExecCommandApprovalResponse;
        }
        denegar(`Orden denegada: ${argv ? JSON.stringify(argv) : 'sin orden'}`);
        return { decision: { denied: { rejection: RECHAZO } } } satisfies ExecCommandApprovalResponse;
      }
      case 'item/tool/requestUserInput': {
        denegar('Pregunta a la persona denegada: la fábrica no espera respuestas');
        return { answers: {} } satisfies ToolRequestUserInputResponse;
      }
      case 'mcpServer/elicitation/request': {
        denegar(`Elicitación MCP denegada: ${texto(p['serverName']) ?? 'servidor desconocido'}`);
        return { action: 'decline', content: null, _meta: null } satisfies McpServerElicitationRequestResponse;
      }
      default:
        throw new Error(`La fábrica no atiende la petición «${metodo}»`);
    }
  }

  private aprobarOrden(enCurso: EnCurso | undefined, tipoAdmitido: boolean, argv: string[] | null, cwd: string | null): boolean {
    if (!enCurso || !tipoAdmitido) return false;
    if (!dentroDeRaiz(cwd, enCurso.encargo.raiz)) return false;
    return ordenPermitida(argv, enCurso.encargo.ordenesPermitidas);
  }
}

/** La raíz del modo escritura (o su carpeta temporal) debe ser una carpeta absoluta y existente; se devuelve su ruta canónica. */
function validarRaizEscritura(raiz: string, que = 'La raíz de escritura'): string {
  if (typeof raiz !== 'string' || !path.isAbsolute(raiz)) {
    throw new Error(`${que} debe ser una ruta absoluta: ${recortar(String(raiz))}`);
  }
  try {
    if (!statSync(raiz).isDirectory()) throw new Error('no es una carpeta');
    return realpathSync(raiz);
  } catch {
    throw new Error(`${que} no existe o no es una carpeta: ${recortar(raiz)}`);
  }
}

export async function crearConectorCodex(opciones: OpcionesConectorCodex = {}): Promise<Conector> {
  const raiz = opciones.escritura === undefined ? undefined : validarRaizEscritura(opciones.escritura.raiz);
  const tmp = opciones.escritura?.tmp === undefined ? undefined : validarRaizEscritura(opciones.escritura.tmp, 'La carpeta temporal del encargo');
  return new ConectorCodex(opciones, raiz, tmp);
}

const ejecutarArchivo = promisify(execFile);

/** Compara la versión de los tipos vendorizados con `codex --version`; si difieren, da un aviso (no bloquea). */
export async function versionTiposCodex(opciones: OpcionesConectorCodex = {}): Promise<VersionTiposCodex> {
  const tipos = (await readFile(RUTA_VERSION_TIPOS, 'utf8')).trim();
  let instalada: string | null = null;
  try {
    const invocacion = await resolverInvocacion(opciones);
    const { stdout } = await ejecutarArchivo(invocacion.orden, [...invocacion.argsPrefijo, '--version'], {
      timeout: TIEMPO_VERSION_MS,
      windowsHide: true,
    });
    instalada = stdout.trim() || null;
  } catch {
    instalada = null;
  }
  const aviso = instalada !== null && instalada !== tipos
    ? `Los tipos de Codex se generaron con ${tipos}; regenera con npm run tipos:codex`
    : null;
  return { tipos, instalada, aviso };
}
