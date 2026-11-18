import { rm } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { HallazgoConsolidado } from './consolidar.js';
import type { EstadoRecorrido } from './ejecutor.js';
import { calcularHuella, type Recorrido } from './enrutador.js';
import { actualizar, cargar, guardar, revertirReal, type ClaveEvidencia, type Evidencia } from './evidencia.js';
import { IA, NombreEstacion } from './esquemas.js';
import { type FalsoRepetido, proponerPorFalsos, UMBRAL_FALSOS } from './lecciones.js';
import * as rastro from './rastro.js';
import { limpiar, mensajeDe } from './sesion.js';

/** Tope de veredictos por llamada: igual que el de hallazgos de Claude. */
export const MAX_VEREDICTOS = 500;
/** Observaciones que un recorrido puede sumar a la evidencia por estación: un recorrido no mueve la evidencia sin tope. */
export const MAX_VEREDICTOS_POR_ESTACION = 5;

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

// `archivo` y `categoria` del hallazgo (comunes a todo su grupo) permiten contar los falsos repetidos entre recorridos;
// los registros anteriores no los llevan y esos veredictos no cuentan para las lecciones.
const Origen = z.object({ verificado: z.enum(['real', 'falso']), fila: ClaveFila, archivo: z.string().optional(), categoria: z.string().optional() });
type Aplicado = z.infer<typeof Origen>;

/**
 * `veredictos.json`: por ORIGEN (la clave propia del hallazgo de una estación, que no cambia aunque cambie el grupo
 * en el que se funde), el veredicto ya aplicado y la fila de evidencia que sumó, para no contarlo dos veces y poder
 * deshacerlo. `tokens` son las estaciones cuyos tokens ya entraron en la media de su fila en este recorrido.
 */
const Registro = z.object({
  version: z.literal(1),
  origenes: z.record(z.string(), Origen),
  tokens: z.array(NombreEstacion),
});
interface EstadoRegistro {
  origenes: Map<string, Aplicado>;
  tokens: Set<NombreEstacion>;
}

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
  /** Observaciones que se deshicieron: un veredicto que cambió, un dudoso tras un real o un hallazgo de Claude que ya no existe. */
  revertidos: number;
  /** Veredictos que ya estaban aplicados con el mismo valor. */
  repetidos: number;
  /** Veredictos dudosos: no cuentan. */
  dudosos: number;
  /** Veredictos sin clave conocida, sin ninguna estación a la que atribuirlos o por encima del tope por estación. */
  ignorados: number;
  avisos: string[];
}

const vacio = (avisos: string[] = []): ResultadoAprendizaje => ({ aplicados: 0, revertidos: 0, repetidos: 0, dudosos: 0, ignorados: 0, avisos });

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

function leerRegistro(dir: string): EstadoRegistro | string {
  let dato: unknown;
  try {
    dato = rastro.leerVeredictos(dir);
  } catch {
    return 'veredictos.json no se puede leer';
  }
  if (dato === null) return { origenes: new Map(), tokens: new Set() };
  const r = Registro.safeParse(dato);
  if (!r.success) return 'veredictos.json no tiene la forma esperada';
  return { origenes: new Map(Object.entries(r.data.origenes)), tokens: new Set(r.data.tokens) };
}

const serializar = (r: EstadoRegistro): unknown => ({ version: 1, origenes: Object.fromEntries(r.origenes), tokens: [...r.tokens] });

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

/** Suma una observación real. Los tokens, si se pasan, entran en la media; los segundos nunca constan en el rastro. */
function sumar(ev: Evidencia, clave: ClaveEvidencia, verificado: 'real' | 'falso', tokens: number | undefined): Evidencia {
  return actualizar(ev, clave, {
    aciertos: verificado === 'real' ? 1 : 0,
    fallos: verificado === 'falso' ? 1 : 0,
    tokens,
    fuente: 'real',
  });
}

const deshacer = (ev: Evidencia, o: Aplicado): Evidencia =>
  revertirReal(ev, o.fila, { aciertos: o.verificado === 'real' ? 1 : 0, fallos: o.verificado === 'falso' ? 1 : 0 });

/** Clave de una sola línea para un aviso: viene de la sesión y no se refleja tal cual. */
const claveParaAviso = (clave: string): string => limpiar(clave).replace(/[^0-9A-Za-z_-]/gu, '?').slice(0, 64);

/**
 * Falsos positivos de estaciones externas por estación, categoría y archivo a lo largo de los recorridos de este repo
 * (los `veredictos.json` de su rastro). Lo ilegible o con otra forma se salta: es contar de más o de menos, nunca fallar.
 */
function contarFalsos(home: string, repo: string): Map<string, FalsoRepetido> {
  const cuenta = new Map<string, FalsoRepetido>();
  for (const dir of rastro.carpetasDeRecorridos(home, repo)) {
    let registro: EstadoRegistro | string;
    try {
      registro = leerRegistro(dir);
    } catch {
      continue;
    }
    if (typeof registro === 'string') continue;
    for (const o of registro.origenes.values()) {
      if (o.verificado !== 'falso' || o.fila.ia === 'claude' || o.archivo === undefined || o.categoria === undefined) continue;
      const clave = JSON.stringify([o.fila.estacion, o.categoria, o.archivo]);
      const previo = cuenta.get(clave);
      if (previo === undefined) cuenta.set(clave, { estacion: o.fila.estacion, categoria: o.categoria, archivo: o.archivo, veces: 1 });
      else previo.veces += 1;
    }
  }
  return cuenta;
}

/**
 * Tras aplicar falsos de estaciones externas, propone una lección por cada estación, categoría y archivo que ya lleve
 * `UMBRAL_FALSOS` o más en este repo. Las propuestas esperan a que la persona las acepte. Devuelve cuántas se crearon.
 */
async function proponerLecciones(home: string, repo: string, raiz: string, tocados: ReadonlySet<string>): Promise<number> {
  const falsos = [...contarFalsos(home, repo)].filter(([clave, f]) => tocados.has(clave) && f.veces >= UMBRAL_FALSOS).map(([, f]) => f);
  if (falsos.length === 0) return 0;
  return (await proponerPorFalsos(home, raiz, falsos)).length;
}

async function aprender(
  home: string,
  repo: string,
  raiz: string | undefined,
  estado: EstadoRecorrido,
  hallazgos: HallazgoConsolidado[],
  veredictos: Veredicto[],
): Promise<ResultadoAprendizaje> {
  const registro = leerRegistro(estado.dir);
  if (typeof registro === 'string') return vacio([`${registro}: no se actualiza la evidencia.`]);
  // Sin veredictos ni nada aplicado antes no hay nada que hacer.
  if (veredictos.length === 0 && registro.origenes.size === 0) return vacio();
  if (path.basename(path.dirname(estado.dir)) !== repo) {
    return vacio(['El recorrido es de otro repo, no del actual: no se actualiza la evidencia.']);
  }
  const recorrido = leerRecorrido(estado.dir);
  if (typeof recorrido === 'string') return vacio([`${recorrido}: no se actualiza la evidencia.`]);
  const cargada = await cargar(home);
  if (cargada.aviso !== null) return vacio([`${cargada.aviso} No se actualiza la evidencia.`]);

  const previo = serializar(registro);
  const habiaRegistro = registro.origenes.size > 0 || registro.tokens.size > 0;
  const porClave = new Map(hallazgos.map((h) => [h.clave, h]));
  const vigentes = new Set(hallazgos.flatMap((h) => h.origenes.map((o) => o.clave)));
  const resultado = vacio();
  let ev = cargada.evidencia;
  let cambio = false;
  // Estación, categoría y archivo de los falsos de estaciones externas que este recorrido acaba de sumar.
  const falsosNuevos = new Set<string>();

  // Los hallazgos de Claude pueden corregirse después de dar veredictos: lo contado sobre uno que ya no existe se
  // deshace, para que su sustituto no cuente encima de él. Los de las IA externas salen del rastro y no se tocan.
  for (const [origen, o] of [...registro.origenes]) {
    if (o.fila.ia !== 'claude' || vigentes.has(origen)) continue;
    ev = deshacer(ev, o);
    registro.origenes.delete(origen);
    resultado.revertidos += 1;
    cambio = true;
  }

  const enEstacion = (estacion: NombreEstacion): number => [...registro.origenes.values()].filter((o) => o.fila.estacion === estacion).length;
  for (const v of veredictos) {
    const h = porClave.get(v.clave);
    if (h === undefined) {
      resultado.ignorados += 1;
      resultado.avisos.push(`Clave desconocida, se ignora: ${claveParaAviso(v.clave)}`);
      continue;
    }
    if (v.verificado === 'dudoso') {
      resultado.dudosos += 1;
      // Un dudoso tras un real o un falso deja ese hallazgo sin veredicto: lo sumado antes se deshace.
      for (const origen of h.origenes) {
        const o = registro.origenes.get(origen.clave);
        if (o === undefined) continue;
        ev = deshacer(ev, o);
        registro.origenes.delete(origen.clave);
        resultado.revertidos += 1;
        cambio = true;
      }
      continue;
    }
    let nuevos = 0;
    let atribuidos = 0;
    for (const origen of h.origenes) {
      const o = registro.origenes.get(origen.clave);
      if (o?.verificado === v.verificado) {
        atribuidos += 1;
        continue;
      }
      const a = atribuir(estado.dir, origen.estacion, recorrido);
      if (typeof a === 'string') {
        resultado.avisos.push(`Hallazgo ${claveParaAviso(v.clave)}, ${a}: no cuenta para esa estación.`);
        continue;
      }
      if (o === undefined && enEstacion(origen.estacion) >= MAX_VEREDICTOS_POR_ESTACION) {
        resultado.avisos.push(
          `Hallazgo ${claveParaAviso(v.clave)}, ${origen.estacion}: ya hay ${MAX_VEREDICTOS_POR_ESTACION} veredictos de esta estación en el recorrido, no cuenta.`,
        );
        continue;
      }
      atribuidos += 1;
      // Un veredicto que cambia de real a falso (o al revés) deshace primero lo que sumó el anterior.
      if (o !== undefined) {
        ev = deshacer(ev, o);
        resultado.revertidos += 1;
      }
      // Los tokens de la estación entran una sola vez en el recorrido, no una por veredicto.
      const conTokens = a.tokens !== null && !registro.tokens.has(origen.estacion);
      ev = sumar(ev, a.clave, v.verificado, conTokens ? (a.tokens ?? undefined) : undefined);
      if (conTokens) registro.tokens.add(origen.estacion);
      registro.origenes.set(origen.clave, { verificado: v.verificado, fila: a.clave, archivo: h.archivo, categoria: h.categoria });
      if (v.verificado === 'falso' && a.clave.ia !== 'claude') falsosNuevos.add(JSON.stringify([origen.estacion, h.categoria, h.archivo]));
      nuevos += 1;
      cambio = true;
    }
    if (nuevos > 0) resultado.aplicados += 1;
    else if (atribuidos > 0) resultado.repetidos += 1;
    else resultado.ignorados += 1;
  }
  if (!cambio) return resultado;

  // Primero se anota qué se aplicó: si algo falla a medias, es mejor perder un recuento que contarlo dos veces.
  await rastro.guardarVeredictos(estado.dir, serializar(registro));
  try {
    const guardada = await guardar(home, ev);
    if (guardada.aviso !== null) resultado.avisos.push(guardada.aviso);
  } catch (error) {
    if (!habiaRegistro) await rm(path.join(estado.dir, 'veredictos.json'), { force: true }).catch(() => {});
    else await rastro.guardarVeredictos(estado.dir, previo).catch(() => {});
    throw error;
  }
  if (raiz !== undefined && falsosNuevos.size > 0) {
    // Una lección que no se pudo proponer no deshace la evidencia ya guardada: se avisa y nada más.
    try {
      const creadas = await proponerLecciones(home, repo, raiz, falsosNuevos);
      if (creadas > 0) {
        resultado.avisos.push(
          `Se ${creadas === 1 ? 'propuso 1 lección' : `propusieron ${creadas} lecciones`} por falsos positivos repetidos de una estación: revísalas con «nexakit lecciones» y acéptalas por su id si valen.`,
        );
      }
    } catch (error) {
      resultado.avisos.push(`No se pudieron proponer lecciones por falsos positivos: ${limpiar(mensajeDe(error))}`);
    }
  }
  return resultado;
}

/**
 * Aprende del uso real: cada veredicto «real» suma un acierto y cada «falso» un fallo, con fuente `real`, a la fila de
 * evidencia de CADA estación (y su modelo y esfuerzo) que reportó ese hallazgo. «dudoso» no cuenta. El mismo veredicto
 * repetido no cuenta doble, aunque cambie la clave del grupo: se deduplica por origen (el hallazgo de cada estación). Si
 * cambia, o llega un dudoso, se deshace el anterior. Como mucho `MAX_VEREDICTOS_POR_ESTACION` por estación y recorrido.
 * Si el rastro no existe, su huella no coincide o el recorrido es de otro repo, no actualiza nada. También deshace lo
 * contado sobre hallazgos de Claude que se corrigieron y ya no existen. Nunca lanza: lo que falle se devuelve como aviso.
 */
export function aprenderDeVeredictos(opciones: {
  home: string;
  /** Nombre del repo actual en el rastro (`nombreRepo(raiz)`): un recorrido de otro repo no puede mover la evidencia. */
  repo: string;
  /** Raíz real del repo. Con ella, los falsos positivos repetidos de una estación proponen una lección; sin ella, ninguna. */
  raiz?: string;
  estado: EstadoRecorrido;
  hallazgos: HallazgoConsolidado[];
  veredictos: Veredicto[];
}): Promise<ResultadoAprendizaje> {
  const { home, repo, raiz, estado, hallazgos, veredictos } = opciones;
  const segura = cola.then(() => aprender(home, repo, raiz, estado, hallazgos, veredictos)).catch((error: unknown) => vacio([`No se pudo actualizar la evidencia: ${limpiar(mensajeDe(error))}`]));
  cola = segura;
  return segura;
}
