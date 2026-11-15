import { createHash } from 'node:crypto';
import os from 'node:os';
import type { Conector, Encargo, ResultadoEstacion } from './conectores/tipos.js';
import { leerDiff } from './diff.js';
import { comparar, instantanea, type Instantanea } from './disco.js';
import { calcularCoste, comprobarHuella, descarte, type EstacionRecorrido, type Recorrido } from './enrutador.js';
import { ErrorFabrica } from './errores.js';
import { ESTACIONES } from './estaciones.js';
import type { IA, NombreEstacion } from './esquemas.js';
import * as rastro from './rastro.js';

/** Estaciones externas a la vez, salvo que la configuración diga otra cosa. */
export const PARALELISMO = 4;
/** Tiempo máximo de cada estación: 15 minutos. */
export const TIEMPO_MAXIMO_MS = 900_000;
/** Lo que se espera a un conector tras abortarlo, y a un catálogo vivo: 30 segundos. */
export const GRACIA_MS = 30_000;
export const TOPE_CATALOGO_MS = 30_000;
/** Recorridos terminados que se conservan en memoria; los demás se leen de `estado.json`. */
export const MAX_TERMINADOS = 50;

const AVISO_SOLO_LECTURA = 'Revisa SOLO, sin modificar nada.';
const MENSAJE_HUELLA = 'El cambio ya no es el que aprobaste; vuelve a proponer';
const TIEMPO_AGOTADO = 'tiempo agotado';
const CANCELADA = 'cancelada por la persona';
const MODELO_RETIRADO = 'el modelo ya no está en el catálogo';
const SIN_RESPUESTA = 'el revisor no respondió a la cancelación';
/** Marca de una espera que venció su tope. */
const AGOTADO: unique symbol = Symbol('agotado');

export type FaseRecorrido = 'en-curso' | 'terminado' | 'fallido' | 'cancelado';
export type EstadoEstacionEjecucion =
  | 'pendiente'
  | 'en-curso'
  | 'ok'
  | 'fallida'
  | 'cancelada'
  | 'claude'
  | 'omitida'
  | 'sin-modelo';

export interface EstadoRecorrido {
  id: string;
  /** Carpeta del rastro de este recorrido. */
  dir: string;
  fase: FaseRecorrido;
  estaciones: Array<{ estacion: NombreEstacion; estado: EstadoEstacionEjecucion; motivo?: string }>;
  escriturasDetectadas: string[];
  /** Por qué el recorrido falló sin que fallara una estación (por ejemplo, el rastro). */
  motivo?: string;
}

export interface OpcionesLanzar {
  raiz: string;
  conectores: Partial<Record<IA, Conector>>;
  paralelismo?: number;
  timeoutMs?: number;
  /** Espera máxima a que un conector devuelva tras abortarlo. */
  graciaMs?: number;
  /** Espera máxima a cada catálogo vivo. */
  topeCatalogoMs?: number;
  home?: string;
}

type Catalogo = Array<{ modelo: string; esfuerzos: string[] }>;

type FilaEstado = EstadoRecorrido['estaciones'][number];

interface Ejecucion {
  estado: EstadoRecorrido;
  controladores: Set<AbortController>;
  cancelado: boolean;
  terminado: boolean;
  fin: Promise<void>;
  /** Cadena de escrituras de `estado.json`, en orden. */
  guardado: Promise<void>;
  errorRastro: unknown;
}

interface Lanzable {
  fila: FilaEstado;
  conector: Conector;
  encargo: Encargo;
  encargoRastro: rastro.EncargoRastro;
}

const registro = new Map<string, Ejecucion>();
/** Ids terminados en memoria, del más antiguo al más reciente. */
const terminados: string[] = [];

function retirarAntiguos(id: string): void {
  terminados.push(id);
  while (terminados.length > MAX_TERMINADOS) {
    const viejo = terminados.shift();
    if (viejo !== undefined) registro.delete(viejo);
  }
}

/** Resuelve con `AGOTADO` si la promesa no termina en `ms`. */
function conTope<T>(promesa: Promise<T>, ms: number): Promise<T | typeof AGOTADO> {
  let reloj: NodeJS.Timeout | undefined;
  const tope = new Promise<typeof AGOTADO>((resolve) => {
    reloj = setTimeout(() => resolve(AGOTADO), ms);
  });
  return Promise.race([promesa, tope]).finally(() => clearTimeout(reloj));
}

/** Como `conTope`, pero el plazo empieza cuando se aborta la señal. */
function conGracia<T>(promesa: Promise<T>, señal: AbortSignal, ms: number): Promise<T | typeof AGOTADO> {
  let reloj: NodeJS.Timeout | undefined;
  let alAbortar = (): void => {};
  const gracia = new Promise<typeof AGOTADO>((resolve) => {
    alAbortar = () => {
      reloj = setTimeout(() => resolve(AGOTADO), ms);
    };
    if (señal.aborted) alAbortar();
    else señal.addEventListener('abort', alAbortar, { once: true });
  });
  return Promise.race([promesa, gracia]).finally(() => {
    clearTimeout(reloj);
    señal.removeEventListener('abort', alAbortar);
  });
}

class Semaforo {
  private libres: number;
  private readonly cola: Array<() => void> = [];
  constructor(plazas: number) {
    this.libres = plazas;
  }
  async adquirir(): Promise<void> {
    if (this.libres > 0) {
      this.libres -= 1;
      return;
    }
    await new Promise<void>((resolve) => this.cola.push(resolve));
  }
  liberar(): void {
    const siguiente = this.cola.shift();
    if (siguiente !== undefined) siguiente();
    else this.libres += 1;
  }
}

function instruccionesSinDiff(estacion: NombreEstacion, foco: string | undefined): string {
  const definicion = ESTACIONES[estacion];
  const partes = [`Estación: ${estacion}.`, definicion.foco, '', 'Criterios:', ...definicion.criterios.map((c) => `- ${c}`)];
  if (foco !== undefined && foco.trim() !== '') partes.push('', `Foco indicado por la persona: ${foco}`);
  partes.push('', AVISO_SOLO_LECTURA);
  return partes.join('\n');
}

/** Encargo de una estación externa: qué revisar, con qué modelo y el diff completo al final. */
export function construirEncargo(entrada: {
  estacion: EstacionRecorrido;
  raiz: string;
  base: string;
  foco?: string;
  diff: string;
}): Encargo {
  const { estacion, raiz, base, foco, diff } = entrada;
  if (estacion.modelo === null) throw new ErrorFabrica(`La estación ${estacion.estacion} no tiene modelo`);
  return {
    estacion: estacion.estacion,
    modelo: estacion.modelo,
    esfuerzo: estacion.esfuerzo,
    raiz,
    base,
    instrucciones: `${instruccionesSinDiff(estacion.estacion, foco)}\n\nDiff que debes revisar:\n${diff}`,
    // Las del recorrido aprobado, no las de la tabla: la persona las vio en la propuesta.
    ordenesPermitidas: [...estacion.ordenesPermitidas],
  };
}

function mensajeDe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function copia(estado: EstadoRecorrido): EstadoRecorrido {
  return structuredClone(estado);
}

function noExiste(id: string): ErrorFabrica {
  return new ErrorFabrica(`No hay ningún recorrido ${id} en este proceso ni en el rastro`);
}

/** Estado de un recorrido que ya no está en memoria, leído de su `estado.json`. */
function estadoGuardado(id: string, home: string): EstadoRecorrido {
  const guardado = rastro.leerEstado(home, id);
  if (typeof guardado !== 'object' || guardado === null || (guardado as { id?: unknown }).id !== id) throw noExiste(id);
  return guardado as EstadoRecorrido;
}

function persistir(ej: Ejecucion): Promise<void> {
  const foto = copia(ej.estado);
  ej.guardado = ej.guardado
    .then(() => rastro.guardarEstado(foto.dir, foto))
    .catch((error: unknown) => {
      ej.errorRastro ??= error;
    });
  return ej.guardado;
}

function marcar(fila: FilaEstado, estado: EstadoEstacionEjecucion, motivo?: string): void {
  fila.estado = estado;
  if (motivo === undefined) delete fila.motivo;
  else fila.motivo = motivo;
}

const RESULTADOS = new Set(['ok', 'fallida', 'cancelada']);

async function correrEstacion(
  ej: Ejecucion,
  trabajo: Lanzable,
  semaforo: Semaforo,
  timeoutMs: number,
  graciaMs: number,
): Promise<void> {
  await semaforo.adquirir();
  try {
    if (ej.cancelado || trabajo.fila.estado !== 'pendiente') return;
    const control = new AbortController();
    ej.controladores.add(control);
    let agotado = false;
    const reloj = setTimeout(() => {
      agotado = true;
      control.abort(new ErrorFabrica(TIEMPO_AGOTADO));
    }, timeoutMs);
    marcar(trabajo.fila, 'en-curso');
    void persistir(ej);

    let resultado: ResultadoEstacion;
    let sinRespuesta = false;
    try {
      // `then` convierte también una excepción síncrona del conector en un rechazo.
      const llamada = Promise.resolve().then(() => trabajo.conector.ejecutar(trabajo.encargo, control.signal));
      const respuesta = await conGracia(llamada, control.signal, graciaMs);
      if (respuesta === AGOTADO) {
        sinRespuesta = true;
        throw new ErrorFabrica(SIN_RESPUESTA);
      }
      resultado = respuesta;
      if (typeof resultado !== 'object' || resultado === null || !RESULTADOS.has(resultado.estado)) {
        throw new ErrorFabrica('respuesta no válida');
      }
    } catch (error) {
      resultado = {
        estado: 'fallida',
        crudo: '',
        modeloInformado: null,
        tokens: null,
        denegaciones: [],
        motivo: `el conector falló: ${mensajeDe(error)}`,
      };
    } finally {
      clearTimeout(reloj);
      ej.controladores.delete(control);
    }

    let final: ResultadoEstacion;
    if (sinRespuesta) final = { ...resultado, estado: 'fallida', motivo: SIN_RESPUESTA };
    else if (agotado) final = { ...resultado, estado: 'fallida', motivo: TIEMPO_AGOTADO };
    else if (ej.cancelado) final = { ...resultado, estado: 'cancelada', motivo: CANCELADA };
    else final = resultado;
    // Primero el archivo de la estación, para que un estado terminado siempre tenga su resultado.
    try {
      await rastro.guardarEstacion(ej.estado.dir, trabajo.fila.estacion, trabajo.encargoRastro, final);
    } finally {
      marcar(trabajo.fila, final.estado, final.motivo);
      void persistir(ej);
    }
  } finally {
    semaforo.liberar();
  }
}

async function correr(
  ej: Ejecucion,
  trabajos: Lanzable[],
  antes: Instantanea,
  raiz: string,
  paralelismo: number,
  timeoutMs: number,
  graciaMs: number,
  poda: Promise<void>,
): Promise<boolean> {
  const semaforo = new Semaforo(paralelismo);
  const desenlaces = await Promise.allSettled(
    trabajos.map((t) => correrEstacion(ej, t, semaforo, timeoutMs, graciaMs)),
  );
  const fallo = desenlaces.find((d): d is PromiseRejectedResult => d.status === 'rejected');
  if (fallo !== undefined) ej.estado.motivo = `no se pudo guardar el rastro: ${mensajeDe(fallo.reason)}`;
  try {
    ej.estado.escriturasDetectadas = comparar(antes, await instantanea(raiz));
  } catch (error) {
    ej.estado.motivo ??= `no se pudo comprobar el disco tras el recorrido: ${mensajeDe(error)}`;
  }
  await poda;
  await ej.guardado;
  if (ej.errorRastro !== undefined) ej.estado.motivo ??= `no se pudo guardar el rastro: ${mensajeDe(ej.errorRastro)}`;
  // Una escritura en el repo pesa más que la cancelación: hay que verla.
  if (ej.estado.escriturasDetectadas.length > 0 || ej.estado.motivo !== undefined) ej.estado.fase = 'fallido';
  else ej.estado.fase = ej.cancelado ? 'cancelado' : 'terminado';
  ej.terminado = true;
  try {
    await rastro.guardarEstado(ej.estado.dir, copia(ej.estado));
    return true;
  } catch (error) {
    // El disco se queda con un estado anterior: la memoria lo dice y conserva el recorrido.
    ej.estado.motivo ??= `no se pudo guardar el estado final en el rastro: ${mensajeDe(error)}`;
    ej.estado.fase = 'fallido';
    return false;
  }
}

/**
 * Lanza un recorrido aprobado. Comprueba la huella, recalcula el coste, revalida los
 * modelos contra los catálogos vivos, fija el disco y crea el rastro; devuelve el id en
 * cuanto el rastro existe y ejecuta las estaciones externas en segundo plano.
 */
export async function lanzar(r: Recorrido, opciones: OpcionesLanzar): Promise<{ id: string }> {
  const {
    raiz,
    conectores,
    paralelismo = PARALELISMO,
    timeoutMs = TIEMPO_MAXIMO_MS,
    graciaMs = GRACIA_MS,
    topeCatalogoMs = TOPE_CATALOGO_MS,
    home = os.homedir(),
  } = opciones;
  if (!Number.isInteger(paralelismo) || paralelismo < 1) {
    throw new ErrorFabrica('El paralelismo debe ser un número entero mayor que cero');
  }
  for (const [valor, nombre] of [
    [timeoutMs, 'El tiempo máximo por estación'],
    [graciaMs, 'La espera tras cancelar'],
    [topeCatalogoMs, 'La espera al catálogo'],
  ] as const) {
    if (!Number.isFinite(valor) || valor <= 0) throw new ErrorFabrica(`${nombre} debe ser un número positivo de milisegundos`);
  }

  await comprobarHuella(r, raiz);
  const diff = await leerDiff(raiz, r.basePedida);
  // Se relee para el encargo: si cambió desde la comprobación, no se lanza nada.
  if (diff.head !== r.head || diff.sha256 !== r.diffSha256) throw new ErrorFabrica(MENSAJE_HUELLA);
  const diffSha256 = createHash('sha256').update(diff.texto, 'utf8').digest('hex');
  const recorrido: Recorrido = { ...r, coste: calcularCoste(r.estaciones) };

  // Un catálogo por IA, consultados a la vez y con tope.
  const catalogos = new Map<IA, Promise<Catalogo | typeof AGOTADO>>();
  for (const e of r.estaciones) {
    if (e.estado !== 'propuesta' || e.ia === null || e.ia === 'claude' || catalogos.has(e.ia)) continue;
    const conector = conectores[e.ia];
    if (conector === undefined) continue;
    const consulta = conTope(
      Promise.resolve().then(() => conector.catalogo()),
      topeCatalogoMs,
    );
    consulta.catch(() => {});
    catalogos.set(e.ia, consulta);
  }
  const filas: FilaEstado[] = [];
  const trabajos: Lanzable[] = [];
  for (const e of r.estaciones) {
    const fila: FilaEstado = { estacion: e.estacion, estado: 'pendiente' };
    filas.push(fila);
    if (e.estado === 'omitida') {
      marcar(fila, 'omitida', e.motivo);
      continue;
    }
    if (e.estado === 'sin-modelo') {
      marcar(fila, 'sin-modelo', e.descartes.length > 0 ? `ningún modelo disponible: ${e.descartes.join('; ')}` : 'ningún modelo disponible');
      continue;
    }
    if (e.ia === 'claude') {
      marcar(fila, 'claude');
      continue;
    }
    if (e.ia === null || e.modelo === null) {
      marcar(fila, 'fallida', 'la estación no tiene modelo');
      continue;
    }
    const conector = conectores[e.ia];
    if (conector === undefined) {
      marcar(fila, 'fallida', `${e.ia} no está disponible`);
      continue;
    }
    let vivo: Catalogo | typeof AGOTADO;
    try {
      vivo = (await catalogos.get(e.ia)) ?? AGOTADO;
    } catch (error) {
      marcar(fila, 'fallida', `no se pudo consultar el catálogo de ${e.ia}: ${mensajeDe(error)}`);
      continue;
    }
    if (vivo === AGOTADO) {
      marcar(fila, 'fallida', `${e.ia} no está disponible: su catálogo no respondió a tiempo`);
      continue;
    }
    // El mismo criterio que al proponer: codex sin esfuerzo, por ejemplo, no pasa.
    if (descarte({ ia: e.ia, modelo: e.modelo, esfuerzo: e.esfuerzo }, { [e.ia]: vivo }) !== null) {
      marcar(fila, 'fallida', MODELO_RETIRADO);
      continue;
    }
    const encargo = construirEncargo({ estacion: e, raiz, base: r.base, foco: r.foco, diff: diff.texto });
    trabajos.push({
      fila,
      conector,
      encargo,
      encargoRastro: { ...encargo, instrucciones: instruccionesSinDiff(e.estacion, r.foco), diffSha256 },
    });
  }

  const antes = await instantanea(raiz);
  const { id, dir } = await rastro.crear(home, await rastro.nombreRepo(raiz), recorrido);
  const ej: Ejecucion = {
    estado: { id, dir, fase: 'en-curso', estaciones: filas, escriturasDetectadas: [] },
    controladores: new Set(),
    cancelado: false,
    terminado: false,
    fin: Promise.resolve(),
    guardado: Promise.resolve(),
    errorRastro: undefined,
  };
  registro.set(id, ej);
  await persistir(ej);
  if (ej.errorRastro !== undefined) {
    registro.delete(id);
    throw new ErrorFabrica(`No se pudo guardar el estado del rastro: ${mensajeDe(ej.errorRastro)}`);
  }
  // La poda corre en segundo plano y nunca hace fallar el recorrido.
  const poda = rastro.podar(home).then(
    () => undefined,
    () => undefined,
  );
  ej.fin = correr(ej, trabajos, antes, raiz, paralelismo, timeoutMs, graciaMs, poda).then(
    (guardado) => {
      // Si el estado final no llegó al disco, el recorrido se queda en memoria.
      if (guardado) retirarAntiguos(id);
    },
    (error: unknown) => {
      ej.estado.motivo ??= mensajeDe(error);
      ej.estado.fase = 'fallido';
      ej.terminado = true;
    },
  );
  return { id };
}

/** Estado actual del recorrido (una copia); si ya no está en memoria, el de su `estado.json`. */
export function estado(id: string, home: string = os.homedir()): EstadoRecorrido {
  const ej = registro.get(id);
  return ej === undefined ? estadoGuardado(id, home) : copia(ej.estado);
}

/** Espera a que el recorrido termine y devuelve su estado final. */
export async function esperar(id: string, home: string = os.homedir()): Promise<EstadoRecorrido> {
  const ej = registro.get(id);
  if (ej === undefined) return estadoGuardado(id, home);
  await ej.fin;
  return copia(ej.estado);
}

/**
 * Cancela el recorrido: aborta las estaciones en curso, marca canceladas las pendientes
 * y espera a que los conectores devuelvan. Si ya terminó, no hace nada.
 */
export async function cancelar(id: string, home: string = os.homedir()): Promise<void> {
  const ej = registro.get(id);
  if (ej === undefined) {
    // Fuera de memoria solo quedan recorridos terminados: comprobar que existe basta.
    estadoGuardado(id, home);
    return;
  }
  if (ej.terminado) return;
  if (!ej.cancelado) {
    ej.cancelado = true;
    for (const fila of ej.estado.estaciones) if (fila.estado === 'pendiente') marcar(fila, 'cancelada', CANCELADA);
    for (const control of ej.controladores) control.abort(new ErrorFabrica(CANCELADA));
    void persistir(ej);
  }
  await ej.fin;
}
