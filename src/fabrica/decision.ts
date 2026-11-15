import type { Categoria } from './diff.js';
import { ErrorFabrica } from './errores.js';
import { cuantil05, type Evidencia, type FilaEvidencia } from './evidencia.js';
import type { IA, NombreEstacion } from './esquemas.js';

export type Riesgo = 'bajo' | 'medio' | 'alto';

/** Calidad mínima exigida por riesgo. Se compara con el cuantil del 5 % de la Beta, no con la media. */
export const UMBRALES: Readonly<Record<Riesgo, number>> = { bajo: 0.6, medio: 0.75, alto: 0.85 };

export interface Candidato {
  ia: IA;
  modelo: string;
  esfuerzo: string | null;
}

export interface Descartado {
  candidato: Candidato;
  motivo: string;
}

export interface EntradaElegir {
  estacion: NombreEstacion;
  riesgo: Riesgo;
  /** Candidatos en el orden de la tabla manual: si no hay evidencia de ninguno, se elige el primero. */
  candidatos: readonly Candidato[];
  evidencia: Evidencia;
}

export interface Decision {
  eleccion: Candidato;
  /** Cuantil del 5 % de la calidad; `null` si la elección no tiene datos medidos. */
  calidad: number | null;
  /** Tokens medios de la elección; `null` si no tiene datos medidos. */
  tokensEsperados: number | null;
  /** Una línea en español: calidad, tokens y la alternativa más barata descartada. */
  explicacion: string;
  descartados: Descartado[];
  /** Ningún candidato tiene evidencia: la elección es el primero de la tabla manual. */
  sinDatos: boolean;
}

/**
 * Riesgo de una estación: alto con hooks, rutas críticas o la estación de seguridad; bajo si solo hay documentación
 * o es la estación de documentación; medio en lo demás. Lo alto manda sobre lo bajo.
 */
export function riesgoDe(categorias: ReadonlySet<Categoria>, estacion: NombreEstacion): Riesgo {
  if (estacion === 'seguridad' || categorias.has('hooks') || categorias.has('critica')) return 'alto';
  if (estacion === 'documentacion') return 'bajo';
  if (categorias.size > 0 && [...categorias].every((c) => c === 'docs')) return 'bajo';
  return 'medio';
}

// ---------------------------------------------------------------------------------------------------------------
// Orden de coste sin datos medidos
// ---------------------------------------------------------------------------------------------------------------

const FAMILIAS: ReadonlyArray<readonly [RegExp, number]> = [
  [/\b(luna|flash|haiku)\b/u, 0],
  [/\b(hydrogen|terra|sonnet)\b/u, 1],
  [/\b(sol|argon|opus)\b/u, 2],
  [/\b(astra|carbon|fable)\b/u, 3],
];
/** Una familia desconocida cuenta como la más cara: nunca se prefiere por ignorancia. */
const FAMILIA_DESCONOCIDA = 99;

const ESFUERZOS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

function rangoFamilia(modelo: string): number {
  const nombre = modelo.toLowerCase();
  for (const [patron, rango] of FAMILIAS) if (patron.test(nombre)) return rango;
  return FAMILIA_DESCONOCIDA;
}

/** El esfuerzo de Antigravity va dentro del id del modelo (`...-flash-low`): se lee de ahí si no se declara aparte. */
function rangoEsfuerzo(c: Candidato): number {
  const texto = (c.esfuerzo ?? /-(minimal|low|medium|high|xhigh|max)$/u.exec(c.modelo.toLowerCase())?.[1] ?? '').toLowerCase();
  const posicion = (ESFUERZOS as readonly string[]).indexOf(texto);
  return posicion;
}

function comparar<T extends number | string>(a: T, b: T): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Orden por familia y esfuerzo, y por último alfabético. Es total y no depende del orden de entrada. */
function ordenSinDatos(a: Candidato, b: Candidato): number {
  return (
    comparar(rangoFamilia(a.modelo), rangoFamilia(b.modelo)) ||
    comparar(rangoEsfuerzo(a), rangoEsfuerzo(b)) ||
    comparar(a.modelo, b.modelo) ||
    comparar(a.esfuerzo ?? '', b.esfuerzo ?? '') ||
    comparar(a.ia, b.ia)
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Elección
// ---------------------------------------------------------------------------------------------------------------

interface Medido {
  candidato: Candidato;
  fila: FilaEvidencia;
  calidad: number;
}

/** Con datos: menos tokens esperados, después familia y esfuerzo, por último alfabético. */
function ordenCoste(a: Medido, b: Medido): number {
  return comparar(a.fila.tokensMedios, b.fila.tokensMedios) || ordenSinDatos(a.candidato, b.candidato);
}

function buscarFila(ev: Evidencia, estacion: NombreEstacion, c: Candidato): FilaEvidencia | undefined {
  return ev.filas.find((f) => f.estacion === estacion && f.ia === c.ia && f.modelo === c.modelo && f.esfuerzo === c.esfuerzo);
}

const nombreDe = (c: Candidato): string => (c.esfuerzo === null ? c.modelo : `${c.modelo} ${c.esfuerzo}`);

/** Número con coma decimal. */
const coma = (n: number, decimales: number): string => n.toFixed(decimales).replace('.', ',');

/** Calidad redondeada hacia abajo a dos decimales: nunca promete más de lo medido, y `≥ 0,75 < 0,75` no puede salir. */
const calidadTexto = (q: number): string => coma(Math.floor(q * 100 + 1e-9) / 100, 2);

function tokensTexto(n: number): string {
  const entero = Math.round(n);
  return entero >= 1000 ? `~${coma(n / 1000, 1)}k tokens` : `~${entero} tokens`;
}

/**
 * Elige el candidato más barato cuya calidad (cuantil del 5 %) alcanza el umbral del riesgo. Si ninguno lo alcanza, el
 * de mayor calidad, avisándolo. Un candidato sin datos nunca supera el umbral. Es pura y determinista: no depende del
 * orden de los candidatos, salvo para elegir el primero cuando no hay evidencia de ninguno.
 * Lanza `ErrorFabrica` si no hay candidatos o si una fila trae parámetros de Beta no válidos.
 */
export function elegir(entrada: EntradaElegir): Decision {
  const { estacion, riesgo, candidatos, evidencia } = entrada;
  const primero = candidatos[0];
  if (primero === undefined) throw new ErrorFabrica(`No hay candidatos para elegir modelo en la estación ${estacion}`);
  const umbral = UMBRALES[riesgo];

  const medidos: Medido[] = [];
  const sinMedir: Candidato[] = [];
  for (const candidato of candidatos) {
    const fila = buscarFila(evidencia, estacion, candidato);
    if (fila === undefined) sinMedir.push(candidato);
    else medidos.push({ candidato, fila, calidad: cuantil05(fila.alfa, fila.beta) });
  }
  const descartadosSinDatos: Descartado[] = [...sinMedir]
    .sort(ordenSinDatos)
    .map((candidato) => ({ candidato, motivo: 'sin datos medidos' }));

  if (medidos.length === 0) {
    return {
      eleccion: primero,
      calidad: null,
      tokensEsperados: null,
      explicacion: `${nombreDe(primero)}: sin datos medidos, se usa la tabla manual (conviene medir con el banco)`,
      descartados: candidatos.slice(1).map((candidato) => ({ candidato, motivo: 'sin datos medidos' })),
      sinDatos: true,
    };
  }

  const superan = medidos.filter((m) => m.calidad >= umbral).sort(ordenCoste);
  const alcanzaUmbral = superan.length > 0;
  const elegido = alcanzaUmbral
    ? (superan[0] as Medido)
    : [...medidos].sort((a, b) => b.calidad - a.calidad || ordenCoste(a, b))[0] as Medido;

  const resto = medidos.filter((m) => m !== elegido).sort(ordenCoste);
  const descartadosMedidos: Descartado[] = resto.map((m) => ({
    candidato: m.candidato,
    motivo:
      m.calidad >= umbral
        ? `cuesta más (${tokensTexto(m.fila.tokensMedios)}) que ${nombreDe(elegido.candidato)}`
        : `calidad ≥ ${calidadTexto(m.calidad)} < ${coma(umbral, 2)}`,
  }));

  // La alternativa más barata que se descartó por calidad: la primera por coste que habría ganado si hubiera bastado.
  const masBarata = resto.find((m) => m.calidad < umbral && ordenCoste(m, elegido) < 0);

  const obs = elegido.fila.banco + elegido.fila.real;
  let explicacion = `${nombreDe(elegido.candidato)}: calidad ≥ ${calidadTexto(elegido.calidad)} (${obs} obs.), ${tokensTexto(elegido.fila.tokensMedios)}`;
  if (!alcanzaUmbral) explicacion += `; ningún modelo alcanza el umbral de ${coma(umbral, 2)} (riesgo ${riesgo}), se elige el de mayor calidad`;
  if (masBarata !== undefined) {
    explicacion += `; descartado ${nombreDe(masBarata.candidato)} (≥ ${calidadTexto(masBarata.calidad)} < ${coma(umbral, 2)})`;
  }

  return {
    eleccion: elegido.candidato,
    calidad: elegido.calidad,
    tokensEsperados: elegido.fila.tokensMedios,
    explicacion,
    descartados: [...descartadosMedidos, ...descartadosSinDatos],
    sinDatos: false,
  };
}
