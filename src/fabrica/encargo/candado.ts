import { randomBytes } from 'node:crypto';
import { closeSync, constants, lstatSync, openSync, readFileSync } from 'node:fs';
import { link, mkdir, open, readdir, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { ErrorFabrica } from '../errores.js';
import { carpetaPropia, codigoError, escribirReemplazando } from '../rastro.js';

/** `true` si el proceso `pid` sigue vivo (también cuando existe pero no se puede señalar). */
export function procesoVivo(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return codigoError(error) === 'EPERM';
  }
}

export interface DatosCandado {
  pid: number;
  /** Id del encargo; `null` hasta que existe su worktree. */
  id: string | null;
  fecha: string;
}

const rutaCandado = (home: string): string => path.join(home, '.nexakit', 'encargos', '.candado');

interface Inspeccion {
  /** Texto tal cual; `null` si no es un archivo normal o es demasiado grande. */
  crudo: string | null;
  datos: DatosCandado | null;
  mtimeMs: number;
}

/** Lee un archivo de candado sin seguir enlaces; `null` si no existe. */
function inspeccionar(archivo: string): Inspeccion | null {
  try {
    const info = lstatSync(archivo, { throwIfNoEntry: false });
    if (info === undefined) return null;
    const ilegible: Inspeccion = { crudo: null, datos: null, mtimeMs: info.mtimeMs };
    if (!info.isFile() || info.size > 4096) return ilegible;
    const fd = openSync(archivo, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const crudo = readFileSync(fd, 'utf8');
      let datos: DatosCandado | null = null;
      try {
        const dato: unknown = JSON.parse(crudo);
        if (typeof dato === 'object' && dato !== null) {
          const { pid, id, fecha } = dato as { pid?: unknown; id?: unknown; fecha?: unknown };
          if (typeof pid === 'number') datos = { pid, id: typeof id === 'string' ? id : null, fecha: typeof fecha === 'string' ? fecha : '' };
        }
      } catch {
        datos = null;
      }
      return { crudo, datos, mtimeMs: info.mtimeMs };
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

/** Lee el candado global de encargos sin seguir enlaces; `null` si no existe o no se entiende. */
export function leerCandado(home: string): DatosCandado | null {
  return inspeccionar(rutaCandado(home))?.datos ?? null;
}

/** El encargo vivo que tiene el candado (de este u otro proceso), o `null`. */
export function encargoVivo(home: string): DatosCandado | null {
  const dato = leerCandado(home);
  return dato !== null && procesoVivo(dato.pid) ? dato : null;
}

/** Lanza si hay un encargo vivo: los recorridos de la fábrica no arrancan mientras tanto. */
export function exigirSinEncargo(home: string): void {
  const vivo = encargoVivo(home);
  if (vivo !== null) {
    throw new ErrorFabrica(`Ya hay un encargo en curso (${vivo.id ?? 'preparándose'}, proceso ${vivo.pid}); espera a que termine o cancélalo`);
  }
}

export interface CandadoEncargos {
  /** Anota el id del encargo en cuanto existe su worktree. */
  asignarId(id: string): Promise<void>;
  /** Lo libera, pero solo si sigue siendo de este proceso. */
  liberar(): Promise<void>;
}

const contenido = (datos: DatosCandado): string => `${JSON.stringify(datos)}\n`;

/** Un candado vacío o ilegible solo se da por muerto pasado este tiempo: puede estar escribiéndose. */
export const GRACIA_ILEGIBLE_MS = 30_000;

const OTRO_EN_MARCHA = 'Hay otro encargo en marcha; vuelve a intentarlo en unos segundos';

type OperacionLink = (existente: string, nuevo: string) => Promise<void>;

/** Escribe `texto` en un archivo nuevo (`wx`, `0o600`); falla con `EEXIST` si ya existe. */
async function crearExclusivo(archivo: string, texto: string): Promise<void> {
  const fd = await open(archivo, 'wx', 0o600);
  try {
    await fd.chmod(0o600);
    await fd.writeFile(texto);
  } finally {
    await fd.close();
  }
}

/**
 * Enlaza el temporal ya escrito con el nombre del candado (`link` falla con `EEXIST` si ya hay uno). Ante cualquier otro
 * error de `link` (sin enlaces duros: `EPERM`, `ENOTSUP`, `EXDEV`, `ENOSYS`, FAT, red, Windows...) recurre a `wx`.
 */
async function enlazarOCrear(temporal: string, archivo: string, texto: string, enlazar: OperacionLink): Promise<void> {
  try {
    await enlazar(temporal, archivo);
  } catch (error) {
    if (codigoError(error) === 'EEXIST') throw error;
    await crearExclusivo(archivo, texto);
  }
}

/**
 * Publica el candado de forma atómica: escribe un temporal completo y lo enlaza, de modo que nadie lee nunca un candado
 * a medias. `enlazar` solo se inyecta en pruebas.
 */
export async function publicarCandado(archivo: string, texto: string, enlazar: OperacionLink = link): Promise<void> {
  const temporal = `${archivo}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await crearExclusivo(temporal, texto);
    await enlazarOCrear(temporal, archivo, texto, enlazar);
  } finally {
    await unlink(temporal).catch(() => {});
  }
}

/** `true` si lo inspeccionado ahora es exactamente lo que se juzgó muerto. */
const mismoCandado = (juzgado: Inspeccion, actual: Inspeccion | null): boolean => {
  if (actual === null || actual.crudo !== juzgado.crudo) return false;
  if (juzgado.datos !== null) return actual.datos?.pid === juzgado.datos.pid && actual.datos.fecha === juzgado.datos.fecha;
  return Date.now() - actual.mtimeMs > GRACIA_ILEGIBLE_MS;
};

/** Borra una entrada sin seguir enlaces: un enlace simbólico se quita a sí mismo, un directorio vacío se quita con `rmdir`. */
async function quitarSinSeguir(ruta: string): Promise<void> {
  const info = lstatSync(ruta, { throwIfNoEntry: false });
  if (info === undefined) return;
  if (info.isDirectory()) await rmdir(ruta);
  else await unlink(ruta);
}

/** Borra los temporales (`.candado.*.tmp`, `.candado.*.muerto`) con más de 30 s: restos de un proceso que murió a medias. */
async function limpiarTemporales(carpeta: string): Promise<void> {
  let nombres: string[];
  try {
    nombres = await readdir(carpeta);
  } catch {
    return;
  }
  for (const nombre of nombres) {
    if (!/^\.candado\..+\.(?:tmp|muerto)$/u.test(nombre)) continue;
    const ruta = path.join(carpeta, nombre);
    try {
      const info = lstatSync(ruta, { throwIfNoEntry: false });
      if (info === undefined || info.isDirectory() || Date.now() - info.mtimeMs <= GRACIA_ILEGIBLE_MS) continue;
      await unlink(ruta);
    } catch {
      // Otro proceso lo borró antes o no se puede: se deja.
    }
  }
}

/** Opciones internas, solo para pruebas. */
export interface OpcionesCandado {
  /** Se ejecuta con el candado auxiliar de robo ya tomado y antes de volver a inspeccionar `.candado`. */
  alAntesDeRobar?: () => void | Promise<void>;
}

/**
 * Roba un candado juzgado muerto. Solo quien crea el directorio auxiliar `.candado.robo` (con `mkdir`, atómico) puede
 * robar; dentro vuelve a inspeccionar `.candado` y, si sigue siendo exactamente el juzgado, lo borra y publica el suyo.
 * Devuelve `true` si lo tomó y `false` si hay que volver a juzgar. Si no puede, lanza «Hay otro encargo en marcha».
 */
async function robarCandado(archivo: string, juzgado: Inspeccion, texto: string, opciones: OpcionesCandado): Promise<boolean> {
  const robo = `${archivo}.robo`;
  try {
    await mkdir(robo, { mode: 0o700 });
  } catch (error) {
    const codigo = codigoError(error);
    if (codigo === 'ENOENT') return false;
    if (codigo !== 'EEXIST') throw error;
    const info = lstatSync(robo, { throwIfNoEntry: false });
    if (info === undefined) return false;
    if (Date.now() - info.mtimeMs <= GRACIA_ILEGIBLE_MS) throw new ErrorFabrica(OTRO_EN_MARCHA);
    // Auxiliar abandonado por un proceso que murió a medias: se borra y se vuelve a intentar.
    await quitarSinSeguir(robo).catch(() => {});
    return false;
  }
  try {
    await opciones.alAntesDeRobar?.();
    const actual = inspeccionar(archivo);
    if (actual === null) return false;
    if (!mismoCandado(juzgado, actual)) throw new ErrorFabrica(OTRO_EN_MARCHA);
    await quitarSinSeguir(archivo);
    try {
      await publicarCandado(archivo, texto);
    } catch (error) {
      if (codigoError(error) === 'EEXIST') return false;
      throw error;
    }
    return true;
  } finally {
    await rmdir(robo).catch(() => {});
  }
}

/**
 * Toma el candado global de encargos, `~/.nexakit/encargos/.candado`, publicado de forma atómica con `0o600`. Si existe
 * con un proceso vivo, lanza. Si el proceso murió (o está vacío o ilegible desde hace más de 30 s), lo roba con un
 * candado auxiliar creado con `mkdir` (`.candado.robo`): dentro vuelve a comprobar que sigue siendo el candado juzgado
 * (si no, se rinde) y lo sustituye por el suyo. Antes borra los temporales con más de 30 s.
 */
export async function tomarCandadoEncargos(home: string, opciones: OpcionesCandado = {}): Promise<CandadoEncargos> {
  const nexakit = path.join(home, '.nexakit');
  await mkdir(nexakit, { recursive: true, mode: 0o700 });
  await carpetaPropia(nexakit, 'Los encargos');
  await carpetaPropia(path.join(nexakit, 'encargos'), 'Los encargos');
  const archivo = rutaCandado(home);
  await limpiarTemporales(path.dirname(archivo));
  const datos: DatosCandado = { pid: process.pid, id: null, fecha: new Date().toISOString() };
  let tomado = false;
  for (let intento = 0; intento < 5 && !tomado; intento += 1) {
    try {
      await publicarCandado(archivo, contenido(datos));
      tomado = true;
    } catch (error) {
      if (codigoError(error) !== 'EEXIST') throw error;
      const juzgado = inspeccionar(archivo);
      if (juzgado === null) continue;
      if (juzgado.datos !== null && procesoVivo(juzgado.datos.pid)) {
        throw new ErrorFabrica(`Ya hay un encargo en curso (${juzgado.datos.id ?? 'preparándose'}, proceso ${juzgado.datos.pid}); espera a que termine o cancélalo`);
      }
      if (juzgado.datos === null && Date.now() - juzgado.mtimeMs <= GRACIA_ILEGIBLE_MS) throw new ErrorFabrica(OTRO_EN_MARCHA);
      tomado = await robarCandado(archivo, juzgado, contenido(datos), opciones);
    }
  }
  if (!tomado) throw new ErrorFabrica('No se pudo tomar el candado de encargos; vuelve a intentarlo');
  return {
    async asignarId(id: string): Promise<void> {
      if (leerCandado(home)?.pid === process.pid) await escribirReemplazando(archivo, contenido({ ...datos, id }));
    },
    async liberar(): Promise<void> {
      if (leerCandado(home)?.pid !== process.pid) return;
      await unlink(archivo).catch(() => {});
    },
  };
}
