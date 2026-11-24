import { randomBytes } from 'node:crypto';
import { closeSync, constants, lstatSync, openSync, readFileSync } from 'node:fs';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
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

/** Lee el candado global de encargos sin seguir enlaces; `null` si no existe o no se entiende. */
export function leerCandado(home: string): DatosCandado | null {
  try {
    const archivo = rutaCandado(home);
    const info = lstatSync(archivo, { throwIfNoEntry: false });
    if (info === undefined || !info.isFile() || info.size > 4096) return null;
    const fd = openSync(archivo, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const dato: unknown = JSON.parse(readFileSync(fd, 'utf8'));
      if (typeof dato !== 'object' || dato === null) return null;
      const { pid, id, fecha } = dato as { pid?: unknown; id?: unknown; fecha?: unknown };
      if (typeof pid !== 'number') return null;
      return { pid, id: typeof id === 'string' ? id : null, fecha: typeof fecha === 'string' ? fecha : '' };
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
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

/**
 * Toma el candado global de encargos, `~/.nexakit/encargos/.candado`, creado con `wx` y `0o600`. Si existe con un
 * proceso vivo, lanza. Si el proceso murió, lo aparta con un `rename` (atómico: solo uno de dos procesos que compiten
 * lo consigue) y lo vuelve a crear.
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
      const fd = await open(archivo, 'wx', 0o600);
      try {
        await fd.chmod(0o600);
        await fd.writeFile(contenido(datos));
      } finally {
        await fd.close();
      }
      tomado = true;
    } catch (error) {
      if (codigoError(error) !== 'EEXIST') throw error;
      const vivo = encargoVivo(home);
      if (vivo !== null) {
        throw new ErrorFabrica(`Ya hay un encargo en curso (${vivo.id ?? 'preparándose'}, proceso ${vivo.pid}); espera a que termine o cancélalo`);
      }
      // Muerto o ilegible: se aparta (rename atómico) y se reintenta.
      const aparte = `${archivo}.${randomBytes(4).toString('hex')}.muerto`;
      try {
        await rename(archivo, aparte);
        await unlink(aparte).catch(() => {});
      } catch (e) {
        if (codigoError(e) !== 'ENOENT') throw e;
      }
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
