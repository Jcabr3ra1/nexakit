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
  /** Tokens medios de la elección; `null` si no tiene datos medidos o su coste no se midió (0 o no finito). */
  tokensEsperados: number | null;
  /** Una línea en español: calidad, tokens y la alternativa más barata descartada. */
  explicacion: string;
  descartados: Descartado[];
  /** Ningún candidato tiene evidencia: la elección es el primero de la tabla manual. */
  sinDatos: boolean;
  /** La elección es un candidato medido cuya calidad alcanza el umbral del riesgo. */
  alcanzaUmbral: boolean;
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

/**
 * El esfuerzo de Antigravity va dentro del id del modelo (`...-flash-low`): se lee de ahí si no se declara aparte.
 * Un esfuerzo desconocido cuenta como el más caro: nunca se prefiere por ignorancia.
 */
function rangoEsfuerzo(c: Candidato): number {
  const texto = (c.esfuerzo ?? /-(minimal|low|medium|high|xhigh|max)$/u.exec(c.modelo.toLowerCase())?.[1] ?? '').toLowerCase();
  const posicion = (ESFUERZOS as readonly string[]).indexOf(texto);
  return posicion === -1 ? ESFUERZOS.length : posicion;
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

/** Dos costes a menos de este margen se consideran empatados y decide la familia (opus con 3000 no gana a haiku con 3001). */
const MARGEN_EMPATE = 0.1;

interface Medido {
  candidato: Candidato;
  fila: FilaEvidencia;
  calidad: number;
  /** `false` si `tokensMedios` es 0 o no finito: un coste sin medir no es un coste gratis. */
  costeConocido: boolean;
}

/**
 * Ordena de menos a más coste esperado. Primero los de coste conocido: se toma el de menos tokens y, entre los que
 * cuestan como mucho un 10 % más que él, el de familia, esfuerzo y nombre menores; se repite con el resto. Después
 * los de coste desconocido, por familia. El resultado depende del conjunto y no del orden de entrada.
 */
function ordenarPorCoste(lista: readonly Medido[]): Medido[] {
  const porNombre = (a: Medido, b: Medido): number => ordenSinDatos(a.candidato, b.candidato);
  const resultado: Medido[] = [];
  let pendientes = lista.filter((m) => m.costeConocido);
  while (pendientes.length > 0) {
    const minimo = Math.min(...pendientes.map((m) => m.fila.tokensMedios));
    const siguiente = pendientes
      .filter((m) => m.fila.tokensMedios <= minimo * (1 + MARGEN_EMPATE))
      .sort(porNombre)[0] as Medido;
    resultado.push(siguiente);
    pendientes = pendientes.filter((m) => m !== siguiente);
  }
  return [...resultado, ...lista.filter((m) => !m.costeConocido).sort(porNombre)];
}

const mismoCandidato = (a: Candidato, b: Candidato): boolean => a.ia === b.ia && a.modelo === b.modelo && a.esfuerzo === b.esfuerzo;

function buscarFila(ev: Evidencia, estacion: NombreEstacion, c: Candidato): FilaEvidencia | undefined {
  return ev.filas.find((f) => f.estacion === estacion && mismoCandidato(f, c));
}

const nombreDe = (c: Candidato): string => (c.esfuerzo === null ? c.modelo : `${c.modelo} ${c.esfuerzo}`);

/** Número con coma decimal. */
const coma = (n: number, decimales: number): string => n.toFixed(decimales).replace('.', ',');

/** Calidad redondeada hacia abajo a dos decimales: nunca promete más de lo medido, y `≥ 0,75 < 0,75` no puede salir. */
const calidadTexto = (q: number): string => coma(Math.floor(q * 100 + 1e-9) / 100, 2);

function tokensTexto(m: Medido): string {
  if (!m.costeConocido) return 'tokens sin medir';
  const n = m.fila.tokensMedios;
  const entero = Math.round(n);
  return entero >= 1000 ? `~${coma(n / 1000, 1)}k tokens` : `~${entero} tokens`;
}

const sinDatosDe = (c: Candidato): Descartado => ({ candidato: c, motivo: 'sin datos medidos' });

/**
 * Elige el candidato más barato cuya calidad (cuantil del 5 %) alcanza el umbral del riesgo. Un candidato sin datos
 * nunca supera el umbral. Si ningún medido lo alcanza: con candidatos sin medir se usa el primero de ellos (el orden de
 * la tabla manual), y si todos están medidos, el de mayor calidad; ambos casos lo avisan y dejan `alcanzaUmbral` en
 * `false`. Es pura y determinista: los candidatos repetidos se cuentan una vez y el orden de entrada solo importa para
 * elegir el primero cuando no hay evidencia (o ningún medido basta) y la tabla manual manda.
 * Lanza `ErrorFabrica` si no hay candidatos o si una fila trae parámetros de Beta no válidos.
 */
export function elegir(entrada: EntradaElegir): Decision {
  const { estacion, riesgo, evidencia } = entrada;
  const candidatos = entrada.candidatos.filter((c, i, todos) => todos.findIndex((otro) => mismoCandidato(otro, c)) === i);
  const primero = candidatos[0];
  if (primero === undefined) throw new ErrorFabrica(`No hay candidatos para elegir modelo en la estación ${estacion}`);
  const umbral = UMBRALES[riesgo];

  const medidos: Medido[] = [];
  const sinMedir: Candidato[] = [];
  for (const candidato of candidatos) {
    const fila = buscarFila(evidencia, estacion, candidato);
    if (fila === undefined) sinMedir.push(candidato);
    else {
      const costeConocido = Number.isFinite(fila.tokensMedios) && fila.tokensMedios > 0;
      medidos.push({ candidato, fila, calidad: cuantil05(fila.alfa, fila.beta), costeConocido });
    }
  }
  const sinMedirOrdenados = (excepto: Candidato | undefined): Descartado[] =>
    sinMedir
      .filter((c) => excepto === undefined || c !== excepto)
      .sort(ordenSinDatos)
      .map(sinDatosDe);
  const motivoCalidad = (m: Medido): string => `calidad ≥ ${calidadTexto(m.calidad)} < ${coma(umbral, 2)}`;

  if (medidos.length === 0) {
    return {
      eleccion: primero,
      calidad: null,
      tokensEsperados: null,
      explicacion: `${nombreDe(primero)}: sin datos medidos, se usa la tabla manual (conviene medir con el banco)`,
      descartados: sinMedirOrdenados(primero),
      sinDatos: true,
      alcanzaUmbral: false,
    };
  }

  const superan = ordenarPorCoste(medidos.filter((m) => m.calidad >= umbral));
  if (superan.length === 0 && sinMedir.length > 0) {
    // Ningún medido basta: la calidad de los que faltan es desconocida y la tabla manual manda.
    const tabla = sinMedir[0] as Candidato;
    return {
      eleccion: tabla,
      calidad: null,
      tokensEsperados: null,
      explicacion: `ningún modelo medido alcanza el umbral; se usa ${nombreDe(tabla)} de la tabla, sin datos medidos`,
      descartados: [
        ...ordenarPorCoste(medidos).map((m) => ({ candidato: m.candidato, motivo: motivoCalidad(m) })),
        ...sinMedirOrdenados(tabla),
      ],
      sinDatos: false,
      alcanzaUmbral: false,
    };
  }

  const alcanzaUmbral = superan.length > 0;
  const porCoste = ordenarPorCoste(medidos);
  const elegido: Medido = alcanzaUmbral
    ? (superan[0] as Medido)
    : ([...medidos].sort((a, b) => b.calidad - a.calidad || porCoste.indexOf(a) - porCoste.indexOf(b))[0] as Medido);

  const resto = ordenarPorCoste(medidos.filter((m) => m !== elegido));
  const descartadosMedidos: Descartado[] = resto.map((m) => ({
    candidato: m.candidato,
    motivo:
      m.calidad >= umbral
        ? `cuesta más (${tokensTexto(m)}) que ${nombreDe(elegido.candidato)}`
        : motivoCalidad(m),
  }));

  // La alternativa más barata que se descartó por calidad: la primera por coste que habría ganado si hubiera bastado.
  const rival = ordenarPorCoste([elegido, ...resto.filter((m) => m.calidad < umbral)]);
  const masBarata = rival[0] === elegido ? undefined : rival[0];

  const obs = elegido.fila.banco + elegido.fila.real;
  let explicacion = `${nombreDe(elegido.candidato)}: calidad ≥ ${calidadTexto(elegido.calidad)} (${obs} obs.), ${tokensTexto(elegido)}`;
  if (!alcanzaUmbral) explicacion += `; ningún modelo alcanza el umbral de ${coma(umbral, 2)} (riesgo ${riesgo}), se elige el de mayor calidad`;
  if (masBarata !== undefined) {
    explicacion += `; descartado ${nombreDe(masBarata.candidato)} (≥ ${calidadTexto(masBarata.calidad)} < ${coma(umbral, 2)})`;
  }

  return {
    eleccion: elegido.candidato,
    calidad: elegido.calidad,
    tokensEsperados: elegido.costeConocido ? elegido.fila.tokensMedios : null,
    explicacion,
    descartados: [...descartadosMedidos, ...sinMedirOrdenados(undefined)],
    sinDatos: false,
    alcanzaUmbral,
  };
}
