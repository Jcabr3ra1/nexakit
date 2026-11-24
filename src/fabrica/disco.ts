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

/** Tope de entradas por carpeta de Git vigilada (`hooks`, `info`): si `core.hooksPath` apunta a algo enorme, se corta. */
const MAX_ENTRADAS_GIT = 2_000;

/** Huella de un archivo regular sin seguir enlaces (`O_NOFOLLOW`), o `undefined` si no es un archivo regular. */
async function huellaArchivo(ruta: string): Promise<string | undefined> {
  let info;
  try {
    info = await lstat(ruta);
  } catch (error) {
    if (codigoError(error) === 'ENOENT') return undefined;
    throw error;
  }
  if (!info.isFile()) return undefined;
  const hash = createHash('sha256');
  const archivo = await open(ruta, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    for await (const trozo of archivo.createReadStream({ autoClose: false })) hash.update(trozo as Buffer);
  } finally {
    await archivo.close();
  }
  return hash.digest('hex');
}

/**
 * Recorre una carpeta de metadatos de Git (`hooks`, `info`) sin seguir enlaces: cada archivo con su contenido y su modo
 * (un hook que pasa a ejecutable cuenta), cada enlace con su destino. Una carpeta ausente queda como `absent`.
 */
async function recorrerCarpetaGit(carpeta: string, clave: string, entradas: Instantanea): Promise<void> {
  let raizInfo;
  try {
    raizInfo = await lstat(carpeta);
  } catch (error) {
    if (codigoError(error) !== 'ENOENT') throw error;
    entradas.set(clave, { kind: 'git', sha256: digest('absent') });
    return;
  }
  if (!raizInfo.isDirectory()) {
    const destino = raizInfo.isSymbolicLink() ? await readlink(carpeta) : '';
    entradas.set(clave, { kind: raizInfo.isSymbolicLink() ? 'git-symlink' : 'git-other', sha256: digest(destino) });
    return;
  }
  let contadas = 0;
  const pendientes: Array<[string, string]> = [[carpeta, clave]];
  while (pendientes.length > 0) {
    const [directorio, prefijo] = pendientes.shift() as [string, string];
    for (const nombre of (await readdir(directorio)).sort()) {
      contadas += 1;
      if (contadas > MAX_ENTRADAS_GIT) {
        entradas.set(`${clave}/…`, { kind: 'git-truncated' });
        return;
      }
      const completa = path.join(directorio, nombre);
      const relativa = `${prefijo}/${nombre}`;
      const info = await lstat(completa);
      if (info.isSymbolicLink()) {
        entradas.set(relativa, { kind: 'git-symlink', sha256: digest(await readlink(completa)) });
      } else if (info.isDirectory()) {
        entradas.set(relativa, { kind: 'git-directory' });
        pendientes.push([completa, relativa]);
      } else if (info.isFile()) {
        entradas.set(relativa, { size: info.size, kind: `git-file-${(info.mode & 0o777).toString(8)}`, sha256: await huellaArchivo(completa) });
      } else {
        entradas.set(relativa, { kind: 'git-other' });
      }
    }
  }
}

/**
 * Fija la configuración de Git que ejecuta código fuera de cualquier sandbox: `config` (y `config.worktree`), los hooks
 * (los de `core.hooksPath` y los de la carpeta común) y `info/` (`exclude`, `attributes`, `sparse-checkout`...).
 */
async function instantaneaConfigGit(raiz: string, entradas: Instantanea): Promise<void> {
  const rutaGit = async (nombre: string): Promise<string> =>
    path.resolve(raiz, (await git(raiz, ['rev-parse', '--git-path', nombre])).trim());
  const comun = path.resolve(raiz, (await git(raiz, ['rev-parse', '--git-common-dir'])).trim());
  for (const [clave, ruta] of [
    ['.git/config', path.join(comun, 'config')],
    ['.git/config.worktree', await rutaGit('config.worktree')],
  ] as const) {
    entradas.set(clave, { kind: 'git', sha256: (await huellaArchivo(ruta)) ?? digest('absent') });
  }
  const hooks = await rutaGit('hooks');
  await recorrerCarpetaGit(hooks, '.git/hooks', entradas);
  const hooksComunes = path.join(comun, 'hooks');
  if (path.resolve(hooksComunes) !== path.resolve(hooks)) await recorrerCarpetaGit(hooksComunes, '.git/hooks-comunes', entradas);
  await recorrerCarpetaGit(await rutaGit('info'), '.git/info', entradas);
}

/**
 * Una entrada de `node_modules` (o de un `@scope`): tipo, tamaño y fecha (en una carpeta cambia al crear o borrar algo
 * dentro), la huella de su `package.json` si es un paquete, la del archivo si es un archivo (`.package-lock.json`...) o
 * el destino si es un enlace. No recorre las dependencias.
 */
async function entradaDependencia(completa: string): Promise<EntradaDisco> {
  const datos = await lstat(completa);
  if (datos.isSymbolicLink()) return { kind: 'dependency-symlink', sha256: digest(await readlink(completa)) };
  if (datos.isDirectory()) {
    const paquete = await huellaArchivo(path.join(completa, 'package.json'));
    return { size: datos.size, mtimeMs: datos.mtimeMs, kind: 'dependency-directory', ...(paquete === undefined ? {} : { sha256: paquete }) };
  }
  const contenido = datos.isFile() ? await huellaArchivo(completa) : undefined;
  return { size: datos.size, mtimeMs: datos.mtimeMs, kind: 'dependency-entry', ...(contenido === undefined ? {} : { sha256: contenido }) };
}

async function instantaneaGit(raiz: string, entradas: Instantanea): Promise<void> {
  let cima: string;
  try {
    cima = (await git(raiz, ['rev-parse', '--show-toplevel'])).trim();
  } catch {
    return;
  }
  if ((await realpath(cima)) !== (await realpath(raiz))) return;
  await instantaneaConfigGit(raiz, entradas);
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
            const rutaHijo = path.join(completa, hijo);
            const entrada = await entradaDependencia(rutaHijo);
            entradas.set(`${relativa}/${hijo}`, entrada);
            // Los paquetes con ámbito (`@types/node`) están un nivel más abajo.
            if (hijo.startsWith('@') && entrada.kind === 'dependency-directory') {
              for (const nieto of (await readdir(rutaHijo)).sort()) {
                entradas.set(`${relativa}/${hijo}/${nieto}`, await entradaDependencia(path.join(rutaHijo, nieto)));
              }
            }
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
