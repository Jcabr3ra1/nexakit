import { randomBytes } from 'node:crypto';
import { closeSync, constants, lstatSync, openSync, readFileSync } from 'node:fs';
import { link, mkdir, open, rename, unlink } from 'node:fs/promises';
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

/**
 * Publica el candado de forma atómica: escribe un temporal completo y lo enlaza (`link` falla con `EEXIST` si ya hay
 * uno), de modo que nadie lee nunca un candado a medias. Sin enlaces duros, recurre a `wx`.
 */
async function publicarCandado(archivo: string, texto: string): Promise<void> {
  const temporal = `${archivo}.${randomBytes(6).toString('hex')}.tmp`;
  const fd = await open(temporal, 'wx', 0o600);
  try {
    try {
      await fd.chmod(0o600);
      await fd.writeFile(texto);
    } finally {
      await fd.close();
    }
    try {
      await link(temporal, archivo);
    } catch (error) {
      const codigo = codigoError(error);
      if (codigo !== 'EPERM' && codigo !== 'ENOTSUP' && codigo !== 'EXDEV' && codigo !== 'ENOSYS') throw error;
      const directo = await open(archivo, 'wx', 0o600);
      try {
        await directo.chmod(0o600);
        await directo.writeFile(texto);
      } finally {
        await directo.close();
      }
    }
  } finally {
    await unlink(temporal).catch(() => {});
  }
}

/** `true` si lo apartado es exactamente lo que se juzgó muerto. */
const mismoCandado = (juzgado: Inspeccion, apartado: Inspeccion | null): boolean => {
  if (apartado === null || apartado.crudo !== juzgado.crudo) return false;
  if (juzgado.datos !== null) return apartado.datos?.pid === juzgado.datos.pid && apartado.datos.fecha === juzgado.datos.fecha;
  return Date.now() - apartado.mtimeMs > GRACIA_ILEGIBLE_MS;
};

/**
 * Toma el candado global de encargos, `~/.nexakit/encargos/.candado`, publicado de forma atómica con `0o600`. Si existe
 * con un proceso vivo, lanza. Si el proceso murió (o está vacío o ilegible desde hace más de 30 s), lo aparta con un
 * `rename`, comprueba que lo apartado es justo el candado juzgado (si no, lo devuelve y falla) y lo vuelve a crear.
 */
export async function tomarCandadoEncargos(home: string): Promise<CandadoEncargos> {
  const nexakit = path.join(home, '.nexakit');
  await mkdir(nexakit, { recursive: true, mode: 0o700 });
  await carpetaPropia(nexakit, 'Los encargos');
  await carpetaPropia(path.join(nexakit, 'encargos'), 'Los encargos');
  const archivo = rutaCandado(home);
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
      const aparte = `${archivo}.${randomBytes(4).toString('hex')}.muerto`;
      try {
        await rename(archivo, aparte);
      } catch (e) {
        if (codigoError(e) === 'ENOENT') continue;
        throw e;
      }
      if (mismoCandado(juzgado, inspeccionar(aparte))) {
        await unlink(aparte).catch(() => {});
        continue;
      }
      // Otro proceso había cambiado el candado entre medias: se devuelve si el sitio sigue libre.
      await link(aparte, archivo).catch(() => {});
      await unlink(aparte).catch(() => {});
      throw new ErrorFabrica(OTRO_EN_MARCHA);
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
