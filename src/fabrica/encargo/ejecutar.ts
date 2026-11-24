import { closeSync, constants, lstatSync, openSync, readFileSync } from 'node:fs';
import { chmod, lstat, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inspectModels, recommendAntigravity } from '../../../src/model-command.js';
import { REGLA_ORDENES_SIMPLES } from '../../../src/regla-ordenes-simples.js';
import { crearConectorAntigravity, esComponenteProtegido, ORDENES_ACTIVAS } from '../conectores/antigravity.js';
import { crearConectorCodex } from '../conectores/codex.js';
import type { AlProgreso, Conector, Denegacion, Encargo, ResultadoEstacion } from '../conectores/tipos.js';
import { comparar, instantanea } from '../disco.js';
import { descarte, type Catalogos } from '../enrutador.js';
import { AGOTADO, bloqueLecciones, conGracia, conTope, GRACIA_MS, INTERVALO_ACTIVO_MS, TOPE_CATALOGO_MS } from '../ejecutor.js';
import { ErrorFabrica } from '../errores.js';
import type { Leccion } from '../lecciones.js';
import { paraEncargo } from '../lecciones.js';
import * as rastro from '../rastro.js';
import { cerrarConectores, limpiar, mensajeDe, opcionesDeEntorno, type Conectores } from '../sesion.js';
import { procesoVivo, tomarCandadoEncargos } from './candado.js';
import { analizarParche, type EntradaParche } from './parche.js';
import { barrerHuerfanos, borrarWorktree, buscarGitAnidado, crearWorktree, diffDelWorktree, raizDelRepoGit, type Worktree } from './worktree.js';

/** Tiempo máximo de un encargo: 20 minutos. */
export const TIEMPO_ENCARGO_MS = 1_200_000;
/** Esfuerzo del nivel Normal, para un modelo indicado a mano en Codex sin esfuerzo. */
const ESFUERZO_NORMAL = 'medium';
const MAX_RESUMEN = 8_000;
const TIEMPO_AGOTADO = 'tiempo agotado';
const CANCELADO = 'cancelado por la persona';
const SIN_RESPUESTA = 'la IA no respondió a la cancelación';

export type IAEncargo = 'codex' | 'antigravity';
export type EstadoEncargo = 'ok' | 'sin-cambios' | 'tiempo-agotado' | 'cancelado' | 'invalido' | 'fallido';

/** Modo escritura con el que se crea el conector: siempre el directorio del worktree como única raíz. */
export interface EscrituraConector {
  raiz: string;
  ordenesPermitidas: string[];
  /**
   * Carpeta temporal propia del encargo (`~/.nexakit/encargos/<id>/tmp`, 0o700, fuera del worktree), que se borra con
   * él. Codex la añade como raíz escribible y la exporta como TMPDIR, TMP y TEMP.
   */
  tmp?: string;
}

/**
 * Crea el conector de una IA en modo escritura. Es una función y no un conector ya hecho porque la raíz de escritura
 * es el worktree, que no existe hasta que arranca el encargo.
 */
export type FabricaConector = (escritura: EscrituraConector) => Promise<Conector>;
export type FabricasConectores = Partial<Record<IAEncargo, FabricaConector>>;

export interface OpcionesEncargo {
  /** Raíz del repo de la persona: de ahí sale el worktree y nunca se escribe en ella. */
  raiz: string;
  ia: IAEncargo | 'auto';
  /** Si falta, el de la recomendación de nivel Normal de la IA elegida. Se valida contra el catálogo vivo. */
  modelo?: string | undefined;
  esfuerzo?: string | undefined;
  /** Texto del encargo: objetivo, archivos, criterio de hecho y pruebas. */
  texto: string;
  /** Órdenes exactas que se añaden a las de pruebas y tipos que detecta el repo. */
  ordenesPermitidas?: string[] | undefined;
  /** Por defecto, 20 minutos. */
  tiempoMs?: number | undefined;
  home?: string | undefined;
  /** Por defecto, los reales según `NEXAKIT_FABRICA_CODEX` y `NEXAKIT_FABRICA_AGY`. */
  conectores?: FabricasConectores | undefined;
  /** Ctrl+C o `fabrica_cancelar`. */
  señal?: AbortSignal | undefined;
  /** Se llama con el id del encargo en cuanto existe su worktree, antes de lanzar la IA (así se puede consultar o cancelar). */
  alCrear?: ((id: string) => void) | undefined;
  /** Variables de entorno para `nexakit modelo` y los conectores; por defecto las del proceso. */
  entorno?: NodeJS.ProcessEnv | undefined;
  /** Sustituye a la recomendación de nivel Normal (`nexakit modelo --nivel normal --ia <ia>`); solo para pruebas. */
  recomendar?: ((ia: IAEncargo) => Promise<{ modelo: string; esfuerzo: string | null } | null>) | undefined;
  /** Espera máxima a que la IA devuelva tras cancelarla, y a cada catálogo vivo. */
  graciaMs?: number | undefined;
  topeCatalogoMs?: number | undefined;
  /** Mínimo entre dos escrituras de `activo.json`. */
  intervaloActivoMs?: number | undefined;
}

/** Lo que se guarda en `informe.json` y se devuelve a quien pidió el encargo. */
export interface InformeEncargo {
  id: string;
  estado: EstadoEncargo;
  ia: IAEncargo | null;
  modelo: string | null;
  esfuerzo: string | null;
  /** Los que informó la IA; `null` si no informó o fueron 0. */
  tokens: { entrada: number; salida: number; total: number } | null;
  /** `false` si la IA no informó de tokens o fueron 0: no cuenta como éxito comprobado. */
  tokensValidos: boolean;
  segundos: number;
  /** Resumen de lo hecho, escrito por la IA. */
  resumen: string;
  denegaciones: Denegacion[];
  aprobaciones: Denegacion[];
  /**
   * Órdenes que el repo declara (`npm test`, `npm run typecheck`). En Codex son una guía que se comunica a la IA (su
   * frontera real es el sandbox: solo escribe en la copia y sin red). Antigravity no ejecuta órdenes (desactivadas: su
   * sandbox deja la copia en solo lectura); las pruebas las ejecuta el orquestador.
   */
  ordenesPorDefecto: string[];
  /** Órdenes extra que pidió quien encargó (con la aprobación de la persona): informativas en Codex, como las anteriores. */
  ordenesExtra: string[];
  /** Rutas del diff, para revisarlo de un vistazo. */
  archivos: string[];
  /** Rutas del repo real que cambiaron mientras corría el encargo (lo invalida). */
  escriturasFuera: string[];
  /** Enlaces simbólicos hacia fuera del repo, repos anidados y cambios en rutas sensibles que trae el diff (lo invalidan). */
  rutasVetadas: string[];
  /** Cambios en instrucciones o configuración de herramientas (CLAUDE.md, .envrc, .npmrc...): no invalidan, pero requieren revisión explícita. */
  alertas: string[];
  avisos: string[];
  motivo?: string;
  /** Commit de HEAD del que partió el encargo. */
  base: string;
  /** `cambios.diff`, listo para `git apply`; `null` si no hay un diff aplicable. */
  rutaDiff: string | null;
  rutaInforme: string;
}

// ---------------------------------------------------------------------------------------------
// Conectores y modelo

/**
 * Los conectores reales, con la misma configuración de entorno que la fábrica, en modo escritura. `home` es la carpeta
 * personal cuya lectura Codex tiene vetada (salvo el camino hasta el encargo) donde sabe acotarla.
 */
function fabricasDeEntorno(entorno: NodeJS.ProcessEnv, home: string): FabricasConectores {
  return {
    codex: (escritura) =>
      crearConectorCodex({
        ...opcionesDeEntorno(entorno, 'NEXAKIT_FABRICA_CODEX'),
        escritura: { raiz: escritura.raiz, ...(escritura.tmp === undefined ? {} : { tmp: escritura.tmp }) },
        home,
      }),
    antigravity: (escritura) =>
      crearConectorAntigravity({
        ...opcionesDeEntorno(entorno, 'NEXAKIT_FABRICA_AGY'),
        escritura: { raiz: escritura.raiz, ordenesPermitidas: escritura.ordenesPermitidas },
      }),
  };
}

/** Lo mismo que `nexakit modelo --nivel normal --ia <ia>`: el modelo y el esfuerzo recomendados para el nivel Normal. */
async function recomendacionNormal(
  ia: IAEncargo,
  home: string,
  entorno: NodeJS.ProcessEnv,
): Promise<{ modelo: string; esfuerzo: string | null } | null> {
  const datos = await inspectModels({ homeDirectory: home, environment: entorno, includeAntigravity: ia === 'antigravity' });
  const fila = datos.levels.find((nivel) => nivel.level.toLowerCase() === 'normal');
  if (fila === undefined) return null;
  const elegido = ia === 'antigravity' ? recommendAntigravity(datos.catalogs.antigravity, fila) : fila.codex;
  return elegido === null ? null : { modelo: elegido.model, esfuerzo: elegido.effort };
}

// ---------------------------------------------------------------------------------------------
// Texto del encargo y órdenes

/** `npm test` y `npm run typecheck` si el repo los declara; el worktree es el commit de HEAD, no los cambios sin commit. */
async function ordenesDelRepo(dir: string): Promise<string[]> {
  try {
    const archivo = path.join(dir, 'package.json');
    if (!(await lstat(archivo)).isFile()) return [];
    const paquete: unknown = JSON.parse(await readFile(archivo, 'utf8'));
    const scripts = typeof paquete === 'object' && paquete !== null ? (paquete as { scripts?: unknown }).scripts : undefined;
    if (typeof scripts !== 'object' || scripts === null) return [];
    const tiene = (nombre: string): boolean => typeof (scripts as Record<string, unknown>)[nombre] === 'string';
    return [...(tiene('test') ? ['npm test'] : []), ...(tiene('typecheck') ? ['npm run typecheck'] : [])];
  } catch {
    return [];
  }
}

/**
 * La regla de órdenes que se le da a la IA. Con Codex las órdenes son una guía: su frontera real es el sandbox (solo
 * escribe en la copia, sin red), no una lista que se haga cumplir. Antigravity escribe solo en la copia y no ejecuta
 * órdenes (desactivadas: su sandbox deja la copia en solo lectura); el texto no promete lo que se va a rechazar. Solo
 * si el conector las reactiva (`ordenesActivas`) la lista se hace cumplir (coincidencia exacta).
 */
export function reglaDeOrdenes(ia: IAEncargo, ordenes: readonly string[], ordenesActivas: boolean = ORDENES_ACTIVAS): string {
  const lista = ordenes.map((o) => `\`${o}\``).join(', ');
  if (ia === 'antigravity' && !ordenesActivas) return '- No se aprueba ninguna orden: no dependas de ejecutar pruebas. Antigravity solo escribe archivos en esta carpeta y no ejecuta órdenes; las pruebas las ejecuta quien te encarga.';
  if (ordenes.length === 0) return '- No se aprueba ninguna orden: no dependas de ejecutar pruebas.';
  if (ia === 'antigravity') {
    return `- Para comprobar tu trabajo solo se aprueban estas órdenes, escritas exactamente así y sin encadenar: ${lista}. Corren en el sandbox de Antigravity, sin red y sin poder escribir fuera de esta carpeta (puede que tampoco dentro). Si una falla por el sandbox, no la repitas fuera de él (BypassSandbox se rechaza): dilo en el resumen.`;
  }
  return `- Para comprobar tu trabajo usa solo estas órdenes: ${lista}. Trabajas en un sandbox sin red que solo puede escribir en esta carpeta y en su carpeta temporal.`;
}

function instruccionesDelEncargo(texto: string, lecciones: readonly Leccion[], reglaOrdenes: string): string {
  const partes = [
    'Programa este encargo en la carpeta de trabajo actual, que es una copia aislada del repositorio: edita los archivos directamente ahí.',
    'No hagas commit ni push, no cambies de rama y no toques nada fuera de esta carpeta. Quien te encarga revisará el diff y lo aplicará.',
    '',
    'Encargo:',
    texto.trim(),
  ];
  const lecc = bloqueLecciones(lecciones);
  if (lecc !== '') partes.push('', lecc);
  partes.push('', 'Reglas de trabajo:', `- ${REGLA_ORDENES_SIMPLES}`);
  partes.push(reglaOrdenes);
  partes.push('', 'Al terminar, responde con un resumen breve en texto (qué cambiaste y qué queda pendiente), sin pegar el diff.');
  return `${partes.join('\n')}\n`;
}

// ---------------------------------------------------------------------------------------------
// Estado vivo (`activo.json`)

/**
 * Publica la estación «encargo» en `~/.nexakit/fabrica/activo.json` (el mismo archivo y formato que la fábrica, así que
 * la barra lo enseña), con como mucho una escritura por intervalo. Al cerrar lo borra solo si sigue siendo suyo.
 */
function crearPublicador(home: string, id: string, repo: string, intervaloMs: number) {
  let contenido: rastro.EstacionActiva | undefined;
  let cerrado = false;
  let ultima = 0;
  let temporizador: NodeJS.Timeout | undefined;
  let cadena: Promise<void> = Promise.resolve();

  const escribir = (): void => {
    ultima = Date.now();
    cadena = cadena
      .then(() =>
        cerrado || contenido === undefined
          ? undefined
          : rastro.guardarActivo(home, { pid: process.pid, id, repo, actualizado: new Date().toISOString(), estaciones: [contenido] }),
      )
      // El estado vivo es de cortesía: un fallo se ignora.
      .catch(() => {});
  };

  return {
    publicar(estacion: rastro.EstacionActiva): void {
      if (cerrado) return;
      contenido = estacion;
      const espera = ultima + intervaloMs - Date.now();
      if (espera <= 0) escribir();
      else if (temporizador === undefined) {
        // Sin `unref` un encargo terminado retendría el proceso.
        temporizador = setTimeout(() => {
          temporizador = undefined;
          escribir();
        }, espera);
        temporizador.unref();
      }
    },
    async cerrar(): Promise<void> {
      cerrado = true;
      clearTimeout(temporizador);
      cadena = cadena
        .then(async () => {
          // `guardarActivo(null)` ya respeta el `pid`; aquí también el id, por si una fábrica corre en el mismo proceso.
          if (rastro.leerActivo(home)?.id === id) await rastro.guardarActivo(home, null);
        })
        .catch(() => {});
      await cadena;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Encargo

/** IA elegida: conector abierto, catálogo vivo, modelo y esfuerzo ya validados. */
interface Eleccion {
  ia: IAEncargo;
  conector: Conector;
  modelo: string;
  esfuerzo: string | null;
}

const datosDe = (valor: unknown): string => limpiar(mensajeDe(valor)).slice(0, 300);

/** Lo que se va sabiendo del encargo; al final se convierte en el informe. */
interface Borrador {
  estado: EstadoEncargo;
  ia: IAEncargo | null;
  modelo: string | null;
  esfuerzo: string | null;
  tokens: InformeEncargo['tokens'];
  resumen: string;
  denegaciones: Denegacion[];
  aprobaciones: Denegacion[];
  ordenesPorDefecto: string[];
  ordenesExtra: string[];
  archivos: string[];
  escriturasFuera: string[];
  rutasVetadas: string[];
  alertas: string[];
  avisos: string[];
  motivo: string | undefined;
  diff: Buffer | undefined;
}

/**
 * Ejecuta un encargo de programación: crea un worktree aislado de HEAD, deja que Codex o Antigravity escriban solo ahí
 * y devuelve el diff (`cambios.diff`) y el informe (`informe.json`) en `~/.nexakit/encargos/<id>/`. El worktree se borra
 * siempre, también con error, tiempo agotado o Ctrl+C. Un fallo esperado (IA no disponible, modelo fuera del catálogo,
 * cancelación...) no lanza: queda en el estado del informe. Solo lanzan los argumentos mal formados y los fallos al
 * crear el worktree o al guardar el informe.
 */
export async function ejecutarEncargo(opciones: OpcionesEncargo): Promise<InformeEncargo> {
  const {
    raiz: raizPedida,
    ia,
    texto,
    tiempoMs = TIEMPO_ENCARGO_MS,
    home = os.homedir(),
    entorno = process.env,
    recomendar = (quien: IAEncargo) => recomendacionNormal(quien, home, entorno),
    graciaMs = GRACIA_MS,
    topeCatalogoMs = TOPE_CATALOGO_MS,
    intervaloActivoMs = INTERVALO_ACTIVO_MS,
    señal,
  } = opciones;
  if (ia !== 'codex' && ia !== 'antigravity' && ia !== 'auto') throw new ErrorFabrica('La IA del encargo debe ser codex, antigravity o auto');
  if (typeof texto !== 'string' || texto.trim() === '') throw new ErrorFabrica('El encargo no tiene texto');
  for (const [valor, nombre] of [
    [tiempoMs, 'El tiempo máximo del encargo'],
    [graciaMs, 'La espera tras cancelar'],
    [topeCatalogoMs, 'La espera al catálogo'],
    [intervaloActivoMs, 'El intervalo del estado vivo'],
  ] as const) {
    if (!Number.isFinite(valor) || valor <= 0) throw new ErrorFabrica(`${nombre} debe ser un número positivo de milisegundos`);
  }
  const extras = opciones.ordenesPermitidas ?? [];
  if (!extras.every((o) => typeof o === 'string' && o.trim() !== '')) throw new ErrorFabrica('Las órdenes permitidas deben ser textos no vacíos');

  const inicio = Date.now();
  const fabricas = opciones.conectores ?? fabricasDeEntorno(entorno, home);
  // La raíz del repo, no una subcarpeta: la instantánea del disco, las lecciones y el rastro hablan del repo entero.
  const raiz = await raizDelRepoGit(raizPedida);
  // Un encargo a la vez en toda la máquina: el candado va antes del barrido y de crear nada, y se libera en el `finally`.
  const candado = await tomarCandadoEncargos(home);
  let avisosBarrido: string[];
  let w: Worktree;
  try {
    // Y un recorrido de la fábrica vivo en otro proceso también lo impide (el propio lo controla el servidor).
    const activo = rastro.leerActivo(home);
    if (activo !== null && activo.pid !== process.pid && procesoVivo(activo.pid)) {
      throw new ErrorFabrica(`Ya hay un recorrido o encargo en curso (${limpiar(activo.id)}, proceso ${activo.pid}); espera a que termine o cancélalo`);
    }
    // Antes de crear el propio: los worktrees de encargos cuyo proceso murió se borran para no acumular carpetas.
    avisosBarrido = await barrerHuerfanos(home);
    w = await crearWorktree(raiz, home);
    await candado.asignarId(w.id).catch(() => {});
  } catch (error) {
    await candado.liberar();
    throw error;
  }
  // Carpeta temporal propia (fuera del worktree y del repo real): sin ella las pruebas que usan os.tmpdir() fallan en
  // el sandbox de Codex. Se borra con el worktree; si no se puede crear, el encargo sigue sin ella.
  const tmp = path.join(path.dirname(w.dir), 'tmp');
  let tmpCreado = false;
  try {
    await mkdir(tmp, { mode: 0o700 });
    await chmod(tmp, 0o700);
    tmpCreado = true;
  } catch {
    // Sin carpeta temporal propia.
  }
  try {
    opciones.alCrear?.(w.id);
  } catch {
    // El oyente es de cortesía: un fallo suyo no tumba el encargo.
  }
  const carpeta = path.dirname(w.dir);
  const rutaInforme = path.join(carpeta, 'informe.json');
  const rutaDiffFinal = path.join(carpeta, 'cambios.diff');
  const b: Borrador = {
    estado: 'fallido',
    ia: null,
    modelo: null,
    esfuerzo: null,
    tokens: null,
    resumen: '',
    denegaciones: [],
    aprobaciones: [],
    ordenesPorDefecto: [],
    ordenesExtra: [...new Set(extras.map((o) => o.trim()))],
    archivos: [],
    escriturasFuera: [],
    rutasVetadas: [],
    alertas: [],
    avisos: [...avisosBarrido, ...w.avisos],
    motivo: undefined,
    diff: undefined,
  };
  const abiertos: Conectores = {};
  const control = new AbortController();
  let agotado = false;
  let canceladoPorPersona = false;
  // Solo cuenta la primera causa: un tiempo que vence durante la espera tras Ctrl+C no cambia el motivo.
  const alCancelar = (): void => {
    if (control.signal.aborted) return;
    canceladoPorPersona = true;
    control.abort(new ErrorFabrica(CANCELADO));
  };
  // Se registra antes de cualquier paso largo; una señal que ya estaba abortada no avisaría al oyente, así que se mira.
  if (señal?.aborted === true) alCancelar();
  else señal?.addEventListener('abort', alCancelar, { once: true });
  let publicador: ReturnType<typeof crearPublicador> | undefined;
  // La limpieza de caducados corre en segundo plano y nunca hace fallar el encargo.
  const poda = rastro.podar(home).then(
    () => undefined,
    () => undefined,
  );

  try {
    await correr();
  } catch (error) {
    b.estado = 'fallido';
    b.motivo = `el encargo falló: ${datosDe(error)}`;
  } finally {
    señal?.removeEventListener('abort', alCancelar);
    await cerrarAbiertos();
    const aviso = await borrarWorktree(w);
    if (aviso !== null) b.avisos.push(aviso);
    await rm(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
    await publicador?.cerrar();
    await poda;
    await candado.liberar();
  }

  let rutaDiff: string | null = null;
  const guardar = async (): Promise<InformeEncargo> => {
    const informe: InformeEncargo = {
      id: w.id,
      estado: b.estado,
      ia: b.ia,
      modelo: b.modelo,
      esfuerzo: b.esfuerzo,
      tokens: b.tokens,
      tokensValidos: b.tokens !== null,
      segundos: Math.round((Date.now() - inicio) / 100) / 10,
      resumen: b.resumen,
      denegaciones: b.denegaciones,
      aprobaciones: b.aprobaciones,
      ordenesPorDefecto: b.ordenesPorDefecto,
      ordenesExtra: b.ordenesExtra,
      archivos: b.archivos,
      escriturasFuera: b.escriturasFuera,
      rutasVetadas: b.rutasVetadas,
      alertas: b.alertas,
      avisos: b.avisos,
      ...(b.motivo === undefined ? {} : { motivo: b.motivo }),
      base: w.base,
      rutaDiff,
      rutaInforme,
    };
    await rastro.escribirReemplazando(rutaInforme, `${JSON.stringify(informe, null, 2)}\n`);
    return informe;
  };
  try {
    if (b.diff !== undefined) {
      await rastro.escribirReemplazando(rutaDiffFinal, b.diff);
      rutaDiff = rutaDiffFinal;
    }
  } catch (error) {
    b.estado = 'fallido';
    b.motivo = `no se pudo guardar cambios.diff: ${datosDe(error)}`;
  }
  try {
    return await guardar();
  } catch (error) {
    throw new ErrorFabrica(`No se pudo guardar el informe del encargo en ${rutaInforme}: ${datosDe(error)}`, { cause: error });
  }

  // -------------------------------------------------------------------------------------------

  /** Una función y no una lectura directa: la señal puede abortarse mientras se espera y TypeScript no lo sabe. */
  function personaCancela(): boolean {
    return canceladoPorPersona || señal?.aborted === true;
  }

  /** Cierra los conectores abiertos una sola vez; llamarla de nuevo no hace nada. */
  async function cerrarAbiertos(): Promise<void> {
    const abiertosAhora = { ...abiertos };
    for (const clave of Object.keys(abiertos)) delete abiertos[clave as keyof Conectores];
    await cerrarConectores(abiertosAhora).catch(() => {});
  }

  async function correr(): Promise<void> {
    if (personaCancela()) {
      b.estado = 'cancelado';
      b.motivo = CANCELADO;
      return;
    }
    const repo = await rastro.nombreRepo(raiz);
    b.ordenesPorDefecto = await ordenesDelRepo(w.dir);
    const ordenes = [...new Set([...b.ordenesPorDefecto, ...b.ordenesExtra])];

    // La IA: la pedida o, con `auto`, Codex si responde y, si no, Antigravity.
    const motivos: string[] = [];
    let elegida: Eleccion | undefined;
    for (const candidata of ia === 'auto' ? (['codex', 'antigravity'] as const) : [ia]) {
      if (personaCancela()) break;
      const resultado = await elegir(candidata, ordenes);
      if ('motivo' in resultado) motivos.push(resultado.motivo);
      else {
        elegida = resultado;
        // El motivo por el que no se usó una IA anterior de `auto` también queda a la vista.
        for (const motivo of motivos) b.avisos.push(`IA descartada: ${motivo}`);
        break;
      }
    }
    if (personaCancela()) {
      b.estado = 'cancelado';
      b.motivo = CANCELADO;
      return;
    }
    if (elegida === undefined) {
      b.motivo = motivos.join('; ');
      return;
    }
    const { ia: iaElegida, conector, modelo, esfuerzo } = elegida;
    b.ia = iaElegida;
    b.modelo = modelo;
    b.esfuerzo = esfuerzo;
    if (iaElegida === 'antigravity' && opciones.esfuerzo !== undefined) {
      b.avisos.push('En antigravity el esfuerzo va dentro del id del modelo: se ignora --esfuerzo.');
    }

    let lecciones: Leccion[] = [];
    try {
      lecciones = await paraEncargo(home, raiz, 'codigo');
    } catch (error) {
      b.avisos.push(`No se pudieron cargar las lecciones del repo; el encargo sale sin ellas: ${datosDe(error)}`);
    }
    const encargo: Encargo = {
      estacion: 'codigo',
      modelo,
      esfuerzo,
      // Siempre el worktree: es también la raíz de escritura del conector, que rechaza cualquier otra.
      raiz: w.dir,
      base: w.base,
      instrucciones: instruccionesDelEncargo(texto, lecciones, reglaDeOrdenes(iaElegida, ordenes, conector.ordenesActivas)),
      ordenesPermitidas: ordenes,
    };

    // La instantánea del repo real se toma justo antes del turno: un worktree nuevo no cambia nada en él.
    const antes = await instantanea(raiz);
    if (personaCancela()) {
      b.estado = 'cancelado';
      b.motivo = CANCELADO;
      return;
    }
    publicador = crearPublicador(home, w.id, repo, intervaloActivoMs);
    let tokens = 0;
    const activa = (estado: rastro.EstacionActiva['estado']): rastro.EstacionActiva => ({
      estacion: 'encargo',
      ia: iaElegida,
      modelo,
      esfuerzo,
      estado,
      tokens,
    });
    publicador.publicar(activa('en-curso'));
    const alProgreso: AlProgreso = ({ tokens: total }) => {
      if (!Number.isFinite(total)) return;
      tokens = total;
      publicador?.publicar(activa('en-curso'));
    };

    const reloj = setTimeout(() => {
      if (control.signal.aborted) return;
      agotado = true;
      control.abort(new ErrorFabrica(TIEMPO_AGOTADO));
    }, tiempoMs);

    let resultado: ResultadoEstacion;
    let sinRespuesta = false;
    try {
      // `then` convierte también una excepción síncrona del conector en un rechazo.
      const llamada = Promise.resolve().then(() => conector.ejecutar(encargo, control.signal, alProgreso));
      const respuesta = await conGracia(llamada, control.signal, graciaMs);
      if (respuesta === AGOTADO) {
        sinRespuesta = true;
        throw new ErrorFabrica(SIN_RESPUESTA);
      }
      resultado = respuesta;
      if (typeof resultado !== 'object' || resultado === null || !['ok', 'fallida', 'cancelada'].includes(resultado.estado)) {
        throw new ErrorFabrica('respuesta no válida');
      }
    } catch (error) {
      resultado = {
        estado: 'fallida',
        crudo: '',
        modeloInformado: null,
        tokens: null,
        denegaciones: [],
        motivo: `el conector falló: ${datosDe(error)}`,
      };
    } finally {
      clearTimeout(reloj);
    }
    // Se publica el desenlace antes de comprobar el disco y de pedir el diff; `cerrar` lo retira enseguida.
    publicador.publicar(activa(resultado.estado === 'ok' ? 'ok' : resultado.estado === 'cancelada' ? 'cancelada' : 'fallida'));

    // Los tokens 0 no se registran: sin cifra real queda `null` y `tokensValidos` en `false`.
    b.tokens = resultado.tokens !== null && resultado.tokens.total > 0 ? resultado.tokens : null;
    b.denegaciones = resultado.denegaciones;
    b.aprobaciones = resultado.aprobaciones ?? [];
    b.resumen = limpiar(resultado.informe?.resumen ?? '').slice(0, MAX_RESUMEN);

    // La causa manda sobre el conector sordo: lo que importa es que se agotó el tiempo o que la persona canceló.
    const nota = sinRespuesta ? `; ${SIN_RESPUESTA}` : '';
    if (agotado) {
      b.estado = 'tiempo-agotado';
      b.motivo = `${TIEMPO_AGOTADO}${nota}`;
    } else if (canceladoPorPersona || resultado.estado === 'cancelada') {
      b.estado = 'cancelado';
      b.motivo = `${CANCELADO}${nota}`;
    } else if (sinRespuesta) {
      b.estado = 'fallido';
      b.motivo = SIN_RESPUESTA;
    } else if (resultado.estado === 'fallida') {
      b.estado = 'fallido';
      b.motivo = limpiar(resultado.motivo ?? 'la IA no completó el encargo');
    } else {
      b.estado = 'ok';
    }

    // Con la IA ya parada (o cerrada a la fuerza), el disco no puede cambiar mientras se comprueba.
    await cerrarAbiertos();
    // Nada debe haber cambiado en el repo real: una escritura fuera del worktree invalida el encargo en cualquier caso.
    try {
      b.escriturasFuera = comparar(antes, await instantanea(raiz));
    } catch (error) {
      const motivo = `no se pudo comprobar el disco tras el encargo: ${datosDe(error)}`;
      if (b.estado === 'ok') {
        b.estado = 'fallido';
        b.motivo = motivo;
      } else b.avisos.push(motivo);
    }
    if (b.escriturasFuera.length > 0) {
      b.estado = 'invalido';
      b.motivo = `el encargo cambió el repo fuera del worktree (no se guarda ningún diff): ${b.escriturasFuera.map(limpiar).join(', ')}`;
      return;
    }
    if (b.estado !== 'ok') return;

    // Antes de cualquier orden git sobre la copia: un repo anidado haría que git aplicara su configuración (filtros
    // `clean` incluidos) fuera de todo sandbox. Con uno, no se ejecuta git sobre la copia y no hay diff.
    let anidado: string | null;
    try {
      anidado = await buscarGitAnidado(w.dir);
    } catch (error) {
      b.estado = 'invalido';
      b.motivo = `no se pudo comprobar la copia antes de leer el diff (no se guarda ningún diff): ${datosDe(error)}`;
      return;
    }
    if (anidado !== null) {
      b.estado = 'invalido';
      b.rutasVetadas = [`${limpiar(anidado)} (repo git anidado)`];
      b.motivo = `repo git anidado en ${limpiar(anidado)}: no se ejecuta git sobre la copia ni se guarda ningún diff`;
      return;
    }

    let diff: Buffer;
    try {
      diff = await diffDelWorktree(w);
    } catch (error) {
      b.estado = 'fallido';
      b.motivo = datosDe(error);
      return;
    }
    if (diff.length === 0) {
      b.estado = 'sin-cambios';
      return;
    }
    // Todo se analiza sobre los mismos bytes que se guardan: el disco ya no cuenta (evita cambios entre diff y análisis).
    const entradas = analizarParche(diff);
    // El resultado se juzga por lo que trae, no por la IA que lo hizo: enlaces hacia fuera y rutas sensibles no se aplican.
    const vetadas = rutasVetadas(entradas);
    if (vetadas.length > 0) {
      b.estado = 'invalido';
      b.rutasVetadas = vetadas;
      b.motivo = `el diff trae cambios que no se aplican solos (no se guarda ningún diff): ${vetadas.join('; ')}`;
      return;
    }
    b.diff = diff;
    b.archivos = [...new Set(entradas.map((c) => c.ruta))];
    b.alertas = rutasConAlerta(entradas);
    if (b.tokens === null) {
      b.avisos.push('La IA no informó de tokens: el encargo no se registra ni cuenta como éxito comprobado.');
    }
  }

  /** Abre el conector de `quien`, comprueba su catálogo vivo y valida el modelo; o dice por qué no se puede usar. */
  async function elegir(quien: IAEncargo, ordenes: string[]): Promise<Eleccion | { motivo: string }> {
    const fabrica = fabricas[quien];
    if (fabrica === undefined) return { motivo: `${quien} no está disponible` };
    let conector: Conector;
    try {
      conector = await fabrica({ raiz: w.dir, ordenesPermitidas: ordenes, ...(tmpCreado ? { tmp } : {}) });
    } catch (error) {
      return { motivo: `${quien} no está disponible: ${datosDe(error)}` };
    }
    abiertos[quien] = conector;
    let catalogo: Awaited<ReturnType<Conector['catalogo']>> | typeof AGOTADO;
    try {
      catalogo = await conTope(Promise.resolve().then(() => conector.catalogo()), topeCatalogoMs);
    } catch (error) {
      return { motivo: `${quien} no está disponible: ${datosDe(error)}` };
    }
    if (catalogo === AGOTADO) return { motivo: `${quien} no está disponible: su catálogo no respondió a tiempo` };
    if (catalogo.length === 0) return { motivo: `${quien} no está disponible: su catálogo no trae ningún modelo` };

    let modelo = opciones.modelo;
    let esfuerzo: string | null = opciones.esfuerzo ?? null;
    if (modelo === undefined) {
      let recomendado: { modelo: string; esfuerzo: string | null } | null;
      try {
        recomendado = await recomendar(quien);
      } catch (error) {
        return { motivo: `no se pudo recomendar un modelo de nivel normal para ${quien}: ${datosDe(error)}` };
      }
      if (recomendado === null) return { motivo: `no hay una recomendación de nivel normal para ${quien}; indica --modelo` };
      modelo = recomendado.modelo;
      esfuerzo ??= recomendado.esfuerzo;
    } else if (quien === 'codex') {
      esfuerzo ??= ESFUERZO_NORMAL;
    }
    // En Antigravity el esfuerzo forma parte del id del modelo.
    if (quien === 'antigravity') esfuerzo = null;
    const vivos: Catalogos = { [quien]: catalogo };
    const motivo = descarte({ ia: quien, modelo, esfuerzo }, vivos);
    if (motivo !== null) return { motivo: `${motivo}; consulta nexakit modelo` };
    return { ia: quien, conector, modelo, esfuerzo };
  }
}

/** `.github/workflows` son dos componentes seguidos: se mira aparte. */
const FLUJOS_DE_CI = ['.github', 'workflows'];

/** Motivo por el que una ruta del diff no se aplica sola, o `null`. */
function motivoRutaSensible(ruta: string): string | null {
  const partes = ruta.split(/[\\/]+/u).filter((p) => p !== '');
  const protegida = partes.find(esComponenteProtegido);
  if (protegida !== undefined) return `cambia «${protegida}»`;
  const normales = partes.map((p) => p.toLowerCase().replace(/[. ]+$/u, ''));
  for (let i = 0; i + 1 < normales.length; i += 1) {
    if (normales[i] === FLUJOS_DE_CI[0] && normales[i + 1] === FLUJOS_DE_CI[1]) return 'cambia .github/workflows';
  }
  return null;
}

/** Un destino de enlace que sale del repo: absoluto (también de Windows) o con `..` que se pasa de la raíz. */
function enlaceSaleDelRepo(ruta: string, destino: string): boolean {
  const normal = destino.replace(/\\/gu, '/');
  if (normal.startsWith('/') || /^[A-Za-z]:/u.test(normal) || destino.includes('\0')) return true;
  const resuelto = path.posix.normalize(path.posix.join(path.posix.dirname(ruta.replace(/\\/gu, '/')), normal));
  return resuelto === '..' || resuelto.startsWith('../');
}

/**
 * Lo que el diff trae y no debe aplicarse solo: enlaces simbólicos nuevos o cambiados que apuntan fuera del repo (o
 * cuyo destino no se puede leer del parche), gitlinks (modo `160000`, un repo anidado o submódulo), entradas que no se
 * pueden analizar y cambios en rutas sensibles (`.git`, `.claude`, `.codex`, `.gemini`, `.agents`, `.nexakit`, `.vscode`,
 * `.husky`, `.github/workflows`: código que se ejecutaría en la próxima sesión o commit). Todo sale del propio parche,
 * nunca del disco. Cada texto dice la ruta y el motivo.
 */
export function rutasVetadas(entradas: readonly EntradaParche[]): string[] {
  const vetadas: string[] = [];
  for (const { ruta, modo, destino } of entradas) {
    if (ruta === '' || modo === '') {
      vetadas.push(`${limpiar(ruta) || '(sin ruta)'} (entrada del diff que no se pudo analizar)`);
      continue;
    }
    const sensible = motivoRutaSensible(ruta);
    if (sensible !== null) vetadas.push(`${limpiar(ruta)} (${sensible})`);
    if (modo === '160000') {
      vetadas.push(`${limpiar(ruta)} (submódulo o repo git anidado: modo 160000)`);
      continue;
    }
    if (modo !== '120000') continue;
    if (destino === undefined || destino === null) {
      vetadas.push(`${limpiar(ruta)} (enlace simbólico cuyo destino no se pudo leer del diff)`);
      continue;
    }
    if (enlaceSaleDelRepo(ruta, destino)) {
      vetadas.push(`${limpiar(ruta)} (enlace simbólico hacia fuera del repo: ${limpiar(destino).slice(0, 200)})`);
      continue;
    }
    // Un enlace que apunta dentro del repo pero a un componente protegido (`x -> .git/hooks`) abriría la misma puerta.
    const interno = path.posix.normalize(path.posix.join(path.posix.dirname(ruta), destino.replace(/\\/gu, '/'))).replace(/\/+$/u, '') || '.';
    // Un enlace a la raíz del repo o a `.github` (ancestro de `.github/workflows`) da acceso a lo protegido.
    const normal = interno.toLowerCase().replace(/[. ]+$/u, '');
    const motivo = interno === '.' || interno === '' ? 'apunta a la raíz del repo' : normal === '.github' ? 'apunta a .github, que contiene .github/workflows' : motivoRutaSensible(interno);
    if (motivo !== null) vetadas.push(`${limpiar(ruta)} (enlace simbólico hacia una ruta protegida: ${limpiar(interno).slice(0, 200)}; ${motivo})`);
  }
  return vetadas;
}

/** Archivos de instrucciones de agentes y de configuración que se ejecuta o carga sola (en cualquier carpeta). */
const ARCHIVOS_CON_ALERTA = new Set(['claude.md', 'claude.local.md', 'agents.md', 'agents.override.md', 'gemini.md', '.envrc', '.npmrc']);
/** Carpetas de configuración de entornos y editores. */
const CARPETAS_CON_ALERTA = new Set(['.devcontainer', '.cursor', '.idea']);

/**
 * Cambios que no invalidan el encargo pero requieren revisión explícita antes de aplicarlo: instrucciones de agentes
 * (CLAUDE.md, AGENTS.md, GEMINI.md), `.envrc`, `.npmrc` y las carpetas `.devcontainer/`, `.cursor/` e `.idea/`.
 */
export function rutasConAlerta(entradas: readonly EntradaParche[]): string[] {
  const alertas = new Set<string>();
  for (const { ruta } of entradas) {
    const partes = ruta.split(/[\\/]+/u).filter((p) => p !== '').map((p) => p.toLowerCase().replace(/[. ]+$/u, ''));
    const ultima = ruta.split(/[\\/]+/u).filter((p) => p !== '').at(-1)?.toLowerCase() ?? '';
    if (ARCHIVOS_CON_ALERTA.has(ultima) || partes.some((p) => CARPETAS_CON_ALERTA.has(p))) {
      alertas.add(`${limpiar(ruta)} (requiere revisión explícita: instrucciones o configuración que se cargan solas)`);
    }
  }
  return [...alertas];
}

/** Formato de un id de encargo: nombre neutro, guion y 6 hex (nunca `fab-...`, que es el de un recorrido). */
export const RE_ID_ENCARGO = /^[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-f]{6}$/u;

/** Lee `informe.json` de un encargo ya terminado, sin seguir enlaces y con tope de tamaño. `null` si no hay uno válido. */
export function leerInformeEncargo(home: string, id: string): InformeEncargo | null {
  if (!RE_ID_ENCARGO.test(id)) return null;
  try {
    const archivo = path.join(home, '.nexakit', 'encargos', id, 'informe.json');
    const info = lstatSync(archivo, { throwIfNoEntry: false });
    if (info === undefined || !info.isFile() || info.size > 2 * 1024 * 1024) return null;
    const fd = openSync(archivo, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const dato: unknown = JSON.parse(readFileSync(fd, 'utf8'));
      return typeof dato === 'object' && dato !== null && (dato as { id?: unknown }).id === id && typeof (dato as { estado?: unknown }).estado === 'string'
        ? (dato as InformeEncargo)
        : null;
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

export type { Worktree };
