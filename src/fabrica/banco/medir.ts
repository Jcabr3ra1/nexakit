import type { Hallazgo } from '../esquemas.js';
import type { FalloSembrado } from './casos.js';

/** Líneas de margen por cada lado del rango de un fallo sembrado. */
export const MARGEN_LINEAS = 3;

/** Lo que `medir` usa de un hallazgo del revisor: dónde está y lo que dice (categoría, hallazgo y evidencia). */
export type HallazgoMedible = Pick<Hallazgo, 'archivo' | 'linea' | 'categoria' | 'hallazgo' | 'evidencia'>;
/** Lo que `medir` usa de un fallo sembrado: dónde está, sus claves y si es de documentación (su categoría). */
export type FalloMedible = Pick<FalloSembrado, 'archivo' | 'lineas' | 'categoria' | 'claves'>;

export interface Medicion {
  /** Fallos sembrados que encontró algún hallazgo. */
  aciertos: number;
  fallosNoEncontrados: number;
  /** Hallazgos que no corresponden a ningún fallo sembrado. Los repetidos sobre un fallo no cuentan. */
  falsosPositivos: number;
}

export interface OpcionesMedir {
  /**
   * Documentos del caso (README, guías...). Un fallo de documentación se ancla en el código que cambió, pero la
   * contradicción está en un documento; un hallazgo con sus claves sobre uno de estos documentos también lo encuentra,
   * sin mirar la línea (la del documento no se conoce).
   */
  documentos?: readonly string[];
}

/** Categoría de los fallos de documentación en `esperado.json`: los únicos que admite un hallazgo en un documento. */
export const CATEGORIA_DOCUMENTACION = 'doc-contradice-codigo';

/** Ruta comparable: barras normales y sin «./» al principio. */
export function normalizarRuta(ruta: string): string {
  let r = ruta.trim().replace(/\\/gu, '/');
  while (r.startsWith('./')) r = r.slice(2);
  return r;
}

/** Palabras que no distinguen nada: se quitan al normalizar. */
const VACIAS = new Set(['de', 'del', 'la', 'las', 'el', 'los', 'en', 'por', 'un', 'una', 'que', 'of', 'the', 'in']);

/**
 * Forma comparable de un texto: sin tildes ni mayúsculas, «+» como «mas», cualquier otro signo como separador, sin
 * palabras vacías y con las palabras unidas por guiones. «Inyección de órdenes» da «inyeccion-ordenes» y «N+1»,
 * «n-mas-1». Las claves de los fallos se escriben ya así.
 */
export function normalizarTexto(texto: string): string {
  return texto
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\+/gu, ' mas ')
    .split(/[^a-z0-9]+/u)
    .filter((t) => t !== '' && !VACIAS.has(t))
    .join('-');
}

/**
 * `true` si alguna clave aparece en la categoría, el hallazgo o la evidencia. Una clave es una raíz que empieza en un
 * límite de palabra: «certificad» casa con «certificados», y «red» con «red-real» pero no con «credencial».
 */
export function tieneClave(h: HallazgoMedible, claves: readonly string[]): boolean {
  const texto = `-${normalizarTexto(`${h.categoria} ${h.hallazgo} ${h.evidencia}`)}-`;
  return claves.some((clave) => clave !== '' && texto.includes(`-${clave}`));
}

function casa(h: HallazgoMedible, f: FalloMedible, documentos: ReadonlySet<string>): boolean {
  if (!tieneClave(h, f.claves)) return false;
  const archivo = normalizarRuta(h.archivo);
  if (archivo === normalizarRuta(f.archivo)) {
    if (h.linea === null || !Number.isFinite(h.linea)) return false;
    const [desde, hasta] = f.lineas;
    return h.linea >= desde - MARGEN_LINEAS && h.linea <= hasta + MARGEN_LINEAS;
  }
  return f.categoria === CATEGORIA_DOCUMENTACION && documentos.has(archivo);
}

/**
 * Compara los hallazgos de un revisor con los fallos sembrados de un caso. Un hallazgo encuentra un fallo si habla del
 * mismo archivo, su línea cae en el rango del fallo con `MARGEN_LINEAS` de margen y alguna clave del fallo aparece en
 * su categoría, su hallazgo o su evidencia (`tieneClave`). La categoría no tiene que coincidir: el revisor la escribe
 * con sus palabras («Dependencia circular», «JSDoc obsoleto»...). Las claves evitan que un defecto distinto a pocas
 * líneas (una URL sin validar junto al TLS desactivado) cuente como el fallo sembrado. Cada fallo casa con un hallazgo
 * como mucho (se busca el emparejamiento con más aciertos); los hallazgos de más sobre un fallo ya encontrado no son
 * falsos positivos. Es pura.
 */
export function medir(
  hallazgos: readonly HallazgoMedible[],
  fallos: readonly FalloMedible[],
  opciones: OpcionesMedir = {},
): Medicion {
  const documentos = new Set((opciones.documentos ?? []).map(normalizarRuta));
  const compatibles = hallazgos.map((h) => fallos.flatMap((f, j) => (casa(h, f, documentos) ? [j] : [])));

  // Emparejamiento máximo por caminos de aumento (los casos son pequeños).
  const duenoDe: Array<number | undefined> = fallos.map(() => undefined);
  const aumentar = (i: number, visitados: Set<number>): boolean => {
    for (const j of compatibles[i] ?? []) {
      if (visitados.has(j)) continue;
      visitados.add(j);
      const dueno = duenoDe[j];
      if (dueno === undefined || aumentar(dueno, visitados)) {
        duenoDe[j] = i;
        return true;
      }
    }
    return false;
  };
  let aciertos = 0;
  for (let i = 0; i < hallazgos.length; i += 1) if (aumentar(i, new Set())) aciertos += 1;

  const falsosPositivos = compatibles.filter((js) => js.length === 0).length;
  return { aciertos, fallosNoEncontrados: fallos.length - aciertos, falsosPositivos };
}

/**
 * Falsos positivos que cuentan como fallo en una ejecución, como mucho. Un revisor ruidoso que suelta veinte hallazgos
 * inventados en un solo caso no debe hundir la Beta por ese caso: con 3, un caso limpio con ruido pesa lo mismo que
 * no encontrar los fallos de tres casos, que ya es un castigo claro.
 */
export const TOPE_FALSOS_POSITIVOS = 3;

/**
 * Observación para la evidencia, por fallo y por hallazgo, no por caso: cada fallo sembrado encontrado es un acierto, y
 * cada fallo no encontrado y cada falso positivo (hasta `TOPE_FALSOS_POSITIVOS`) es un fallo. Un caso limpio
 * (`sembrados` 0) sin hallazgos cuenta un acierto: no inventar fallos también es acertar.
 */
export function observacionDe(m: Medicion, sembrados: number): { aciertos: number; fallos: number } {
  const fallos = m.fallosNoEncontrados + Math.min(m.falsosPositivos, TOPE_FALSOS_POSITIVOS);
  if (sembrados === 0 && fallos === 0) return { aciertos: 1, fallos: 0 };
  return { aciertos: m.aciertos, fallos };
}
