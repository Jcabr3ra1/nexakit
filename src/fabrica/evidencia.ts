import { constants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { ErrorFabrica } from './errores.js';
import { IA, NombreEstacion } from './esquemas.js';
import { carpetaPropia, codigoError, escribirReemplazando, lstatSiExiste } from './rastro.js';

/** Días sin medir a partir de los cuales la evidencia se considera caducada (solo se avisa). */
export const DIAS_CADUCIDAD = 30;

/** Tope del tamaño del archivo que se lee: la evidencia real pesa unos pocos KB. */
const MAX_BYTES = 1024 * 1024;
const DIA_MS = 24 * 60 * 60 * 1000;
const CUANTIL = 0.05;
/** Una observación real pesa el doble que una del banco: viene del uso verdadero de la persona. */
const PESO_REAL = 2;

export type FuenteEvidencia = 'banco' | 'real';

const Fecha = z.string().refine((valor) => !Number.isNaN(Date.parse(valor)), 'fecha no válida');
const Positivo = z.number().positive().finite();
const NoNegativo = z.number().nonnegative().finite();
const Contador = z.number().int().nonnegative();
const Modelos = z.array(z.string().min(1));

const Fila = z.object({
  ia: IA,
  modelo: z.string().min(1),
  esfuerzo: z.string().min(1).nullable(),
  estacion: NombreEstacion,
  alfa: Positivo,
  beta: Positivo,
  tokensMedios: NoNegativo,
  segundosMedios: NoNegativo,
  /** Observaciones del banco (sin ponderar). */
  banco: Contador,
  /** Observaciones reales verificadas (sin ponderar). */
  real: Contador,
});

const claveDeFila = (f: { ia: string; modelo: string; esfuerzo: string | null; estacion: string }): string =>
  JSON.stringify([f.ia, f.modelo, f.esfuerzo, f.estacion]);

const EsquemaEvidencia = z.object({
  version: z.literal(1),
  actualizada: Fecha,
  catalogo: z.object({ codex: Modelos, antigravity: Modelos, claude: Modelos }),
  filas: z
    .array(Fila)
    .refine((filas) => new Set(filas.map(claveDeFila)).size === filas.length, 'filas repetidas'),
});

export type FilaEvidencia = z.infer<typeof Fila>;
export type Evidencia = z.infer<typeof EsquemaEvidencia>;

/** Identifica una fila. Para Antigravity el esfuerzo es `null`. */
export interface ClaveEvidencia {
  ia: IA;
  modelo: string;
  esfuerzo: string | null;
  estacion: NombreEstacion;
}

const EsquemaClave = z.object({ ia: IA, modelo: z.string().min(1), esfuerzo: z.string().min(1).nullable(), estacion: NombreEstacion });

export interface ObservacionEvidencia {
  aciertos: number;
  fallos: number;
  /** Tokens medios por observación de este lote. */
  tokens: number;
  /** Segundos medios por observación de este lote. */
  segundos: number;
  fuente: FuenteEvidencia;
  /** Hora de la medición; por defecto, ahora. Solo la usa la fuente `banco`. */
  ahora?: Date;
}

const EsquemaObservacion = z.object({
  aciertos: Contador,
  fallos: Contador,
  tokens: NoNegativo,
  segundos: NoNegativo,
  fuente: z.enum(['banco', 'real']),
});

/** Evidencia sin datos: Beta(1,1) implícita para todo. Su fecha es la de creación. */
export function evidenciaVacia(ahora: Date = new Date()): Evidencia {
  return { version: 1, actualizada: ahora.toISOString(), catalogo: { codex: [], antigravity: [], claude: [] }, filas: [] };
}

/** Texto del primer problema de un esquema, para el mensaje de error. */
function primerProblema(error: z.ZodError): string {
  const problema = error.issues[0];
  if (problema === undefined) return 'datos no válidos';
  const donde = problema.path.length > 0 ? `${problema.path.join('.')}: ` : '';
  return `${donde}${problema.message}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Beta: cuantil del 5 %
// ---------------------------------------------------------------------------------------------------------------

const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
  12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
] as const;

/** ln Γ(x) para x > 0 (aproximación de Lanczos, error relativo del orden de 1e-15). */
function lnGamma(x: number): number {
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  const z0 = x - 1;
  let suma = LANCZOS[0];
  for (let i = 1; i < LANCZOS.length; i += 1) suma += (LANCZOS[i] as number) / (z0 + i);
  const t = z0 + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z0 + 0.5) * Math.log(t) - t + Math.log(suma);
}

/** Fracción continua de la beta incompleta, por el método de Lentz modificado. */
function fraccionContinua(a: number, b: number, x: number): number {
  const TINY = 1e-300;
  const EPS = 1e-15;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < TINY) d = TINY;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 20_000; m += 1) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < EPS) break;
  }
  return h;
}

/** Beta incompleta regularizada I_x(a, b): la función de distribución de una Beta(a, b). */
function betaIncompleta(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const factor = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log1p(-x));
  // La fracción converge deprisa a un lado de la media; al otro se usa la simetría I_x(a, b) = 1 - I_(1-x)(b, a).
  return x < (a + 1) / (a + b + 2)
    ? (factor * fraccionContinua(a, b, x)) / a
    : 1 - (factor * fraccionContinua(b, a, 1 - x)) / b;
}

/**
 * Cuantil del 5 % de una Beta(alfa, beta): el valor por debajo del cual cae el 5 % de la probabilidad.
 * Es el límite inferior prudente de la calidad esperada: con pocos datos queda lejos de la media.
 * Sin dependencias: beta incompleta por fracción continua de Lentz y bisección sobre [0, 1].
 */
export function cuantil05(alfa: number, beta: number): number {
  if (!Number.isFinite(alfa) || !Number.isFinite(beta) || alfa <= 0 || beta <= 0) {
    throw new ErrorFabrica(`Los parámetros de la Beta deben ser positivos y finitos: alfa=${alfa}, beta=${beta}`);
  }
  let bajo = 0;
  let alto = 1;
  for (let i = 0; i < 100; i += 1) {
    const medio = (bajo + alto) / 2;
    if (betaIncompleta(alfa, beta, medio) < CUANTIL) bajo = medio;
    else alto = medio;
  }
  return (bajo + alto) / 2;
}

// ---------------------------------------------------------------------------------------------------------------
// Actualizar y caducar
// ---------------------------------------------------------------------------------------------------------------

/**
 * Devuelve una evidencia nueva con la observación sumada a su fila (se crea con Beta(1,1) si no existe);
 * la recibida no se toca. Los aciertos suman a `alfa` y los fallos a `beta`, con peso 2 si la fuente es `real`.
 * `tokensMedios` y `segundosMedios` son medias ponderadas por el número de observaciones (sin el peso de la fuente).
 * Solo una medición del `banco` registra el modelo en el catálogo medido y renueva `actualizada`.
 */
export function actualizar(ev: Evidencia, clave: ClaveEvidencia, observacion: ObservacionEvidencia): Evidencia {
  const k = EsquemaClave.safeParse(clave);
  if (!k.success) throw new ErrorFabrica(`Clave de evidencia no válida: ${primerProblema(k.error)}`);
  const o = EsquemaObservacion.safeParse(observacion);
  if (!o.success) throw new ErrorFabrica(`Observación de evidencia no válida: ${primerProblema(o.error)}`);
  const { aciertos, fallos, tokens, segundos, fuente } = o.data;
  const n = aciertos + fallos;
  if (n === 0) return ev;

  const idClave = claveDeFila(k.data);
  const anterior = ev.filas.find((f) => claveDeFila(f) === idClave);
  const previas = anterior === undefined ? 0 : anterior.banco + anterior.real;
  const peso = fuente === 'real' ? PESO_REAL : 1;
  const media = (antes: number, ahora: number): number => (previas === 0 ? ahora : (antes * previas + ahora * n) / (previas + n));

  const fila: FilaEvidencia = {
    ...k.data,
    alfa: (anterior?.alfa ?? 1) + aciertos * peso,
    beta: (anterior?.beta ?? 1) + fallos * peso,
    tokensMedios: media(anterior?.tokensMedios ?? 0, tokens),
    segundosMedios: media(anterior?.segundosMedios ?? 0, segundos),
    banco: (anterior?.banco ?? 0) + (fuente === 'banco' ? n : 0),
    real: (anterior?.real ?? 0) + (fuente === 'real' ? n : 0),
  };
  const filas = anterior === undefined ? [...ev.filas, fila] : ev.filas.map((f) => (f === anterior ? fila : f));

  const catalogo = { codex: [...ev.catalogo.codex], antigravity: [...ev.catalogo.antigravity], claude: [...ev.catalogo.claude] };
  let actualizada = ev.actualizada;
  if (fuente === 'banco') {
    if (!catalogo[k.data.ia].includes(k.data.modelo)) catalogo[k.data.ia].push(k.data.modelo);
    actualizada = (observacion.ahora ?? new Date()).toISOString();
  }
  return { version: 1, actualizada, catalogo, filas };
}

export interface Caducidad {
  caducada: boolean;
  motivos: string[];
}

/**
 * Dice si la evidencia conviene renovarla: más de 30 días desde la última medición del banco, o modelos vivos
 * del catálogo que el banco no ha medido. Solo informa: nunca lanza nada.
 */
export function caducada(ev: Evidencia, catalogosVivos: Partial<Record<IA, readonly string[]>>, ahora: Date): Caducidad {
  const motivos: string[] = [];
  const dias = Math.max(0, Math.floor((ahora.getTime() - Date.parse(ev.actualizada)) / DIA_MS));
  if (dias > DIAS_CADUCIDAD) motivos.push(`la evidencia tiene ${dias} días`);

  const sinMedir: string[] = [];
  for (const ia of IA.options) {
    for (const modelo of catalogosVivos[ia] ?? []) {
      if (!ev.catalogo[ia].includes(modelo) && !sinMedir.includes(modelo)) sinMedir.push(modelo);
    }
  }
  if (sinMedir.length > 0) motivos.push(`modelos sin medir: ${sinMedir.join(', ')}`);
  return { caducada: motivos.length > 0, motivos };
}

// ---------------------------------------------------------------------------------------------------------------
// Archivo ~/.nexakit/fabrica/evidencia.json
// ---------------------------------------------------------------------------------------------------------------

const carpetaBase = (home: string): string => path.join(home, '.nexakit', 'fabrica');

export interface EvidenciaCargada {
  evidencia: Evidencia;
  /** Por qué se parte de cero aunque haya un archivo; `null` si se leyó bien o no había archivo. */
  aviso: string | null;
}

function sinLeer(motivo: string, ahora: Date): EvidenciaCargada {
  return {
    evidencia: evidenciaVacia(ahora),
    aviso: `No se pudo leer la evidencia guardada (${motivo}): se parte sin datos medidos y el archivo no se toca hasta el próximo guardado.`,
  };
}

/**
 * Lee `~/.nexakit/fabrica/evidencia.json` sin seguir enlaces. Nunca lanza: sin archivo da evidencia vacía; con un
 * archivo corrupto, de otra versión, de forma inválida, enlazado o desmesurado, da evidencia vacía y un aviso.
 * No sobrescribe nada: el archivo solo cambia con un `guardar` explícito.
 */
export async function cargar(home: string, ahora: Date = new Date()): Promise<EvidenciaCargada> {
  try {
    const base = carpetaBase(home);
    const carpeta = await lstatSiExiste(base);
    if (carpeta === null) return { evidencia: evidenciaVacia(ahora), aviso: null };
    if (carpeta.isSymbolicLink() || !carpeta.isDirectory()) return sinLeer('la carpeta de la fábrica no es una carpeta real', ahora);
    const ruta = path.join(base, 'evidencia.json');
    const info = await lstatSiExiste(ruta);
    if (info === null) return { evidencia: evidenciaVacia(ahora), aviso: null };
    if (info.isSymbolicLink() || !info.isFile()) return sinLeer('no es un archivo normal', ahora);
    const archivo = await open(ruta, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let texto: string;
    try {
      if ((await archivo.stat()).size > MAX_BYTES) return sinLeer('el archivo es demasiado grande', ahora);
      texto = await archivo.readFile('utf8');
    } finally {
      await archivo.close();
    }
    let valor: unknown;
    try {
      valor = JSON.parse(texto);
    } catch {
      return sinLeer('JSON corrupto', ahora);
    }
    const version = typeof valor === 'object' && valor !== null ? (valor as { version?: unknown }).version : undefined;
    if (version !== undefined && version !== 1) return sinLeer(`versión desconocida: ${JSON.stringify(version)}`, ahora);
    const resultado = EsquemaEvidencia.safeParse(valor);
    if (!resultado.success) return sinLeer(`no tiene la forma esperada, ${primerProblema(resultado.error)}`, ahora);
    return { evidencia: resultado.data, aviso: null };
  } catch (error) {
    const codigo = codigoError(error);
    return sinLeer(typeof codigo === 'string' ? `error de lectura ${codigo}` : 'error de lectura', ahora);
  }
}

/**
 * Guarda la evidencia en `~/.nexakit/fabrica/evidencia.json` (carpeta `0o700`, archivo `0o600`, escritura atómica,
 * sin seguir enlaces). Rechaza una evidencia con forma inválida antes de escribir nada.
 */
export async function guardar(home: string, ev: Evidencia): Promise<void> {
  const valida = EsquemaEvidencia.safeParse(ev);
  if (!valida.success) throw new ErrorFabrica(`La evidencia no se guarda porque no es válida: ${primerProblema(valida.error)}`);
  await mkdir(path.join(home, '.nexakit'), { recursive: true, mode: 0o700 });
  const base = carpetaBase(home);
  await carpetaPropia(base, 'La evidencia');
  await escribirReemplazando(path.join(base, 'evidencia.json'), `${JSON.stringify(valida.data, null, 2)}\n`);
}
