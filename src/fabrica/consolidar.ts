import type { ResultadoEstacion } from './conectores/tipos.js';
import type { EstadoRecorrido } from './ejecutor.js';
import { NOMBRES_ESTACION, type Hallazgo, type InformeEstacion, type NombreEstacion } from './esquemas.js';
import * as rastro from './rastro.js';

export type HallazgoConsolidado = Hallazgo & { estaciones: NombreEstacion[] };

export interface ModeloEstacion {
  estacion: NombreEstacion;
  modelo: string | null;
  modeloInformado: string | null;
}

/** Distancia máxima entre líneas para considerar que dos hallazgos son el mismo. */
export const DISTANCIA_LINEAS = 3;

const PESO = { alta: 0, media: 1, baja: 2 } as const;

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

/**
 * Unifica los hallazgos de todas las estaciones. Dos hallazgos del mismo archivo y categoría con
 * líneas a no más de 3 de distancia se funden: conservan todas las estaciones y la gravedad mayor.
 * Orden: gravedad (alta a baja), archivo y línea.
 */
export function consolidar(
  resultados: Array<{ estacion: NombreEstacion; informe?: InformeEstacion }>,
  hallazgosClaude: Hallazgo[] = [],
): HallazgoConsolidado[] {
  const todos: Hallazgo[] = [...hallazgosClaude];
  for (const r of resultados) {
    for (const h of r.informe?.hallazgos ?? []) todos.push({ ...h, estacion: h.estacion ?? r.estacion });
  }
  // Por archivo, categoría y línea: así los hallazgos cercanos quedan contiguos.
  todos.sort(
    (a, b) =>
      (a.archivo < b.archivo ? -1 : a.archivo > b.archivo ? 1 : 0) ||
      (a.categoria < b.categoria ? -1 : a.categoria > b.categoria ? 1 : 0) ||
      (a.linea ?? -1) - (b.linea ?? -1),
  );
  const grupos: Array<{ base: Hallazgo; ultimo: Hallazgo; estaciones: NombreEstacion[] }> = [];
  for (const h of todos) {
    const grupo = grupos.at(-1);
    if (grupo !== undefined && cercanos(grupo.ultimo, h)) {
      if (PESO[h.gravedad] < PESO[grupo.base.gravedad]) grupo.base = h;
      grupo.ultimo = h;
      if (!grupo.estaciones.includes(h.estacion)) grupo.estaciones.push(h.estacion);
    } else {
      grupos.push({ base: h, ultimo: h, estaciones: [h.estacion] });
    }
  }
  const orden = (e: NombreEstacion): number => NOMBRES_ESTACION.indexOf(e);
  return grupos
    .map((g) => ({ ...g.base, estaciones: [...g.estaciones].sort((a, b) => orden(a) - orden(b)) }))
    .sort(ordenar);
}

/** Escapa texto de un revisor para una celda de tabla: sin `|`, saltos de línea ni HTML. */
export function escaparMarkdown(texto: string): string {
  return texto
    .replace(/\\/gu, '\\\\')
    .replace(/\|/gu, '\\|')
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
): string {
  const e = escaparMarkdown;
  const out: string[] = [`# Consolidado del recorrido ${e(id)}`, '', `Fase: ${e(estado.fase)}`, ''];
  out.push('## Hallazgos', '');
  if (lista.length === 0) {
    out.push('Sin hallazgos en las estaciones que terminaron.', '');
  } else {
    out.push('| Gravedad | Estaciones | Archivo:línea | Hallazgo | Propuesta | Verificado |', '| --- | --- | --- | --- | --- | --- |');
    for (const h of lista) {
      const sitio = h.linea === null ? h.archivo : `${h.archivo}:${h.linea}`;
      out.push(`| ${h.gravedad} | ${h.estaciones.join(', ')} | ${e(sitio)} | ${e(h.hallazgo)} | ${e(h.propuesta)} |  |`);
    }
    out.push('');
  }
  const noRevisadas = estado.estaciones.filter((x) => NO_REVISADAS.has(x.estado));
  if (noRevisadas.length > 0 || estado.motivo !== undefined) {
    out.push('## No revisado', '');
    for (const x of noRevisadas) out.push(`- ${x.estacion} (${x.estado}): ${e(x.motivo ?? 'sin motivo registrado')}`);
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
      out.push(`- ${m.estacion}: pedido ${e(m.modelo ?? 'ninguno')}, informado ${e(m.modeloInformado ?? 'ninguno')}`);
    }
    out.push('');
  }
  return `${out.join('\n')}\n`;
}

/** Lee el rastro del recorrido, consolida y escribe `consolidado.md` en su carpeta. Devuelve la ruta. */
export async function escribirConsolidado(estado: EstadoRecorrido): Promise<string> {
  const resultados: Array<{ estacion: NombreEstacion; informe?: InformeEstacion }> = [];
  const modelos: ModeloEstacion[] = [];
  for (const { estacion } of estado.estaciones) {
    const dato = rastro.leerEstacion(estado.dir, estacion);
    if (dato === null) continue;
    const resultado: ResultadoEstacion | undefined = dato.resultado;
    if (resultado?.estado === 'ok' && resultado.informe !== undefined) resultados.push({ estacion, informe: resultado.informe });
    modelos.push({ estacion, modelo: dato.encargo?.modelo ?? null, modeloInformado: resultado?.modeloInformado ?? null });
  }
  return rastro.guardarConsolidado(estado.dir, consolidadoMarkdown(estado.id, consolidar(resultados), estado, modelos));
}
