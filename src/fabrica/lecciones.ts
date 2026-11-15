import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { ErrorFabrica } from './errores.js';
import { NOMBRES_ESTACION, type NombreEstacion } from './esquemas.js';
import { carpetaPropia, codigoError, escribirReemplazando, lstatSiExiste } from './rastro.js';

/** Almacén común de lecciones (`~/.nexakit/lecciones/`): lo comparten Claude, Codex, Antigravity y la fábrica. */

export const MAX_REGLA = 300;
export const MAX_PORQUE = 500;
const MAX_RUTA = 4096;

const PATRON_ID = /^[0-9a-f]{8}$/u;
const DIA_MS = 24 * 60 * 60 * 1000;
const MARCA_OMITIDO = '(texto omitido';
/** Tope de la clave de error que se guarda y se cita en una regla propuesta. */
export const MAX_CLAVE = 200;
// Caracteres de control (ESC, NUL, saltos), de formato (U+202E y otros bidireccionales, de ancho cero) y separadores
// de línea y párrafo: no tienen sitio en un texto que acabará en las instrucciones de otras IA.
const INVISIBLES = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;

/** Una sola línea, sin caracteres de control ni de formato y sin espacios sobrantes. */
export function limpiarTexto(valor: string): string {
  return valor.replace(/\s+/gu, ' ').replace(INVISIBLES, '').replace(/\s+/gu, ' ').trim();
}

/** Corta en el último límite de palabra que quepa en `maximo`; solo corta a media palabra si no hay ningún espacio. */
export function cortarEnPalabra(texto: string, maximo: number): string {
  if (texto.length <= maximo) return texto;
  const corte = texto.slice(0, maximo);
  const espacio = corte.lastIndexOf(' ');
  return (espacio > 0 && texto[maximo] !== ' ' ? corte.slice(0, espacio) : corte).trimEnd();
}

/** Texto que ya está limpio y cabe en `maximo`; `null` si no (también si queda vacío). */
function textoLimpio(valor: unknown, maximo: number): string | null {
  if (typeof valor !== 'string') return null;
  return valor !== '' && limpiarTexto(valor) === valor && valor.length <= maximo ? valor : null;
}

export type Ambito = 'global' | { proyecto: string } | { proyecto: string; estacion: NombreEstacion };
export type EstadoLeccion = 'propuesta' | 'vigente' | 'retirada';
export type OrigenLeccion = 'persona' | 'fabrica' | 'proceso';

export interface Leccion {
  id: string;
  regla: string;
  porque: string;
  ambito: Ambito;
  estado: EstadoLeccion;
  origen: OrigenLeccion;
  /** Marca de tiempo (ms) de la última vez que se registró o pasó a vigente. */
  fecha: number;
  usos: number;
  /** Clave del error repetido (`claveDeError` del mod) al que responde la lección, si la hay. */
  claveError?: string;
}

export interface DatosLeccion {
  regla: string;
  porque: string;
  /** Ámbito pedido; un proyecto puede ir como ruta relativa o con enlaces, se guarda su ruta real. */
  ambito?: Ambito;
  origen: OrigenLeccion;
  claveError?: string;
}

export interface FiltroVigentes {
  proyecto?: string;
  estacion?: NombreEstacion;
}

const ESTADOS: readonly string[] = ['propuesta', 'vigente', 'retirada'];
const ORIGENES: readonly string[] = ['persona', 'fabrica', 'proceso'];

const esObjeto = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const esEstacion = (v: unknown): v is NombreEstacion => (NOMBRES_ESTACION as readonly string[]).includes(v as string);

/** Regla sin diferencias de mayúsculas ni de espacios: dos formas de escribir lo mismo dan el mismo id. */
export function normalizarRegla(regla: string): string {
  return regla.normalize('NFC').replace(/\s+/gu, ' ').trim().toLowerCase();
}

function claveAmbito(ambito: Ambito): string {
  if (ambito === 'global') return 'global';
  return 'estacion' in ambito ? `proyecto:${ambito.proyecto}:estacion:${ambito.estacion}` : `proyecto:${ambito.proyecto}`;
}

/** Id corto y estable: 8 hex del SHA-256 de la regla normalizada más el ámbito. */
export function idLeccion(regla: string, ambito: Ambito): string {
  return createHash('sha256').update(`${normalizarRegla(regla)}\n${claveAmbito(ambito)}`, 'utf8').digest('hex').slice(0, 8);
}

function ambitoValido(valor: unknown): Ambito | null {
  if (valor === 'global') return 'global';
  if (!esObjeto(valor)) return null;
  const proyecto = textoLimpio(valor['proyecto'], MAX_RUTA);
  if (proyecto === null) return null;
  if (valor['estacion'] === undefined) return { proyecto };
  return esEstacion(valor['estacion']) ? { proyecto, estacion: valor['estacion'] } : null;
}

/** Devuelve la lección si el JSON tiene la forma esperada; `null` si no (un archivo ajeno o roto se ignora). */
function aLeccion(valor: unknown, idEsperado: string): Leccion | null {
  if (!esObjeto(valor) || valor['id'] !== idEsperado) return null;
  const ambito = ambitoValido(valor['ambito']);
  const { estado, origen, fecha, usos } = valor;
  // Lo que se lee pasa por la misma limpieza y los mismos topes que lo que se escribe: un archivo editado a mano
  // con caracteres invisibles, texto de más o sin regla no entra.
  const regla = textoLimpio(valor['regla'], MAX_REGLA);
  const porque = textoLimpio(valor['porque'], MAX_PORQUE);
  const claveError = valor['claveError'] === undefined ? undefined : textoLimpio(valor['claveError'], MAX_CLAVE);
  if (ambito === null || regla === null || porque === null || claveError === null) return null;
  if (typeof estado !== 'string' || !ESTADOS.includes(estado) || typeof origen !== 'string' || !ORIGENES.includes(origen)) return null;
  if (typeof fecha !== 'number' || !Number.isFinite(fecha) || typeof usos !== 'number' || !Number.isFinite(usos)) return null;
  const leccion: Leccion = {
    id: idEsperado,
    regla,
    porque,
    ambito,
    estado: estado as EstadoLeccion,
    origen: origen as OrigenLeccion,
    fecha,
    usos,
  };
  if (claveError !== undefined) leccion.claveError = claveError;
  return leccion;
}

const carpetaLecciones = (home: string): string => path.join(home, '.nexakit', 'lecciones');

/** Deja lista `~/.nexakit/lecciones/` (carpeta real, `0o700`) y devuelve su ruta. */
async function prepararCarpeta(home: string): Promise<string> {
  await mkdir(path.join(home, '.nexakit'), { recursive: true, mode: 0o700 });
  const dir = carpetaLecciones(home);
  await carpetaPropia(dir, 'El almacén de lecciones');
  return dir;
}

/** Lee `<id>.json` sin seguir enlaces. `null` si no existe, no es un archivo normal o no tiene la forma esperada. */
async function leerArchivo(dir: string, id: string): Promise<Leccion | null> {
  const archivo = path.join(dir, `${id}.json`);
  const info = await lstatSiExiste(archivo);
  if (info === null || !info.isFile()) return null;
  let manija;
  try {
    manija = await open(archivo, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (codigoError(error) === 'ELOOP' || codigoError(error) === 'ENOENT') return null;
    throw error;
  }
  try {
    return aLeccion(JSON.parse(await manija.readFile('utf8')) as unknown, id);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  } finally {
    await manija.close();
  }
}

async function escribirLeccion(dir: string, leccion: Leccion): Promise<void> {
  await escribirReemplazando(path.join(dir, `${leccion.id}.json`), `${JSON.stringify(leccion, null, 2)}\n`);
}

/** Todas las lecciones del almacén, de la más reciente a la más antigua. No crea nada si no hay almacén. */
export async function listar(home: string): Promise<Leccion[]> {
  const dir = carpetaLecciones(home);
  const info = await lstatSiExiste(dir);
  if (info === null || info.isSymbolicLink() || !info.isDirectory()) return [];
  const lecciones: Leccion[] = [];
  for (const nombre of await readdir(dir)) {
    const id = nombre.slice(0, -'.json'.length);
    if (!nombre.endsWith('.json') || !PATRON_ID.test(id)) continue;
    const leccion = await leerArchivo(dir, id);
    if (leccion !== null) lecciones.push(leccion);
  }
  return lecciones.sort((a, b) => b.fecha - a.fecha || a.id.localeCompare(b.id));
}

/** Guarda la ruta real de un proyecto: sin `..`, sin enlaces y sin barra final. */
async function rutaDeProyecto(ruta: string): Promise<string> {
  try {
    const real = await realpath(path.resolve(ruta));
    if ((await lstat(real)).isDirectory()) return real;
  } catch (error) {
    if (codigoError(error) !== 'ENOENT' && codigoError(error) !== 'ENOTDIR') throw error;
  }
  throw new ErrorFabrica(`El proyecto no existe o no es una carpeta: ${ruta}`);
}

async function ambitoReal(ambito: Ambito | undefined): Promise<Ambito> {
  if (ambito === undefined || ambito === 'global') return 'global';
  const valido = ambitoValido(ambito);
  if (valido === null || valido === 'global') throw new ErrorFabrica('Ámbito de la lección no válido');
  const proyecto = await rutaDeProyecto(valido.proyecto);
  if (textoLimpio(proyecto, MAX_RUTA) === null) throw new ErrorFabrica('La ruta del proyecto tiene caracteres de control o es demasiado larga');
  return 'estacion' in valido ? { proyecto, estacion: valido.estacion } : { proyecto };
}

function textoDe(valor: unknown, nombre: string, maximo: number): string {
  const texto = typeof valor === 'string' ? limpiarTexto(valor) : '';
  if (texto === '') throw new ErrorFabrica(`Falta ${nombre} de la lección`);
  if (texto.length > maximo) throw new ErrorFabrica(`${nombre[0]?.toUpperCase() ?? ''}${nombre.slice(1)} de la lección es demasiado larga: ${texto.length} caracteres, el máximo es ${maximo}`);
  return texto;
}

/**
 * Registra una lección. Las de `origen: 'persona'` nacen `vigente` y las demás `propuesta`. Registrar la misma regla
 * en el mismo ámbito no duplica: actualiza la fecha. Una retirada solo la reabre la persona (vuelve a `vigente`);
 * a una vigente o propuesta ya existente nunca le quita el estado.
 */
export async function registrar(home: string, datos: DatosLeccion, ahora: number = Date.now()): Promise<{ leccion: Leccion; nueva: boolean }> {
  const regla = textoDe(datos.regla, 'la regla', MAX_REGLA);
  const porque = textoDe(datos.porque, 'el porqué', MAX_PORQUE);
  if (!ORIGENES.includes(datos.origen)) throw new ErrorFabrica(`Origen de la lección no válido: ${String(datos.origen)}`);
  const ambito = await ambitoReal(datos.ambito);
  const id = idLeccion(regla, ambito);
  const dir = await prepararCarpeta(home);
  const previa = await leerArchivo(dir, id);
  const nuevoEstado: EstadoLeccion = datos.origen === 'persona' ? 'vigente' : 'propuesta';
  const leccion: Leccion =
    previa === null
      ? { id, regla, porque, ambito, estado: nuevoEstado, origen: datos.origen, fecha: ahora, usos: 0 }
      : { ...previa, fecha: ahora, estado: previa.estado === 'retirada' && datos.origen === 'persona' ? 'vigente' : previa.estado };
  const claveError = datos.claveError === undefined ? undefined : claveLimpia(datos.claveError);
  if (previa === null && claveError !== undefined) leccion.claveError = claveError;
  await escribirLeccion(dir, leccion);
  return { leccion, nueva: previa === null };
}

async function cambiarEstado(home: string, id: string, permitido: readonly EstadoLeccion[], nuevo: EstadoLeccion, ahora: number): Promise<Leccion> {
  if (!PATRON_ID.test(id)) throw new ErrorFabrica(`Id de lección no válido: ${id} (son 8 caracteres hexadecimales)`);
  const dir = await prepararCarpeta(home);
  const previa = await leerArchivo(dir, id);
  if (previa === null) throw new ErrorFabrica(`No existe la lección ${id}`);
  if (previa.estado === nuevo) return previa;
  if (!permitido.includes(previa.estado)) throw new ErrorFabrica(`La lección ${id} está ${previa.estado}; no se puede pasar a ${nuevo}`);
  // Al pasar a vigente la fecha pasa a ser la de la aceptación: desde ahí se mide si redujo el error.
  const leccion: Leccion = { ...previa, estado: nuevo, ...(nuevo === 'vigente' ? { fecha: ahora } : {}) };
  await escribirLeccion(dir, leccion);
  return leccion;
}

/** Acepta una propuesta: pasa a vigente. Aceptar una vigente no cambia nada. */
export function aceptar(home: string, id: string, ahora: number = Date.now()): Promise<Leccion> {
  return cambiarEstado(home, id, ['propuesta'], 'vigente', ahora);
}

/** Retira una lección (o descarta una propuesta). Se conserva en el almacén como retirada. */
export function retirar(home: string, id: string, ahora: number = Date.now()): Promise<Leccion> {
  return cambiarEstado(home, id, ['propuesta', 'vigente'], 'retirada', ahora);
}

/**
 * Lecciones vigentes. Sin filtro, todas. Con filtro, las que aplican: las globales, las del proyecto y, si se pide
 * estación, las de esa estación en ese proyecto.
 */
export async function vigentes(home: string, filtro?: FiltroVigentes): Promise<Leccion[]> {
  const todas = (await listar(home)).filter((l) => l.estado === 'vigente');
  if (filtro === undefined) return todas;
  const proyecto = filtro.proyecto === undefined ? undefined : await rutaDeProyecto(filtro.proyecto);
  return todas.filter((l) => {
    if (l.ambito === 'global') return true;
    if (proyecto === undefined || l.ambito.proyecto !== proyecto) return false;
    return !('estacion' in l.ambito) || l.ambito.estacion === filtro.estacion;
  });
}

/** Un evento del registro del mod, en la forma mínima que usa este módulo. */
export interface EventoRegistro {
  fecha: number;
  tipo: string;
  clave?: unknown;
}

export interface Propuesta {
  regla: string;
  porque: string;
  claveError: string;
  veces: number;
}

/** Clave de error limpia y acotada a `MAX_CLAVE`; `undefined` si queda vacía. */
function claveLimpia(clave: string): string | undefined {
  const limpia = cortarEnPalabra(limpiarTexto(clave), MAX_CLAVE);
  return limpia === '' ? undefined : limpia;
}

const claveDe = (e: EventoRegistro): string | null => {
  if (e.tipo !== 'repeticion' || typeof e.clave !== 'string' || e.clave.startsWith(MARCA_OMITIDO)) return null;
  return claveLimpia(e.clave) ?? null;
};

/**
 * Propuestas que salen del registro de errores repetidos del mod: cada `repeticion` ya significa que el mismo tipo de
 * error salió tres veces en una tarea. Una propuesta por clave de error; los eventos sin clave (de versiones
 * anteriores del mod) no dan ninguna.
 */
export function proponerPorRepeticion(eventos: readonly EventoRegistro[]): Propuesta[] {
  const cuenta = new Map<string, number>();
  for (const e of eventos) {
    const clave = claveDe(e);
    if (clave !== null) cuenta.set(clave, (cuenta.get(clave) ?? 0) + 1);
  }
  return [...cuenta].map(([claveError, veces]) => ({
    regla: cortarEnPalabra(limpiarTexto(`Si vuelve a salir el error «${claveError}», parar y explicar la causa raíz antes de reintentar.`), MAX_REGLA),
    porque: veces === 1 ? 'El mismo error salió tres veces seguidas en una tarea.' : `El mismo error salió tres veces seguidas en ${veces} tareas.`,
    claveError,
    veces,
  }));
}

/**
 * Guarda como propuesta las que aún no existen. No toca las que ya están, sea cual sea su estado, ni propone otra vez
 * un error que ya tiene una lección asociada (vigente, propuesta o retirada: lo que la persona decidió se respeta).
 */
export async function guardarPropuestas(home: string, propuestas: readonly Propuesta[], ahora: number = Date.now()): Promise<Leccion[]> {
  const guardadas = await listar(home);
  const ids = new Set(guardadas.map((l) => l.id));
  const claves = new Set(guardadas.flatMap((l) => (l.claveError === undefined ? [] : [l.claveError])));
  const nuevas: Leccion[] = [];
  for (const p of propuestas) {
    if (ids.has(idLeccion(p.regla, 'global')) || claves.has(p.claveError)) continue;
    const { leccion } = await registrar(home, { regla: p.regla, porque: p.porque, origen: 'proceso', claveError: p.claveError }, ahora);
    nuevas.push(leccion);
  }
  return nuevas;
}

export type Efectividad = { antes: number; despues: number } | null;

/**
 * Si la lección redujo la repetición de su error: cuenta los `repeticion` de su clave en una ventana tras su fecha y
 * en otra igual justo antes. `null` si no tiene clave de error o no hubo repeticiones antes (nada que reducir).
 */
export function efectividad(leccion: Leccion, eventos: readonly EventoRegistro[], ahora: number): Efectividad {
  if (leccion.claveError === undefined) return null;
  const ventana = Math.max(ahora - leccion.fecha, DIA_MS);
  let antes = 0;
  let despues = 0;
  for (const e of eventos) {
    if (claveDe(e) !== leccion.claveError) continue;
    if (e.fecha < leccion.fecha && e.fecha >= leccion.fecha - ventana) antes += 1;
    else if (e.fecha >= leccion.fecha && e.fecha <= ahora) despues += 1;
  }
  return antes === 0 ? null : { antes, despues };
}
