import { createHash } from 'node:crypto';
import os from 'node:os';
import type { Conector, Encargo, ResultadoEstacion } from './conectores/tipos.js';
import { leerDiff } from './diff.js';
import { comparar, instantanea, type Instantanea } from './disco.js';
import { calcularCoste, comprobarHuella, type EstacionRecorrido, type Recorrido } from './enrutador.js';
import { ErrorFabrica } from './errores.js';
import { ESTACIONES } from './estaciones.js';
import type { IA, NombreEstacion } from './esquemas.js';
import * as rastro from './rastro.js';

/** Estaciones externas a la vez, salvo que la configuración diga otra cosa. */
export const PARALELISMO = 4;
/** Tiempo máximo de cada estación: 15 minutos. */
export const TIEMPO_MAXIMO_MS = 900_000;

const AVISO_SOLO_LECTURA = 'Revisa SOLO, sin modificar nada.';
const MENSAJE_HUELLA = 'El cambio ya no es el que aprobaste; vuelve a proponer';
const TIEMPO_AGOTADO = 'tiempo agotado';
const CANCELADA = 'cancelada por la persona';
const MODELO_RETIRADO = 'el modelo ya no está en el catálogo';

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
  home?: string;
}

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
    ordenesPermitidas: [...ESTACIONES[estacion.estacion].ordenesPermitidas],
  };
}

function mensajeDe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function copia(estado: EstadoRecorrido): EstadoRecorrido {
  return structuredClone(estado);
}

function obtener(id: string): Ejecucion {
  const ejecucion = registro.get(id);
  if (ejecucion === undefined) throw new ErrorFabrica(`No hay ningún recorrido ${id} en este proceso`);
  return ejecucion;
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

async function correrEstacion(ej: Ejecucion, trabajo: Lanzable, semaforo: Semaforo, timeoutMs: number): Promise<void> {
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
    try {
      // `then` convierte también una excepción síncrona del conector en un rechazo.
      resultado = await Promise.resolve().then(() => trabajo.conector.ejecutar(trabajo.encargo, control.signal));
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
    if (agotado) final = { ...resultado, estado: 'fallida', motivo: TIEMPO_AGOTADO };
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
): Promise<void> {
  const semaforo = new Semaforo(paralelismo);
  const desenlaces = await Promise.allSettled(trabajos.map((t) => correrEstacion(ej, t, semaforo, timeoutMs)));
  const fallo = desenlaces.find((d): d is PromiseRejectedResult => d.status === 'rejected');
  if (fallo !== undefined) ej.estado.motivo = `no se pudo guardar el rastro: ${mensajeDe(fallo.reason)}`;
  try {
    ej.estado.escriturasDetectadas = comparar(antes, await instantanea(raiz));
  } catch (error) {
    ej.estado.motivo ??= `no se pudo comprobar el disco tras el recorrido: ${mensajeDe(error)}`;
  }
  await ej.guardado;
  if (ej.errorRastro !== undefined) ej.estado.motivo ??= `no se pudo guardar el rastro: ${mensajeDe(ej.errorRastro)}`;
  // Una escritura en el repo pesa más que la cancelación: hay que verla.
  if (ej.estado.escriturasDetectadas.length > 0 || ej.estado.motivo !== undefined) ej.estado.fase = 'fallido';
  else ej.estado.fase = ej.cancelado ? 'cancelado' : 'terminado';
  ej.terminado = true;
  await persistir(ej);
}

/**
 * Lanza un recorrido aprobado. Comprueba la huella, recalcula el coste, revalida los
 * modelos contra los catálogos vivos, fija el disco y crea el rastro; devuelve el id en
 * cuanto el rastro existe y ejecuta las estaciones externas en segundo plano.
 */
export async function lanzar(r: Recorrido, opciones: OpcionesLanzar): Promise<{ id: string }> {
  const { raiz, conectores, paralelismo = PARALELISMO, timeoutMs = TIEMPO_MAXIMO_MS, home = os.homedir() } = opciones;
  if (!Number.isInteger(paralelismo) || paralelismo < 1) {
    throw new ErrorFabrica('El paralelismo debe ser un número entero mayor que cero');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new ErrorFabrica('El tiempo máximo por estación debe ser un número positivo de milisegundos');
  }

  await comprobarHuella(r, raiz);
  const diff = await leerDiff(raiz, r.basePedida);
  // Se relee para el encargo: si cambió desde la comprobación, no se lanza nada.
  if (diff.head !== r.head || diff.sha256 !== r.diffSha256) throw new ErrorFabrica(MENSAJE_HUELLA);
  const diffSha256 = createHash('sha256').update(diff.texto, 'utf8').digest('hex');
  const recorrido: Recorrido = { ...r, coste: calcularCoste(r.estaciones) };

  const catalogos = new Map<IA, Promise<Array<{ modelo: string; esfuerzos: string[] }>>>();
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
    let catalogo = catalogos.get(e.ia);
    if (catalogo === undefined) {
      const consulta = conector;
      catalogo = Promise.resolve().then(() => consulta.catalogo());
      catalogo.catch(() => {});
      catalogos.set(e.ia, catalogo);
    }
    let vivo: Array<{ modelo: string; esfuerzos: string[] }>;
    try {
      vivo = await catalogo;
    } catch (error) {
      marcar(fila, 'fallida', `no se pudo consultar el catálogo de ${e.ia}: ${mensajeDe(error)}`);
      continue;
    }
    const entrada = vivo.find((m) => m.modelo === e.modelo);
    if (entrada === undefined || (e.esfuerzo !== null && !entrada.esfuerzos.includes(e.esfuerzo))) {
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
  ej.fin = correr(ej, trabajos, antes, raiz, paralelismo, timeoutMs).catch((error: unknown) => {
    ej.estado.motivo ??= mensajeDe(error);
    ej.estado.fase = 'fallido';
    ej.terminado = true;
  });
  return { id };
}

/** Estado actual del recorrido (una copia). */
export function estado(id: string): EstadoRecorrido {
  return copia(obtener(id).estado);
}

/** Espera a que el recorrido termine y devuelve su estado final. */
export async function esperar(id: string): Promise<EstadoRecorrido> {
  const ej = obtener(id);
  await ej.fin;
  return copia(ej.estado);
}

/**
 * Cancela el recorrido: aborta las estaciones en curso, marca canceladas las pendientes
 * y espera a que los conectores devuelvan. Si ya terminó, no hace nada.
 */
export async function cancelar(id: string): Promise<void> {
  const ej = obtener(id);
  if (ej.terminado) return;
  if (!ej.cancelado) {
    ej.cancelado = true;
    for (const fila of ej.estado.estaciones) if (fila.estado === 'pendiente') marcar(fila, 'cancelada', CANCELADA);
    for (const control of ej.controladores) control.abort(new ErrorFabrica(CANCELADA));
    void persistir(ej);
  }
  await ej.fin;
}
