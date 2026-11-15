import { rm } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { HallazgoConsolidado } from './consolidar.js';
import type { EstadoRecorrido } from './ejecutor.js';
import { calcularHuella, type Recorrido } from './enrutador.js';
import { actualizar, cargar, guardar, revertirReal, type ClaveEvidencia, type Evidencia } from './evidencia.js';
import { IA, NombreEstacion } from './esquemas.js';
import * as rastro from './rastro.js';
import { limpiar, mensajeDe } from './sesion.js';

/** Tope de veredictos por llamada: igual que el de hallazgos de Claude. */
export const MAX_VEREDICTOS = 500;

export const Veredicto = z.object({
  clave: z.string().min(1).max(64),
  verificado: z.enum(['real', 'falso', 'dudoso']),
});
export type Veredicto = z.infer<typeof Veredicto>;

export const EsquemaVeredictos = z.array(Veredicto).max(MAX_VEREDICTOS);

const ClaveFila = z.object({
  ia: IA,
  modelo: z.string().min(1),
  esfuerzo: z.string().min(1).nullable(),
  estacion: NombreEstacion,
});

/** `veredictos.json`: por hallazgo, el veredicto ya aplicado y las filas de evidencia que sumó (para poder deshacerlo). */
const Registro = z.object({
  version: z.literal(1),
  aplicados: z.record(z.string(), z.object({ verificado: z.enum(['real', 'falso']), filas: z.array(ClaveFila) })),
});
type Aplicado = z.infer<typeof Registro>['aplicados'][string];

const EstacionDelRecorrido = z.object({
  estacion: NombreEstacion,
  ia: IA.nullable(),
  modelo: z.string().nullable(),
  esfuerzo: z.string().nullable(),
});
const RecorridoGuardado = z.object({ huella: z.string(), estaciones: z.array(EstacionDelRecorrido) });
type EstacionRecorridoGuardada = z.infer<typeof EstacionDelRecorrido>;

export interface ResultadoAprendizaje {
  /** Veredictos nuevos (o cambiados) que se sumaron a la evidencia. */
  aplicados: number;
  /** Veredictos que ya estaban aplicados con el mismo valor. */
  repetidos: number;
  /** Veredictos dudosos: no cuentan. */
  dudosos: number;
  /** Veredictos sin clave conocida o sin ninguna estación a la que atribuirlos. */
  ignorados: number;
  avisos: string[];
}

const vacio = (avisos: string[] = []): ResultadoAprendizaje => ({ aplicados: 0, repetidos: 0, dudosos: 0, ignorados: 0, avisos });

/** Una sola actualización de la evidencia a la vez en este proceso: leer, sumar y guardar no se pisan entre llamadas. */
let cola: Promise<unknown> = Promise.resolve();

/**
 * Lee el recorrido del rastro y comprueba su huella. Devuelve las estaciones con su IA, modelo y esfuerzo, o el
 * motivo por el que no se puede fiar de él. Esos datos están cubiertos por la huella que la persona aprobó.
 */
function leerRecorrido(dir: string): Map<NombreEstacion, EstacionRecorridoGuardada> | string {
  let dato: unknown;
  try {
    dato = rastro.leerRecorrido(dir);
  } catch {
    return 'El rastro del recorrido no se puede leer';
  }
  if (dato === null) return 'No hay rastro del recorrido';
  const r = RecorridoGuardado.safeParse(dato);
  if (!r.success) return 'El rastro del recorrido no tiene la forma esperada';
  let huella: string;
  try {
    huella = calcularHuella(dato as Recorrido);
  } catch {
    return 'El rastro del recorrido no tiene la forma esperada';
  }
  if (huella !== r.data.huella) return 'El rastro del recorrido no coincide con su huella: parece manipulado';
  return new Map(r.data.estaciones.map((e) => [e.estacion, e]));
}

function leerRegistro(dir: string): Map<string, Aplicado> | string {
  let dato: unknown;
  try {
    dato = rastro.leerVeredictos(dir);
  } catch {
    return 'veredictos.json no se puede leer';
  }
  if (dato === null) return new Map();
  const r = Registro.safeParse(dato);
  if (!r.success) return 'veredictos.json no tiene la forma esperada';
  return new Map(Object.entries(r.data.aplicados));
}

const serializar = (aplicados: Map<string, Aplicado>): unknown => ({ version: 1, aplicados: Object.fromEntries(aplicados) });

interface Atribucion {
  clave: ClaveEvidencia;
  /** Tokens de la estación en el rastro; `null` si no constan. */
  tokens: number | null;
}

/**
 * A qué fila de evidencia se atribuye un hallazgo de esta estación: la IA, el modelo y el esfuerzo del recorrido
 * aprobado. Las estaciones de Claude llevan el agente como modelo y ningún esfuerzo. Devuelve el motivo si no se puede.
 */
function atribuir(dir: string, estacion: NombreEstacion, recorrido: Map<NombreEstacion, EstacionRecorridoGuardada>): Atribucion | string {
  const e = recorrido.get(estacion);
  if (e === undefined) return `${estacion}: no consta en el recorrido`;
  if (e.ia === null || e.modelo === null) return `${estacion}: el recorrido no le asignó modelo`;
  if (e.ia === 'claude') return { clave: { ia: 'claude', modelo: e.modelo, esfuerzo: null, estacion }, tokens: null };
  let dato: ReturnType<typeof rastro.leerEstacion> = null;
  try {
    dato = rastro.leerEstacion(dir, estacion);
  } catch {
    return `${estacion}: su rastro no se puede leer`;
  }
  const encargo = dato?.encargo;
  if (encargo !== undefined && (encargo.modelo !== e.modelo || (encargo.esfuerzo ?? null) !== e.esfuerzo)) {
    return `${estacion}: el encargo del rastro no coincide con el recorrido aprobado`;
  }
  const total: unknown = dato?.resultado?.tokens?.total;
  const tokens = typeof total === 'number' && Number.isFinite(total) && total >= 0 ? total : null;
  return { clave: { ia: e.ia, modelo: e.modelo, esfuerzo: e.esfuerzo, estacion }, tokens };
}

function sumar(ev: Evidencia, a: Atribucion, verificado: 'real' | 'falso'): Evidencia {
  const previa = ev.filas.find(
    (f) => f.ia === a.clave.ia && f.modelo === a.clave.modelo && f.esfuerzo === a.clave.esfuerzo && f.estacion === a.clave.estacion,
  );
  // Lo que no consta no se inventa: la media de la fila queda como estaba (o en 0 si la fila es nueva).
  return actualizar(ev, a.clave, {
    aciertos: verificado === 'real' ? 1 : 0,
    fallos: verificado === 'falso' ? 1 : 0,
    tokens: a.tokens ?? previa?.tokensMedios ?? 0,
    segundos: previa?.segundosMedios ?? 0,
    fuente: 'real',
  });
}

/** Clave de una sola línea para un aviso: viene de la sesión y no se refleja tal cual. */
const claveParaAviso = (clave: string): string => limpiar(clave).replace(/[^0-9A-Za-z_-]/gu, '?').slice(0, 64);

async function aprender(home: string, estado: EstadoRecorrido, hallazgos: HallazgoConsolidado[], veredictos: Veredicto[]): Promise<ResultadoAprendizaje> {
  const recorrido = leerRecorrido(estado.dir);
  if (typeof recorrido === 'string') return vacio([`${recorrido}: no se actualiza la evidencia.`]);
  const registro = leerRegistro(estado.dir);
  if (typeof registro === 'string') return vacio([`${registro}: no se actualiza la evidencia.`]);
  const cargada = await cargar(home);
  if (cargada.aviso !== null) return vacio([`${cargada.aviso} No se actualiza la evidencia.`]);

  const porClave = new Map(hallazgos.map((h) => [h.clave, h]));
  const resultado = vacio();
  const aplicados = new Map(registro);
  let ev = cargada.evidencia;
  let cambio = false;
  for (const v of veredictos) {
    const h = porClave.get(v.clave);
    if (h === undefined) {
      resultado.ignorados += 1;
      resultado.avisos.push(`Clave desconocida, se ignora: ${claveParaAviso(v.clave)}`);
      continue;
    }
    if (v.verificado === 'dudoso') {
      resultado.dudosos += 1;
      continue;
    }
    const anterior = aplicados.get(v.clave);
    if (anterior?.verificado === v.verificado) {
      resultado.repetidos += 1;
      continue;
    }
    const atribuciones: Atribucion[] = [];
    for (const estacion of h.estaciones) {
      const a = atribuir(estado.dir, estacion, recorrido);
      if (typeof a === 'string') resultado.avisos.push(`Hallazgo ${v.clave}, ${a}: no cuenta para esa estación.`);
      else atribuciones.push(a);
    }
    if (atribuciones.length === 0) {
      resultado.ignorados += 1;
      continue;
    }
    // Un veredicto que cambia de real a falso (o al revés) deshace primero lo que sumó el anterior.
    for (const f of anterior?.filas ?? []) {
      ev = revertirReal(ev, f, { aciertos: anterior?.verificado === 'real' ? 1 : 0, fallos: anterior?.verificado === 'falso' ? 1 : 0 });
    }
    for (const a of atribuciones) ev = sumar(ev, a, v.verificado);
    aplicados.set(v.clave, { verificado: v.verificado, filas: atribuciones.map((a) => a.clave) });
    resultado.aplicados += 1;
    cambio = true;
  }
  if (!cambio) return resultado;

  // Primero se anota qué se aplicó: si algo falla a medias, es mejor perder un recuento que contarlo dos veces.
  await rastro.guardarVeredictos(estado.dir, serializar(aplicados));
  try {
    const guardada = await guardar(home, ev);
    if (guardada.aviso !== null) resultado.avisos.push(guardada.aviso);
  } catch (error) {
    if (registro.size === 0) await rm(path.join(estado.dir, 'veredictos.json'), { force: true }).catch(() => {});
    else await rastro.guardarVeredictos(estado.dir, serializar(registro)).catch(() => {});
    throw error;
  }
  return resultado;
}

/**
 * Aprende del uso real: cada veredicto «real» suma un acierto y cada «falso» un fallo, con fuente `real`, a la fila de
 * evidencia de CADA estación (y su modelo y esfuerzo) que reportó ese hallazgo. «dudoso» no cuenta. El mismo veredicto
 * repetido no cuenta doble; si cambia, se deshace el anterior. Si el rastro no existe o su huella no coincide, no
 * actualiza nada. Nunca lanza: lo que falle se devuelve como aviso.
 */
export function aprenderDeVeredictos(opciones: {
  home: string;
  estado: EstadoRecorrido;
  hallazgos: HallazgoConsolidado[];
  veredictos: Veredicto[];
}): Promise<ResultadoAprendizaje> {
  const { home, estado, hallazgos, veredictos } = opciones;
  const segura = cola.then(() => aprender(home, estado, hallazgos, veredictos)).catch((error: unknown) => vacio([`No se pudo actualizar la evidencia: ${limpiar(mensajeDe(error))}`]));
  cola = segura;
  return segura;
}
