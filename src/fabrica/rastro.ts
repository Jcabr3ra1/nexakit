import { createHash, randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, open, readdir, realpath, rename, rm, unlink } from 'node:fs/promises';
import { constants, closeSync, lstatSync, openSync, readdirSync, readFileSync, type Stats } from 'node:fs';
import path from 'node:path';
import type { Encargo, ResultadoEstacion } from './conectores/tipos.js';
import type { Recorrido } from './enrutador.js';
import { ErrorFabrica } from './errores.js';
import type { EstadoEstacionEjecucion } from './ejecutor.js';
import { NOMBRES_ESTACION, type IA, type NombreEstacion } from './esquemas.js';

/** Días que se conserva un rastro antes de que `podar` lo borre. */
export const DIAS_RASTRO = 90;

const PATRON_ID = /^fab-\d{8}-\d{4}-[0-9a-f]{4}$/u;
const PATRON_REPO = /^[A-Za-z0-9._-]+$/u;
const DIA_MS = 24 * 60 * 60 * 1000;

/** Encargo tal como queda en el rastro: sin el texto del diff, solo su huella. */
export type EncargoRastro = Encargo & { diffSha256: string };

function codigoError(error: unknown): unknown {
  return typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
}

async function lstatSiExiste(ruta: string): Promise<Stats | null> {
  try {
    return await lstat(ruta);
  } catch (error) {
    if (codigoError(error) === 'ENOENT') return null;
    throw error;
  }
}

const dos = (n: number): string => String(n).padStart(2, '0');

/** Id del recorrido: `fab-AAAAMMDD-HHMM-<4 hex>`, con la hora local. */
export function nuevoId(fecha: Date = new Date()): string {
  const dia = `${fecha.getFullYear()}${dos(fecha.getMonth() + 1)}${dos(fecha.getDate())}`;
  const hora = `${dos(fecha.getHours())}${dos(fecha.getMinutes())}`;
  return `fab-${dia}-${hora}-${randomBytes(2).toString('hex')}`;
}

/** Nombre seguro de la carpeta del repo: su nombre saneado más 8 hex del SHA-256 de la ruta real. */
export async function nombreRepo(raiz: string): Promise<string> {
  const real = await realpath(raiz);
  const saneado = path
    .basename(real)
    .replace(/[^A-Za-z0-9._-]+/gu, '_')
    .replace(/^\.+/u, '')
    .slice(0, 48);
  const huella = createHash('sha256').update(real, 'utf8').digest('hex').slice(0, 8);
  return `${saneado || 'repo'}-${huella}`;
}

/** Crea la carpeta con `0o700` o comprueba que la que hay es una carpeta real, no un enlace. */
async function carpetaPropia(ruta: string): Promise<void> {
  let info = await lstatSiExiste(ruta);
  if (info === null) {
    try {
      await mkdir(ruta, { mode: 0o700 });
    } catch (error) {
      if (codigoError(error) !== 'EEXIST') throw error;
    }
    info = await lstat(ruta);
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new ErrorFabrica(`El rastro no sigue enlaces: ${ruta} no es una carpeta real`);
  }
  await chmod(ruta, 0o700);
}

/** Escribe un archivo nuevo con `0o600`; `wx` falla si ya existe algo ahí, también un enlace. */
async function escribirNuevo(ruta: string, texto: string): Promise<void> {
  const archivo = await open(ruta, 'wx', 0o600);
  try {
    await archivo.chmod(0o600);
    await archivo.writeFile(texto, 'utf8');
  } finally {
    await archivo.close();
  }
}

/** Reemplaza un archivo de forma atómica: temporal nuevo y `rename`, que no sigue enlaces. */
async function escribirReemplazando(ruta: string, texto: string): Promise<void> {
  const temporal = path.join(path.dirname(ruta), `.${path.basename(ruta)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await escribirNuevo(temporal, texto);
    await rename(temporal, ruta);
  } catch (error) {
    await unlink(temporal).catch(() => {});
    throw error;
  }
}

const json = (valor: unknown): string => `${JSON.stringify(valor, null, 2)}\n`;

/** Deja lista `~/.nexakit/fabrica/` y devuelve su ruta. */
async function prepararBase(home: string): Promise<string> {
  const nexakit = path.join(home, '.nexakit');
  await mkdir(nexakit, { recursive: true, mode: 0o700 });
  const base = path.join(nexakit, 'fabrica');
  await carpetaPropia(base);
  return base;
}

/** Valida el nombre del repo y deja listas `~/.nexakit/fabrica/` y `~/.nexakit/fabrica/<repo>/`. */
async function prepararCarpetaRepo(home: string, repo: string): Promise<string> {
  if (!PATRON_REPO.test(repo) || repo === '.' || repo === '..') {
    throw new ErrorFabrica(`Nombre de repo no válido para el rastro: ${repo}`);
  }
  const base = await prepararBase(home);
  const dirRepo = path.join(base, repo);
  await carpetaPropia(dirRepo);
  return dirRepo;
}

/** Crea `~/.nexakit/fabrica/<repo>/<id>/` con `recorrido.json`. */
export async function crear(home: string, repo: string, r: Recorrido): Promise<{ id: string; dir: string }> {
  const dirRepo = await prepararCarpetaRepo(home, repo);

  for (let intento = 0; intento < 16; intento += 1) {
    const id = nuevoId();
    const dir = path.join(dirRepo, id);
    try {
      await mkdir(dir, { mode: 0o700 });
    } catch (error) {
      if (codigoError(error) === 'EEXIST') continue;
      throw error;
    }
    await chmod(dir, 0o700);
    await escribirNuevo(path.join(dir, 'recorrido.json'), json(r));
    return { id, dir };
  }
  throw new ErrorFabrica('No se pudo reservar un id libre para el rastro');
}

/** Guarda la última propuesta del repo en `~/.nexakit/fabrica/<repo>/propuesta.json`. Devuelve la ruta. */
export async function guardarPropuesta(home: string, repo: string, r: Recorrido): Promise<string> {
  const ruta = path.join(await prepararCarpetaRepo(home, repo), 'propuesta.json');
  await escribirReemplazando(ruta, json(r));
  return ruta;
}

/**
 * Lee `propuesta.json` del repo, sin seguir enlaces. `null` si no existe o no es un archivo normal;
 * si el JSON no se puede leer, lanza.
 */
export function leerPropuesta(home: string, repo: string): unknown {
  if (!PATRON_REPO.test(repo) || repo === '.' || repo === '..') return null;
  const base = path.join(home, '.nexakit', 'fabrica');
  for (const carpeta of [base, path.join(base, repo)]) {
    const info = lstatSync(carpeta, { throwIfNoEntry: false });
    if (info === undefined || !info.isDirectory() || info.isSymbolicLink()) return null;
  }
  const archivo = path.join(base, repo, 'propuesta.json');
  const info = lstatSync(archivo, { throwIfNoEntry: false });
  if (info === undefined || !info.isFile()) return null;
  const fd = openSync(archivo, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    return JSON.parse(readFileSync(fd, 'utf8')) as unknown;
  } finally {
    closeSync(fd);
  }
}

/** Estado vivo de una estación del recorrido en curso, tal como lo muestra la barra. */
export interface EstacionActiva {
  estacion: NombreEstacion;
  ia: IA | null;
  modelo: string | null;
  esfuerzo: string | null;
  estado: EstadoEstacionEjecucion;
  tokens: number;
}

/** Contenido de `~/.nexakit/fabrica/activo.json`: el recorrido que corre ahora en ese proceso. */
export interface Activo {
  pid: number;
  id: string;
  repo: string;
  /** Hora de la escritura, en ISO 8601. */
  actualizado: string;
  estaciones: EstacionActiva[];
}

/**
 * Lee `activo.json` sin seguir enlaces. `null` si no existe, no es un archivo normal o no se entiende:
 * es un dato de cortesía para la barra, nunca debe hacer fallar a nadie.
 */
export function leerActivo(home: string): Activo | null {
  try {
    const base = path.join(home, '.nexakit', 'fabrica');
    const carpeta = lstatSync(base, { throwIfNoEntry: false });
    if (carpeta === undefined || !carpeta.isDirectory() || carpeta.isSymbolicLink()) return null;
    const archivo = path.join(base, 'activo.json');
    const info = lstatSync(archivo, { throwIfNoEntry: false });
    if (info === undefined || !info.isFile()) return null;
    const fd = openSync(archivo, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const valor: unknown = JSON.parse(readFileSync(fd, 'utf8'));
      if (typeof valor !== 'object' || valor === null || typeof (valor as { pid?: unknown }).pid !== 'number') return null;
      return valor as Activo;
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

/**
 * Publica el estado vivo en `~/.nexakit/fabrica/activo.json` (escritura atómica, `0o600`, sin seguir enlaces).
 * Con `null` lo borra, pero solo si es de este proceso: el de otro `pid` no se toca.
 */
export async function guardarActivo(home: string, activo: Activo | null): Promise<void> {
  if (activo !== null) {
    await escribirReemplazando(path.join(await prepararBase(home), 'activo.json'), json(activo));
    return;
  }
  const actual = leerActivo(home);
  if (actual === null || actual.pid !== process.pid) return;
  try {
    // `unlink` quita el archivo o el enlace mismo, nunca su destino.
    await unlink(path.join(home, '.nexakit', 'fabrica', 'activo.json'));
  } catch (error) {
    if (codigoError(error) !== 'ENOENT') throw error;
  }
}

/** Guarda `<estacion>.json` con el encargo (sin el diff) y el resultado. */
export async function guardarEstacion(
  dir: string,
  estacion: NombreEstacion,
  encargo: EncargoRastro,
  resultado: ResultadoEstacion,
): Promise<void> {
  if (!(NOMBRES_ESTACION as readonly string[]).includes(estacion)) {
    throw new ErrorFabrica(`Estación desconocida en el rastro: ${estacion}`);
  }
  await escribirNuevo(path.join(dir, `${estacion}.json`), json({ estacion, encargo, resultado }));
}

/** Reescribe `estado.json` con el estado actual del recorrido. */
export async function guardarEstado(dir: string, estado: unknown): Promise<void> {
  await escribirReemplazando(path.join(dir, 'estado.json'), json(estado));
}

/** Lee `<estacion>.json` de un recorrido, sin seguir enlaces. `null` si no existe o no es un archivo normal. */
export function leerEstacion(dir: string, estacion: NombreEstacion): { encargo?: EncargoRastro; resultado?: ResultadoEstacion } | null {
  if (!(NOMBRES_ESTACION as readonly string[]).includes(estacion)) return null;
  const archivo = path.join(dir, `${estacion}.json`);
  const info = lstatSync(archivo, { throwIfNoEntry: false });
  if (info === undefined || !info.isFile()) return null;
  const fd = openSync(archivo, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const dato = JSON.parse(readFileSync(fd, 'utf8')) as unknown;
    return typeof dato === 'object' && dato !== null ? (dato as { encargo?: EncargoRastro; resultado?: ResultadoEstacion }) : null;
  } finally {
    closeSync(fd);
  }
}

/** JSON de un archivo del recorrido, sin seguir enlaces. `null` si no existe o no es un archivo normal; lanza si no es JSON. */
function leerJsonDelRecorrido(dir: string, nombre: string): unknown {
  const archivo = path.join(dir, nombre);
  const info = lstatSync(archivo, { throwIfNoEntry: false });
  if (info === undefined || !info.isFile()) return null;
  const fd = openSync(archivo, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    return JSON.parse(readFileSync(fd, 'utf8')) as unknown;
  } finally {
    closeSync(fd);
  }
}

/** Lee `recorrido.json` de un recorrido, sin seguir enlaces. `null` si no existe. */
export function leerRecorrido(dir: string): unknown {
  return leerJsonDelRecorrido(dir, 'recorrido.json');
}

/** Guarda en `claude.json` los hallazgos que la sesión de Claude aportó al recorrido (`0o600`, sin seguir enlaces). */
export async function guardarHallazgosClaude(dir: string, hallazgos: unknown): Promise<void> {
  const ruta = path.join(dir, 'claude.json');
  if (lstatSync(ruta, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new ErrorFabrica('El rastro no sigue enlaces: claude.json es un enlace');
  }
  await escribirReemplazando(ruta, json(hallazgos));
}

/** Lee `claude.json`, sin seguir enlaces. `null` si no existe; lanza si no es JSON. */
export function leerHallazgosClaude(dir: string): unknown {
  return leerJsonDelRecorrido(dir, 'claude.json');
}

/** Guarda `consolidado.md` con `0o600`, con un temporal y `rename` para no seguir enlaces. Devuelve la ruta. */
export async function guardarConsolidado(dir: string, texto: string): Promise<string> {
  const ruta = path.join(dir, 'consolidado.md');
  if (lstatSync(ruta, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new ErrorFabrica('El rastro no sigue enlaces: consolidado.md es un enlace');
  }
  await escribirReemplazando(ruta, texto);
  return ruta;
}

/**
 * Lee `estado.json` del recorrido `id` en cualquier repo del rastro, sin seguir enlaces.
 * Devuelve `null` si el id no tiene la forma esperada o no hay estado guardado.
 */
export function leerEstado(home: string, id: string): unknown {
  if (!PATRON_ID.test(id)) return null;
  const base = path.join(home, '.nexakit', 'fabrica');
  const carpetaReal = (ruta: string): boolean => {
    const info = lstatSync(ruta, { throwIfNoEntry: false });
    return info !== undefined && info.isDirectory() && !info.isSymbolicLink();
  };
  if (!carpetaReal(base)) return null;
  for (const repo of readdirSync(base).sort()) {
    const dir = path.join(base, repo, id);
    if (!carpetaReal(path.join(base, repo)) || !carpetaReal(dir)) continue;
    const archivo = path.join(dir, 'estado.json');
    const info = lstatSync(archivo, { throwIfNoEntry: false });
    if (info === undefined || !info.isFile()) continue;
    const fd = openSync(archivo, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      return JSON.parse(readFileSync(fd, 'utf8')) as unknown;
    } finally {
      closeSync(fd);
    }
  }
  return null;
}

/**
 * Borra los rastros sin actividad en los últimos `dias`. Nunca sigue enlaces: una
 * carpeta de repo o de recorrido que sea un enlace se deja tal cual. Devuelve los ids borrados.
 */
export async function podar(home: string, dias: number = DIAS_RASTRO): Promise<string[]> {
  if (!Number.isFinite(dias) || dias <= 0) throw new ErrorFabrica('Los días de poda deben ser un número positivo');
  const base = path.join(home, '.nexakit', 'fabrica');
  const infoBase = await lstatSiExiste(base);
  if (infoBase === null || infoBase.isSymbolicLink() || !infoBase.isDirectory()) return [];
  const limite = Date.now() - dias * DIA_MS;
  const borrados: string[] = [];
  for (const repo of (await readdir(base)).sort()) {
    const dirRepo = path.join(base, repo);
    const infoRepo = await lstatSiExiste(dirRepo);
    if (infoRepo === null || infoRepo.isSymbolicLink() || !infoRepo.isDirectory()) continue;
    for (const id of (await readdir(dirRepo)).sort()) {
      if (!PATRON_ID.test(id)) continue;
      const dir = path.join(dirRepo, id);
      const info = await lstatSiExiste(dir);
      if (info === null || info.isSymbolicLink() || !info.isDirectory()) continue;
      if (info.mtimeMs >= limite) continue;
      // `rm` borra los enlaces de dentro sin seguirlos.
      await rm(dir, { recursive: true, force: true });
      borrados.push(id);
    }
  }
  return borrados;
}
