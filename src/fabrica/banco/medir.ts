import type { Hallazgo } from '../esquemas.js';
import type { FalloSembrado } from './casos.js';

/** Líneas de margen por cada lado del rango de un fallo sembrado. */
export const MARGEN_LINEAS = 3;

/** Lo que `medir` usa de un hallazgo del revisor. */
export type HallazgoMedible = Pick<Hallazgo, 'archivo' | 'linea' | 'categoria'>;
/** Lo que `medir` usa de un fallo sembrado. */
export type FalloMedible = Pick<FalloSembrado, 'archivo' | 'lineas' | 'categoria'>;

export interface Medicion {
  /** Fallos sembrados que encontró algún hallazgo. */
  aciertos: number;
  fallosNoEncontrados: number;
  /** Hallazgos que no corresponden a ningún fallo sembrado. Los repetidos sobre un fallo no cuentan. */
  falsosPositivos: number;
}

export interface OpcionesMedir {
  /**
   * Estación del caso. Un hallazgo cuya categoría es el nombre de la estación («seguridad») o una genérica (ver
   * `CATEGORIAS_GENERICAS`) también vale si su archivo y su línea casan: el revisor escribe la categoría libre.
   */
  estacion?: string;
  /**
   * Documentos del caso (README, guías...). Un fallo de documentación se ancla en el código que cambió, pero la
   * contradicción está en un documento; un hallazgo sobre uno de estos documentos, con categoría equivalente, también
   * lo encuentra, sin mirar la línea (la del documento no se conoce).
   */
  documentos?: readonly string[];
}

/**
 * Categorías de los casos del banco y sus sinónimos razonables. Se comparan normalizadas (ver `normalizarCategoria`),
 * así que basta una forma de cada una: sin tildes, sin mayúsculas y sin «de», «la»...
 */
const EQUIVALENCIAS: Readonly<Record<string, readonly string[]>> = {
  'inyeccion-ordenes': [
    'inyeccion-comandos',
    'inyeccion-orden',
    'inyeccion-comando',
    'inyeccion-shell',
    'command-injection',
    'os-command-injection',
    'shell-injection',
    'ejecucion-ordenes',
    'ejecucion-comandos',
    'ejecucion-arbitraria',
    'rce',
  ],
  'recorrido-rutas': [
    'recorrido-ruta',
    'path-traversal',
    'directory-traversal',
    'traversal',
    'inyeccion-rutas',
    'inyeccion-ruta',
    'ruta-sin-validar',
    'rutas-sin-validar',
    'acceso-fuera-raiz',
  ],
  'secreto-expuesto': [
    'secreto-log',
    'secretos-log',
    'secreto-registro',
    'secretos-expuestos',
    'credenciales-expuestas',
    'fuga-secretos',
    'token-expuesto',
    'secret-leak',
    'secret-in-log',
  ],
  'violacion-adr': [
    'incumple-adr',
    'adr',
    'decision-incumplida',
    'violacion-decision',
    'violacion-capas',
    'dependencia-entre-capas',
    'dependencia-capas',
    'dependencia-invertida',
    'acoplamiento-capas',
    'limites-modulos',
    'limite-modulos',
    'architecture-violation',
    'layering-violation',
  ],
  'sin-prueba': [
    'sin-pruebas',
    'falta-prueba',
    'faltan-pruebas',
    'falta-pruebas',
    'prueba-faltante',
    'pruebas-faltantes',
    'sin-cobertura',
    'cobertura',
    'cobertura-insuficiente',
    'codigo-sin-prueba',
    'codigo-sin-pruebas',
    'missing-test',
    'missing-tests',
    'untested',
  ],
  'aserciones-debiles': [
    'asercion-debil',
    'prueba-debil',
    'pruebas-debiles',
    'sin-aserciones',
    'prueba-sin-aserciones',
    'prueba-no-comprueba-nada',
    'prueba-inutil',
    'prueba-vacia',
    'prueba-trivial',
    'weak-assertion',
    'weak-assertions',
  ],
  'consulta-n-mas-uno': [
    'n-mas-uno',
    'n-mas-1',
    'consulta-n-mas-1',
    'consultas-n-mas-uno',
    'consultas-n-mas-1',
    'consulta-elemento',
    'consulta-bucle',
    'consultas-bucle',
    'consultas-repetidas',
    'n-plus-one',
    'n-plus-1',
  ],
  'lectura-repetida': [
    'lecturas-repetidas',
    'lectura-bucle',
    'lectura-redundante',
    'e-s-repetida',
    'es-repetida',
    'io-repetida',
    'e-s-redundante',
    'falta-cache',
    'sin-cache',
    'repeated-read',
    'redundant-io',
  ],
  'doc-contradice-codigo': [
    'documentacion',
    'documentacion-desactualizada',
    'documentacion-obsoleta',
    'documentacion-incorrecta',
    'documentacion-inconsistente',
    'doc-obsoleta',
    'doc-desactualizada',
    'docs-desactualizadas',
    'inconsistencia-documentacion',
    'comentario-obsoleto',
    'comentario-desactualizado',
    'comentario-incorrecto',
    'informacion-obsoleta',
    'readme-desactualizado',
    'outdated-docs',
    'stale-docs',
  ],
};

/**
 * Categorías que no nombran un fallo concreto. Con ellas (o con el nombre de la estación) un hallazgo encuentra un
 * fallo si casan el archivo y la línea: el revisor escribe la categoría libre y sin vocabulario común.
 */
export const CATEGORIAS_GENERICAS: readonly string[] = [
  'general',
  'otro',
  'otros',
  'error',
  'errores',
  'bug',
  'bugs',
  'fallo',
  'fallos',
  'defecto',
  'problema',
  'hallazgo',
  'issue',
];

/** Palabras que no distinguen una categoría de otra. */
const VACIAS = new Set(['de', 'del', 'la', 'las', 'el', 'los', 'en', 'por', 'un', 'una', 'que', 'of', 'the', 'in']);

/**
 * Forma comparable de una categoría: sin tildes ni mayúsculas, «+» como «mas», cualquier otro signo como separador y
 * sin palabras vacías. «Inyección de órdenes» y «inyeccion_ordenes» dan lo mismo.
 */
export function normalizarCategoria(categoria: string): string {
  return categoria
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\+/gu, ' mas ')
    .split(/[^a-z0-9]+/u)
    .filter((t) => t !== '' && !VACIAS.has(t))
    .join('-');
}

/** De la forma normalizada a la categoría canónica de la tabla. */
const CANONICA = new Map<string, string>();
for (const [canonica, sinonimos] of Object.entries(EQUIVALENCIAS)) {
  for (const nombre of [canonica, ...sinonimos]) CANONICA.set(normalizarCategoria(nombre), canonica);
}

const canonica = (categoria: string): string => {
  const normal = normalizarCategoria(categoria);
  return CANONICA.get(normal) ?? normal;
};

/** `true` si las dos categorías son la misma o equivalentes según la tabla. */
export function categoriasEquivalentes(a: string, b: string): boolean {
  const ca = canonica(a);
  return ca !== '' && ca === canonica(b);
}

const DOCUMENTACION = 'doc-contradice-codigo';

/** Ruta comparable: barras normales y sin «./» al principio. */
export function normalizarRuta(ruta: string): string {
  let r = ruta.trim().replace(/\\/gu, '/');
  while (r.startsWith('./')) r = r.slice(2);
  return r;
}

/** Formas normalizadas de las categorías genéricas. */
const GENERICAS = new Set(CATEGORIAS_GENERICAS.map(normalizarCategoria));

/** `true` si la categoría del hallazgo vale para el fallo: equivalente, genérica o el nombre de la estación. */
function categoriaAceptada(categoria: string, fallo: string, estacion: string | undefined): boolean {
  if (categoriasEquivalentes(categoria, fallo)) return true;
  const normal = normalizarCategoria(categoria);
  return GENERICAS.has(normal) || (estacion !== undefined && normal !== '' && normal === normalizarCategoria(estacion));
}

function casa(h: HallazgoMedible, f: FalloMedible, documentos: ReadonlySet<string>, estacion: string | undefined): boolean {
  if (!categoriaAceptada(h.categoria, f.categoria, estacion)) return false;
  const archivo = normalizarRuta(h.archivo);
  if (archivo === normalizarRuta(f.archivo)) {
    if (h.linea === null || !Number.isFinite(h.linea)) return false;
    const [desde, hasta] = f.lineas;
    return h.linea >= desde - MARGEN_LINEAS && h.linea <= hasta + MARGEN_LINEAS;
  }
  return canonica(f.categoria) === DOCUMENTACION && documentos.has(archivo);
}

/**
 * Compara los hallazgos de un revisor con los fallos sembrados de un caso. Un hallazgo encuentra un fallo si habla del
 * mismo archivo, su línea cae en el rango del fallo con `MARGEN_LINEAS` de margen y su categoría es la misma, una
 * equivalente, una genérica o el nombre de la estación (`opciones.estacion`). Cada fallo casa con un hallazgo como mucho (se busca el emparejamiento con más aciertos); los hallazgos
 * de más sobre un fallo ya encontrado no son falsos positivos. Es pura.
 */
export function medir(
  hallazgos: readonly HallazgoMedible[],
  fallos: readonly FalloMedible[],
  opciones: OpcionesMedir = {},
): Medicion {
  const documentos = new Set((opciones.documentos ?? []).map(normalizarRuta));
  const compatibles = hallazgos.map((h) => fallos.flatMap((f, j) => (casa(h, f, documentos, opciones.estacion) ? [j] : [])));

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
