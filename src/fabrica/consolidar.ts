import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ResultadoEstacion } from './conectores/tipos.js';
import type { EstadoRecorrido } from './ejecutor.js';
import { claveEstacion, Hallazgo, InformeEstacion, NOMBRES_ESTACION, type IA, type IAExterna, type NombreEstacion } from './esquemas.js';
import * as rastro from './rastro.js';

/** De dónde sale un hallazgo unificado: el hallazgo de una estación y su clave propia (ver `claveDe`). */
export interface OrigenHallazgo {
  estacion: NombreEstacion;
  clave: string;
  ia?: IA;
  revisionDe?: IAExterna;
}

/**
 * Hallazgo unificado. `clave` lo identifica para el veredicto de la sesión y puede cambiar si cambian los hallazgos del
 * grupo (la lleva el que lo encabeza); `origenes` son los hallazgos de cada estación que lo forman, con claves que no
 * dependen del resto del grupo: sirven para no contar dos veces un veredicto.
 */
export type HallazgoConsolidado = Hallazgo & {
  estaciones: NombreEstacion[];
  clave: string;
  origenes: OrigenHallazgo[];
  coincidencias?: number;
};

export interface ModeloEstacion {
  estacion: NombreEstacion;
  revisionDe?: IAExterna;
  modelo: string | null;
  modeloInformado: string | null;
}

/** Distancia máxima entre líneas para considerar que dos hallazgos son el mismo. */
export const DISTANCIA_LINEAS = 3;

const PESO = { alta: 0, media: 1, baja: 2 } as const;

/**
 * Clave estable de un hallazgo: 12 hex del SHA-256 de `estacion|archivo|linea|categoria`. No depende del texto del
 * revisor (que puede variar entre llamadas), así que el mismo hallazgo da la misma clave mientras no cambie el sitio.
 */
export function claveDe(h: Pick<Hallazgo, 'estacion' | 'archivo' | 'linea' | 'categoria'>): string {
  const texto = [h.estacion, h.archivo, h.linea === null ? '' : String(h.linea), h.categoria].join('|');
  return createHash('sha256').update(texto, 'utf8').digest('hex').slice(0, 12);
}

function cercanos(a: Hallazgo, b: Hallazgo): boolean {
  if (a.archivo !== b.archivo || a.categoria !== b.categoria) return false;
  if (a.linea === null || b.linea === null) return a.linea === b.linea;
  return Math.abs(a.linea - b.linea) <= DISTANCIA_LINEAS;
}

function ordenar(a: Hallazgo, b: Hallazgo): number {
  return (
    PESO[a.gravedad] - PESO[b.gravedad] ||
    (a.archivo < b.archivo ? -1 : a.archivo > b.archivo ? 1 : 0) ||
    (a.linea ?? Number.MAX_SAFE_INTEGER) - (b.linea ?? Number.MAX_SAFE_INTEGER)
  );
}

interface InformeConOrigen {
  estacion: NombreEstacion;
  ia?: IA;
  revisionDe?: IAExterna;
  informe?: InformeEstacion;
}

interface HallazgoConOrigen {
  hallazgo: Hallazgo;
  origen: OrigenHallazgo;
}

function conOrigen(hallazgo: Hallazgo, ia?: IA, revisionDe?: IAExterna): HallazgoConOrigen {
  const clave = claveDe(hallazgo);
  return {
    hallazgo,
    origen: {
      estacion: hallazgo.estacion,
      clave: revisionDe === undefined ? clave : `${clave}-${revisionDe}`,
      ...(ia === undefined ? {} : { ia }),
      ...(revisionDe === undefined ? {} : { revisionDe }),
    },
  };
}

/** Cuenta IA distintas que coinciden dentro de una misma estación y vecindad de líneas. */
function contarCoincidencias(miembros: HallazgoConOrigen[]): number {
  const porEstacion = new Map<NombreEstacion, { ultimo: Hallazgo; ias: Set<IA> }>();
  let maximo = 0;
  for (const { hallazgo, origen } of miembros) {
    let grupo = porEstacion.get(origen.estacion);
    if (grupo === undefined || !cercanos(grupo.ultimo, hallazgo)) {
      grupo = { ultimo: hallazgo, ias: new Set() };
      porEstacion.set(origen.estacion, grupo);
    }
    grupo.ultimo = hallazgo;
    if (origen.ia !== undefined) grupo.ias.add(origen.ia);
    maximo = Math.max(maximo, grupo.ias.size);
  }
  return maximo;
}

/**
 * Unifica los hallazgos de todas las estaciones. Dos hallazgos del mismo archivo y categoría con
 * líneas a no más de 3 de distancia se funden: conservan todas las estaciones y la gravedad mayor.
 * Orden: gravedad (alta a baja), archivo y línea.
 */
export function consolidar(
  resultados: InformeConOrigen[],
  hallazgosClaude: Hallazgo[] = [],
): HallazgoConsolidado[] {
  const todos = hallazgosClaude.map((h) => conOrigen(h, 'claude'));
  for (const r of resultados) {
    // La estación sale del rastro, nunca del texto del revisor: así no puede fingir corroboración.
    for (const h of r.informe?.hallazgos ?? []) todos.push(conOrigen({ ...h, estacion: r.estacion }, r.ia ?? r.revisionDe, r.revisionDe));
  }
  // Por archivo, categoría y línea: así los hallazgos cercanos quedan contiguos.
  todos.sort(
    ({ hallazgo: a }, { hallazgo: b }) =>
      (a.archivo < b.archivo ? -1 : a.archivo > b.archivo ? 1 : 0) ||
      (a.categoria < b.categoria ? -1 : a.categoria > b.categoria ? 1 : 0) ||
      (a.linea ?? -1) - (b.linea ?? -1),
  );
  // El grupo se forma por vecindad sucesiva: cada hallazgo se compara con el último que entró,
  // así que una cadena de hallazgos a ≤ 3 líneas entre sí acaba en un solo grupo aunque los
  // extremos estén más lejos.
  const grupos: Array<{ base: Hallazgo; ultimo: Hallazgo; estaciones: NombreEstacion[]; miembros: HallazgoConOrigen[] }> = [];
  for (const miembro of todos) {
    const h = miembro.hallazgo;
    const grupo = grupos.at(-1);
    if (grupo !== undefined && cercanos(grupo.ultimo, h)) {
      if (PESO[h.gravedad] < PESO[grupo.base.gravedad]) grupo.base = h;
      grupo.ultimo = h;
      grupo.miembros.push(miembro);
      if (!grupo.estaciones.includes(h.estacion)) grupo.estaciones.push(h.estacion);
    } else {
      grupos.push({ base: h, ultimo: h, estaciones: [h.estacion], miembros: [miembro] });
    }
  }
  const orden = (e: NombreEstacion): number => NOMBRES_ESTACION.indexOf(e);
  return grupos
    .map((g): HallazgoConsolidado => {
      const coincidencias = contarCoincidencias(g.miembros);
      const origenes = new Map(g.miembros.map(({ origen }) => [origen.clave, origen]));
      return {
        ...g.base,
        estaciones: [...g.estaciones].sort((a, b) => orden(a) - orden(b)),
        clave: claveDe(g.base),
        origenes: [...origenes.values()],
        ...(coincidencias >= 2 ? { coincidencias, confianza: 'alta' } : {}),
      };
    })
    .sort(ordenar);
}

/** Escapa texto de un revisor para una celda de tabla: sin `|`, saltos de línea ni HTML. */
export function escaparMarkdown(texto: string): string {
  return texto
    .replace(/[\\|`[\]!]/gu, (c) => `\\${c}`)
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/[\r\n\p{Zl}\p{Zp}]+/gu, ' ')
    .trim();
}

const NO_REVISADAS = new Set(['fallida', 'cancelada', 'sin-modelo']);

export function consolidadoMarkdown(
  id: string,
  lista: HallazgoConsolidado[],
  estado: EstadoRecorrido,
  modelos: ModeloEstacion[] = [],
  invalidas: string[] = [],
): string {
  const e = escaparMarkdown;
  const out: string[] = [`# Consolidado del recorrido ${e(id)}`, '', `Fase: ${e(estado.fase)}`, ''];
  out.push('## Hallazgos', '');
  if (lista.length === 0) {
    out.push('Sin hallazgos en las estaciones que terminaron.', '');
  } else {
    out.push('| Gravedad | Estaciones | Archivo:línea | Hallazgo | Propuesta | Verificado | Clave |', '| --- | --- | --- | --- | --- | --- | --- |');
    for (const h of lista) {
      const sitio = h.linea === null ? h.archivo : `${h.archivo}:${h.linea}`;
      const estaciones = h.estaciones.join(', ') + (h.coincidencias === undefined ? '' : ` (coinciden ${h.coincidencias} IA)`);
      out.push(`| ${e(h.gravedad)} | ${e(estaciones)} | ${e(sitio)} | ${e(h.hallazgo)} | ${e(h.propuesta)} |  | ${e(h.clave)} |`);
    }
    out.push('');
  }
  const noRevisadas = estado.estaciones.filter((x) => NO_REVISADAS.has(x.estado));
  if (noRevisadas.length > 0 || invalidas.length > 0 || estado.motivo !== undefined) {
    out.push('## No revisado', '');
    for (const x of noRevisadas) out.push(`- ${e(claveEstacion(x.estacion, x.revisionDe))} (${e(x.estado)}): ${e(x.motivo ?? 'sin motivo registrado')}`);
    for (const i of invalidas) out.push(`- ${e(i)}: informe inválido en el rastro`);
    if (estado.motivo !== undefined) out.push(`- Recorrido: ${e(estado.motivo)}`);
    out.push('');
  }
  if (estado.escriturasDetectadas.length > 0) {
    out.push('## Escrituras detectadas', '');
    for (const a of estado.escriturasDetectadas) out.push(`- ${e(a)}`);
    out.push('');
  }
  if (modelos.length > 0) {
    out.push('## Modelos', '');
    for (const m of modelos) {
      out.push(`- ${e(claveEstacion(m.estacion, m.revisionDe))}: pedido ${e(m.modelo ?? 'ninguno')}, informado ${e(m.modeloInformado ?? 'ninguno')}`);
    }
    out.push('');
  }
  return `${out.join('\n')}\n`;
}

interface Rastro {
  resultados: InformeConOrigen[];
  modelos: ModeloEstacion[];
  invalidas: string[];
}

/** Lee del rastro el informe y los modelos de cada estación; lo ilegible o inválido va a `invalidas`. */
function leerRastro(estado: EstadoRecorrido): Rastro {
  const resultados: Rastro['resultados'] = [];
  const modelos: ModeloEstacion[] = [];
  const invalidas: string[] = [];
  for (const { estacion, ia, revisionDe } of estado.estaciones) {
    const nombre = claveEstacion(estacion, revisionDe);
    let dato: ReturnType<typeof rastro.leerEstacion>;
    try {
      dato = rastro.leerEstacion(estado.dir, estacion, revisionDe);
    } catch {
      invalidas.push(nombre);
      continue;
    }
    if (dato === null) continue;
    const resultado = dato.resultado;
    if (resultado?.estado === 'ok') {
      // El rastro es texto en disco: se revalida antes de fiarse.
      const informe = InformeEstacion.safeParse(resultado.informe);
      if (informe.success) resultados.push({
        estacion,
        ...(ia === undefined ? {} : { ia }),
        ...(revisionDe === undefined ? {} : { revisionDe }),
        informe: informe.data,
      });
      else invalidas.push(nombre);
    }
    modelos.push({
      estacion,
      ...(revisionDe === undefined ? {} : { revisionDe }),
      modelo: typeof dato.encargo?.modelo === 'string' ? dato.encargo.modelo : null,
      modeloInformado: typeof resultado?.modeloInformado === 'string' ? resultado.modeloInformado : null,
    });
  }
  return { resultados, modelos, invalidas };
}

/** Hallazgos de Claude que ya se pasaron a este recorrido (`claude.json`); una lista vacía si no hay o no son válidos. */
export function hallazgosGuardados(dir: string): Hallazgo[] {
  try {
    const r = z.array(Hallazgo).safeParse(rastro.leerHallazgosClaude(dir));
    return r.success ? r.data : [];
  } catch {
    return [];
  }
}

/** Hallazgos unificados del rastro del recorrido, sin escribir nada. */
export function hallazgosDe(estado: EstadoRecorrido, hallazgosClaude: Hallazgo[] = []): HallazgoConsolidado[] {
  return consolidar(leerRastro(estado).resultados, hallazgosClaude);
}

/** Lee el rastro del recorrido, consolida y escribe `consolidado.md` en su carpeta. Devuelve la ruta. */
export async function escribirConsolidado(estado: EstadoRecorrido, hallazgosClaude: Hallazgo[] = []): Promise<string> {
  const { resultados, modelos, invalidas } = leerRastro(estado);
  const lista = consolidar(resultados, hallazgosClaude);
  return rastro.guardarConsolidado(estado.dir, consolidadoMarkdown(estado.id, lista, estado, modelos, invalidas));
}
