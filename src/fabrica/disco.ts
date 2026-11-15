import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, readFile, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface EntradaDisco {
  size?: number;
  mtimeMs?: number;
  kind: string;
  sha256?: string;
}
/** Mapa de ruta relativa a su huella; las claves `.git/*` fijan el estado de Git. */
export type Instantanea = Map<string, EntradaDisco>;

const digest = (valor: string | Uint8Array): string => createHash('sha256').update(valor).digest('hex');

async function git(raiz: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd: raiz,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  return stdout;
}

function codigoError(error: unknown): unknown {
  return typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
}

async function instantaneaGit(raiz: string, entradas: Instantanea): Promise<void> {
  let cima: string;
  try {
    cima = (await git(raiz, ['rev-parse', '--show-toplevel'])).trim();
  } catch {
    return;
  }
  if ((await realpath(cima)) !== (await realpath(raiz))) return;
  const poner = (nombre: string, contenido: string | Uint8Array): void => {
    entradas.set(`.git/${nombre}`, { kind: 'git', sha256: digest(contenido) });
  };
  let commit: string;
  try {
    commit = await git(raiz, ['rev-parse', '--verify', 'HEAD']);
  } catch {
    commit = 'unborn';
  }
  let simbolico: string;
  try {
    simbolico = await git(raiz, ['symbolic-ref', '-q', 'HEAD']);
  } catch {
    simbolico = 'detached';
  }
  poner('HEAD', simbolico + commit);
  poner('status', await git(raiz, ['status', '--porcelain=v1', '--ignored', '-z', '--untracked-files=all']));
  poner('refs', await git(raiz, ['for-each-ref', '--format=%(refname) %(objectname) %(symref)']));
  const indice = path.resolve(raiz, (await git(raiz, ['rev-parse', '--git-path', 'index'])).trim());
  try {
    poner('index', await readFile(indice));
  } catch (error) {
    if (codigoError(error) !== 'ENOENT') throw error;
    poner('index', 'absent');
  }
}

/** Calcula huellas de archivos, observa las entradas de dependencias y fija el estado de Git sin seguir enlaces. */
export async function instantanea(raiz: string): Promise<Instantanea> {
  const entradas: Instantanea = new Map();
  let ignorados: string[] = [];
  let seguidos = new Set<string>();
  let esRepositorio = false;
  try {
    esRepositorio =
      (await realpath((await git(raiz, ['rev-parse', '--show-toplevel'])).trim())) === (await realpath(raiz));
  } catch {
    esRepositorio = false;
  }
  if (esRepositorio) {
    ignorados = (
      await git(raiz, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'])
    )
      .split('\0')
      .filter(Boolean);
    seguidos = new Set((await git(raiz, ['ls-files', '--cached', '-z'])).split('\0').filter(Boolean));
  }
  const conHuella = (nombre: string): boolean =>
    seguidos.has(nombre) ||
    !ignorados.some((item) => (item.endsWith('/') ? nombre.startsWith(item) : nombre === item));

  async function recorrer(directorio: string, prefijo = ''): Promise<void> {
    for (const nombre of (await readdir(directorio)).sort()) {
      if (nombre === '.git') continue;
      const completa = path.join(directorio, nombre);
      const relativa = prefijo ? `${prefijo}/${nombre}` : nombre;
      const info = await lstat(completa);
      if (info.isSymbolicLink()) {
        entradas.set(relativa, {
          size: info.size,
          mtimeMs: info.mtimeMs,
          kind: 'symlink',
          sha256: digest(await readlink(completa)),
        });
      } else if (info.isDirectory()) {
        if (nombre === 'node_modules') {
          for (const hijo of (await readdir(completa)).sort()) {
            const datos = await lstat(path.join(completa, hijo));
            entradas.set(`${relativa}/${hijo}`, {
              size: datos.size,
              kind: datos.isDirectory() ? 'dependency-directory' : 'dependency-entry',
            });
          }
        } else await recorrer(completa, relativa);
      } else {
        const valor: EntradaDisco = {
          size: info.size,
          mtimeMs: info.mtimeMs,
          kind: info.isFile() ? 'file' : 'other',
        };
        if (info.isFile() && conHuella(relativa)) {
          const hash = createHash('sha256');
          const archivo = await open(completa, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
          try {
            for await (const trozo of archivo.createReadStream({ autoClose: false })) hash.update(trozo as Buffer);
          } finally {
            await archivo.close();
          }
          valor.sha256 = hash.digest('hex');
        }
        entradas.set(relativa, valor);
      }
    }
  }
  await recorrer(raiz);
  await instantaneaGit(raiz, entradas);
  return entradas;
}

/** Rutas cuya entrada difiere entre dos instantáneas, ordenadas (incluye `.git/HEAD`, `.git/index`, `.git/refs`...). */
export function comparar(antes: Instantanea, despues: Instantanea): string[] {
  return [...new Set([...antes.keys(), ...despues.keys()])]
    .filter((nombre) => {
      const a = antes.get(nombre);
      const b = despues.get(nombre);
      return (
        !a || !b || a.size !== b.size || a.mtimeMs !== b.mtimeMs || a.kind !== b.kind || a.sha256 !== b.sha256
      );
    })
    .sort();
}
