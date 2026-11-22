import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { prefijoRepoTemporal } from '../banco/ejecutar.js';
import { ErrorFabrica } from '../errores.js';
import { carpetaPropia, codigoError } from '../rastro.js';

const MAX_BUFFER = 64 * 1024 * 1024;

/** Worktree aislado donde una IA programa un encargo. */
export interface Worktree {
  /** Id aleatorio y neutro; es la carpeta de `~/.nexakit/encargos/`. */
  id: string;
  /** Carpeta del worktree: `~/.nexakit/encargos/<id>/repo`. */
  dir: string;
  /** Commit de HEAD del que parte el encargo. */
  base: string;
  /** Repo real del que sale el worktree (nunca se escribe en él). */
  raiz: string;
  /** Lo que conviene saber (por ejemplo, cambios sin commit que no se copian). */
  avisos: string[];
}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-c', 'core.quotepath=off', '-c', 'color.ui=false', '-c', 'core.autocrlf=false', ...args],
      { cwd, encoding: 'utf8', maxBuffer: MAX_BUFFER, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          const motivo = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'no se encontró git en el PATH' : String(stderr).trim();
          reject(new ErrorFabrica(`git ${args[0] ?? ''} falló: ${motivo}`, { cause: error }));
        } else resolve(stdout);
      },
    );
  });
}

const mensajeDe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Crea un worktree desacoplado de HEAD en `~/.nexakit/encargos/<id>/repo` (carpetas `0o700`, sin seguir enlaces).
 * El encargo parte de HEAD: si el árbol de la persona tiene cambios sin commit, se avisa y no se copian.
 */
export async function crearWorktree(raiz: string, home: string): Promise<Worktree> {
  const base = (await git(raiz, ['rev-parse', '--verify', 'HEAD'])).trim();
  const avisos: string[] = [];
  if ((await git(raiz, ['status', '--porcelain', '-z'])).length > 0) {
    avisos.push('El árbol tiene cambios sin commit: el encargo parte de HEAD y no los incluye.');
  }

  const nexakit = path.join(home, '.nexakit');
  await mkdir(nexakit, { recursive: true, mode: 0o700 });
  await carpetaPropia(nexakit, 'Los encargos');
  const encargos = path.join(nexakit, 'encargos');
  await carpetaPropia(encargos, 'Los encargos');

  for (let intento = 0; intento < 16; intento += 1) {
    const id = `${prefijoRepoTemporal()}${randomBytes(3).toString('hex')}`;
    const carpeta = path.join(encargos, id);
    try {
      await mkdir(carpeta, { mode: 0o700 });
    } catch (error) {
      if (codigoError(error) === 'EEXIST') continue;
      throw error;
    }
    await chmod(carpeta, 0o700);
    const dir = path.join(carpeta, 'repo');
    try {
      await git(raiz, ['worktree', 'add', '--detach', '--quiet', dir, base]);
      await chmod(dir, 0o700);
    } catch (error) {
      await git(raiz, ['worktree', 'prune']).catch(() => {});
      await rm(carpeta, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
    return { id, dir, base, raiz, avisos };
  }
  throw new ErrorFabrica('No se pudo reservar un id libre para el encargo');
}

/**
 * Diff del worktree contra su base, con los archivos nuevos (`git add -N`) y los binarios (`--binary`), listo para
 * `git apply`. Devuelve el texto vacío si no hubo cambios.
 */
export async function diffDelWorktree(w: Worktree): Promise<string> {
  try {
    await git(w.dir, ['add', '-N', '--all', '--', '.']);
    return await git(w.dir, ['diff', '--binary', '--no-ext-diff', '--no-textconv', '--no-color', '--src-prefix=a/', '--dst-prefix=b/', w.base, '--']);
  } catch (error) {
    throw new ErrorFabrica(`No se pudo leer el diff del encargo: ${mensajeDe(error)}`, { cause: error });
  }
}

/**
 * Quita el worktree y limpia el registro de git. Nunca lanza: si algo falla, devuelve el aviso (y `null` si todo fue bien).
 */
export async function borrarWorktree(w: Worktree): Promise<string | null> {
  const fallos: string[] = [];
  try {
    await git(w.raiz, ['worktree', 'remove', '--force', w.dir]);
  } catch {
    // Si git no puede quitarlo (carpeta ya borrada, bloqueo...), se borra la carpeta y `prune` limpia el registro.
    await rm(w.dir, { recursive: true, force: true }).catch((e: unknown) => {
      fallos.push(mensajeDe(e));
    });
  }
  try {
    await git(w.raiz, ['worktree', 'prune']);
  } catch (error) {
    fallos.push(mensajeDe(error));
  }
  return fallos.length === 0 ? null : `No se pudo borrar bien el worktree ${w.dir} (${fallos.join('; ')}); revisa con «git worktree list» y bórralo a mano.`;
}
