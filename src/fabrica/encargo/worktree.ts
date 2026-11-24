import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, readdir, readFile, realpath, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prefijoRepoTemporal } from '../banco/ejecutar.js';
import { ErrorFabrica } from '../errores.js';
import { carpetaPropia, codigoError, escribirReemplazando } from '../rastro.js';
import { procesoVivo } from './candado.js';

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
  /** Gitdir real del worktree (`<repo>/.git/worktrees/<nombre>`), fijado al crearlo: el `.git` del worktree no es de fiar. */
  gitDir: string;
  /** Lo que conviene saber (por ejemplo, cambios sin commit que no se copian). */
  avisos: string[];
}

/** Variables de git que cambian dónde opera o cómo se configura: no se heredan. */
const VARIABLES_GIT = [
  'GIT_DIR',
  'GIT_INDEX_FILE',
  'GIT_WORK_TREE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
];

function entornoSaneado(): NodeJS.ProcessEnv {
  const entorno: NodeJS.ProcessEnv = { ...process.env };
  for (const clave of Object.keys(entorno)) {
    if (VARIABLES_GIT.includes(clave.toUpperCase()) || clave.toUpperCase().startsWith('GIT_CONFIG')) delete entorno[clave];
  }
  // Sin escrituras opcionales (refrescar el índice, por ejemplo): un `git status` no debe tocar el repo real.
  entorno['GIT_OPTIONAL_LOCKS'] = '0';
  return entorno;
}

/** Ejecuta git con el entorno saneado y devuelve la salida cruda, sin decodificar. */
function gitBytes(cwd: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [
        '-c',
        'core.quotepath=off',
        '-c',
        'color.ui=false',
        '-c',
        'core.autocrlf=false',
        ...(process.platform === 'win32' ? ['-c', 'core.longpaths=true'] : []),
        ...args,
      ],
      { cwd, encoding: 'buffer', maxBuffer: MAX_BUFFER, windowsHide: true, env: entornoSaneado() },
      (error, stdout, stderr) => {
        if (error) {
          const codigo = (error as NodeJS.ErrnoException).code;
          const motivo =
            codigo === 'ENOENT'
              ? 'no se encontró git en el PATH o la carpeta de trabajo no existe'
              : codigo === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
                ? `la salida supera el tope de ${MAX_BUFFER} bytes`
                : stderr.toString('utf8').trim();
          reject(new ErrorFabrica(`git ${args.find((a) => !a.startsWith('-')) ?? ''} falló: ${motivo}`, { cause: error }));
        } else resolve(stdout);
      },
    );
  });
}

const git = async (cwd: string, args: string[]): Promise<string> => (await gitBytes(cwd, args)).toString('utf8');

/**
 * Argumentos para las órdenes que corren sobre el worktree, que controla la IA: se fija el gitdir y el árbol de
 * trabajo (el archivo `.git` del worktree puede estar reescrito) y se apagan fsmonitor, hooks y la caché de no rastreados.
 */
function argsSobreWorktree(w: Worktree, args: string[]): string[] {
  return [
    `--git-dir=${w.gitDir}`,
    `--work-tree=${w.dir}`,
    '-c',
    'core.fsmonitor=false',
    '-c',
    `core.hooksPath=${os.devNull}`,
    '-c',
    'core.untrackedCache=false',
    // Ni submódulos ni repos anidados: git entraría en ellos y aplicaría su configuración (filtros `clean` incluidos).
    '-c',
    'diff.ignoreSubmodules=all',
    '-c',
    'submodule.recurse=false',
    ...args,
  ];
}

const mensajeDe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const borrarCarpeta = (ruta: string): Promise<void> => rm(ruta, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });

/**
 * Enlaza `node_modules` del repo real en el worktree para que la IA pueda compilar y probar sin red.
 * Solo si es una carpeta real (no un enlace) y git la tiene ignorada, también ya como enlace dentro del worktree: así no entra en el diff ni dispara el análisis
 * de enlaces que salen del repo. Codex escribe con sandbox por ruta real (no puede tocar el `node_modules` real) y
 * Antigravity veta componentes que sean enlaces. Riesgo residual: el sandbox de Codex acota la escritura, no la lectura;
 * en modo escritura Codex puede LEER todo el disco de la persona (no solo las dependencias). Quien encarga revisa el
 * diff y el resumen antes de aplicarlo o compartirlo.
 * `borrarWorktree` borra el enlace sin seguirlo.
 */
async function enlazarNodeModules(raiz: string, dir: string): Promise<void> {
  const origen = path.join(raiz, 'node_modules');
  const info = await lstat(origen).catch(() => null);
  if (info === null || !info.isDirectory() || info.isSymbolicLink()) return;
  try {
    await git(raiz, ['check-ignore', '-q', 'node_modules']);
  } catch {
    return;
  }
  const enlace = path.join(dir, 'node_modules');
  await symlink(origen, enlace, process.platform === 'win32' ? 'junction' : 'dir');
  // Un patrón `node_modules/` (solo carpetas) ignora la carpeta real pero no el enlace, que entraría en el diff: se quita.
  // (En Windows git ve la junction como carpeta y la ignora: `check-ignore` acierta y se queda, sin entrar en el diff.)
  try {
    await git(dir, ['check-ignore', '-q', 'node_modules']);
  } catch {
    await rm(enlace, { force: true });
  }
}

export interface OpcionesCrearWorktree {
  /** Solo para pruebas: se llama justo después de crear el worktree; si lanza, se prueba la limpieza. */
  despuesDeCrear?: () => Promise<void>;
}

/**
 * Crea un worktree desacoplado de HEAD en `~/.nexakit/encargos/<id>/repo` (carpetas `0o700`, sin seguir enlaces).
 * El encargo parte de HEAD: si el árbol de la persona tiene cambios sin commit, se avisa y no se copian.
 */
export async function crearWorktree(raiz: string, home: string, opciones: OpcionesCrearWorktree = {}): Promise<Worktree> {
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
      // El candado dice de quién es el encargo: si ese proceso muere, el barrido de huérfanos puede borrar el worktree.
      await escribirReemplazando(path.join(carpeta, CANDADO), `${JSON.stringify({ pid: process.pid, raiz })}\n`);
      // Sin hooks: el `post-checkout` del repo real correría sobre él antes de la comprobación del disco.
      await git(raiz, ['-c', `core.hooksPath=${os.devNull}`, 'worktree', 'add', '--detach', '--quiet', '--', dir, base]);
      await chmod(dir, 0o700);
      await enlazarNodeModules(raiz, dir);
      await opciones.despuesDeCrear?.();
      // Ahora el `.git` del worktree es el que escribió git: se guarda su gitdir real, que no volverá a leerse de ahí.
      const gitDir = path.resolve(dir, (await git(dir, ['rev-parse', '--absolute-git-dir'])).trim());
      return { id, dir, base, raiz, gitDir, avisos };
    } catch (error) {
      // Primero se quita el worktree y su carpeta; `prune` va al final para no dejar ninguna entrada en `.git/worktrees`.
      await git(raiz, ['worktree', 'remove', '--force', dir]).catch(() => {});
      await borrarCarpeta(carpeta).catch(() => {});
      await git(raiz, ['worktree', 'prune']).catch(() => {});
      throw error;
    }
  }
  throw new ErrorFabrica('No se pudo reservar un id libre para el encargo');
}

/** Tope de entradas que recorre `buscarGitAnidado`: más allá, el encargo no se comprueba y se rechaza. */
const MAX_ENTRADAS_RECORRIDO = 1_000_000;

/** `.git` también con otra caja, puntos o espacios finales (Windows) o el nombre corto de NTFS. */
const esNombreGit = (nombre: string): boolean => {
  const normal = nombre.toLowerCase().replace(/[. ]+$/u, '');
  return normal === '.git' || normal === 'git~1';
};

/**
 * Primer `.git` anidado (carpeta, archivo o enlace) dentro del worktree, como ruta relativa con `/`, o `null`. Recorre con
 * el tipo de `readdir` (sin seguir enlaces) y salta solo el `.git` de la raíz. Hay que llamarla antes de cualquier orden
 * git sobre el worktree tras el turno: git entraría en un repo anidado y ejecutaría los filtros de su configuración,
 * fuera de todo sandbox. Lanza si no puede leer una carpeta o si hay demasiadas entradas.
 */
export async function buscarGitAnidado(dir: string): Promise<string | null> {
  const pendientes: string[] = [''];
  let vistas = 0;
  while (pendientes.length > 0) {
    const relativa = pendientes.pop() as string;
    const entradas = await readdir(relativa === '' ? dir : path.join(dir, ...relativa.split('/')), { withFileTypes: true });
    for (const entrada of entradas) {
      vistas += 1;
      if (vistas > MAX_ENTRADAS_RECORRIDO) throw new ErrorFabrica(`la copia tiene más de ${MAX_ENTRADAS_RECORRIDO} entradas`);
      const ruta = relativa === '' ? entrada.name : `${relativa}/${entrada.name}`;
      if (esNombreGit(entrada.name)) {
        if (relativa === '' && entrada.name === '.git') continue;
        return ruta;
      }
      // Los enlaces (también el de `node_modules`) no se siguen.
      if (entrada.isDirectory() && !entrada.isSymbolicLink()) pendientes.push(ruta);
    }
  }
  return null;
}

/**
 * Diff del worktree contra su base, con los archivos nuevos (`git add -N`) y los binarios (`--binary`), listo para
 * `git apply`, sin renombrados ni submódulos. Se devuelve como bytes: un archivo que no está en UTF-8 se corrompería al
 * decodificarlo. Vacío si no hubo cambios. Antes hay que descartar los repos anidados con `buscarGitAnidado`.
 */
export async function diffDelWorktree(w: Worktree): Promise<Buffer> {
  try {
    await gitBytes(w.dir, argsSobreWorktree(w, ['add', '-N', '--all', '--', '.']));
    return await gitBytes(
      w.dir,
      argsSobreWorktree(w, [
        'diff',
        '--binary',
        '--no-renames',
        '--no-relative',
        '--ignore-submodules=all',
        '--no-ext-diff',
        '--no-textconv',
        '--no-color',
        '--src-prefix=a/',
        '--dst-prefix=b/',
        w.base,
        '--',
      ]),
    );
  } catch (error) {
    throw new ErrorFabrica(`No se pudo leer el diff del encargo: ${mensajeDe(error)}`, { cause: error });
  }
}

/** Un cambio del worktree respecto de su base. */
export interface CambioWorktree {
  /** Ruta relativa, con `/`. */
  ruta: string;
  /** Modo del archivo ya cambiado (`120000` es un enlace simbólico; `000000`, un borrado). */
  modo: string;
}

/**
 * Cambios del worktree contra su base (`git diff --raw -z --no-renames`), con la ruta y el modo nuevo de cada uno, sin
 * decodificar nombres raros. Debe llamarse después de `diffDelWorktree`, que registra los archivos nuevos. El encargo no
 * la usa: analiza el propio parche guardado (`analizarParche`), que no puede cambiar entre el diff y la comprobación.
 */
export async function cambiosDelWorktree(w: Worktree): Promise<CambioWorktree[]> {
  let crudo: string;
  try {
    crudo = (
      await gitBytes(w.dir, argsSobreWorktree(w, ['diff', '--raw', '-z', '--no-renames', '--no-relative', '--ignore-submodules=all', '--no-ext-diff', '--no-textconv', w.base, '--']))
    ).toString('utf8');
  } catch (error) {
    throw new ErrorFabrica(`No se pudo analizar el diff del encargo: ${mensajeDe(error)}`, { cause: error });
  }
  // Formato: `:<modo previo> <modo nuevo> <sha previo> <sha nuevo> <estado>\0<ruta>\0` por cambio.
  const partes = crudo.split('\0');
  const cambios: CambioWorktree[] = [];
  for (let i = 0; i + 1 < partes.length; i += 2) {
    const meta = /^:\d+ (\d+) /u.exec(partes[i] ?? '');
    const ruta = partes[i + 1];
    if (meta?.[1] === undefined || ruta === undefined || ruta === '') continue;
    cambios.push({ ruta, modo: meta[1] });
  }
  return cambios;
}

/**
 * Raíz del repo que contiene `cwd` (`git rev-parse --show-toplevel`, con el entorno saneado). Lanza si `cwd` no está
 * en un repo de git.
 */
export async function raizDelRepoGit(cwd: string): Promise<string> {
  const raiz = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
  if (raiz === '') throw new ErrorFabrica('No se pudo averiguar la raíz del repo');
  return path.resolve(raiz);
}

/**
 * Quita el worktree y limpia el registro de git. Nunca lanza: si algo falla, devuelve el aviso (y `null` si todo fue bien).
 * No ejecuta git sobre el worktree (que controla la IA y puede traer un repo anidado): borra la carpeta sin seguir enlaces
 * y después `git worktree prune` en el repo real limpia su entrada de `.git/worktrees`.
 */
export async function borrarWorktree(w: Worktree): Promise<string | null> {
  const fallos: string[] = [];
  try {
    await borrarCarpeta(w.dir);
  } catch (error) {
    fallos.push(mensajeDe(error));
  }
  try {
    await git(w.raiz, ['worktree', 'prune']);
  } catch (error) {
    fallos.push(mensajeDe(error));
  }
  return fallos.length === 0 ? null : `No se pudo borrar bien el worktree ${w.dir} (${fallos.join('; ')}); revisa con «git worktree list» y bórralo a mano.`;
}

// ---------------------------------------------------------------------------------------------
// Huérfanos

const CANDADO = 'candado.json';
/** Una carpeta sin candado se respeta este tiempo: puede estar creándose ahora mismo en otro proceso. */
const GRACIA_SIN_CANDADO_MS = 5 * 60_000;

async function leerCandadoWorktree(carpeta: string): Promise<{ pid: number; raiz: string } | null> {
  try {
    const archivo = path.join(carpeta, CANDADO);
    const info = await lstat(archivo);
    if (!info.isFile()) return null;
    const dato: unknown = JSON.parse(await readFile(archivo, 'utf8'));
    if (typeof dato !== 'object' || dato === null) return null;
    const { pid, raiz } = dato as { pid?: unknown; raiz?: unknown };
    return typeof pid === 'number' && typeof raiz === 'string' ? { pid, raiz } : null;
  } catch {
    return null;
  }
}

/**
 * Clave para comparar rutas. En Windows git imprime `C:/Users/...` (barras normales) y la ruta real viene con `\` y quizá con
 * otra caja de letras, así que ahí se igualan separadores y caja; en POSIX la ruta se compara tal cual.
 */
function claveDeRuta(ruta: string): string {
  const sinFinal = ruta.replace(/\r$/u, '');
  if (process.platform !== 'win32') return sinFinal;
  return sinFinal.replace(/\\/gu, '/').replace(/\/+$/u, '').toLowerCase();
}

/** `true` si el repo `raiz` tiene registrado `dir` como worktree (`git worktree list`); solo entonces se ejecuta `remove` o `prune`. */
async function worktreeRegistrado(raiz: string, dir: string): Promise<boolean> {
  try {
    const listado = (await git(raiz, ['worktree', 'list', '--porcelain'])).split('\n');
    const buscados = new Set([claveDeRuta(dir), claveDeRuta(await realpath(dir).catch(() => dir))]);
    return listado.some((l) => l.startsWith('worktree ') && buscados.has(claveDeRuta(l.slice('worktree '.length))));
  } catch {
    return false;
  }
}

/**
 * Borra los worktrees que dejó un encargo muerto (un proceso que cayó sin limpiar): carpetas
 * `~/.nexakit/encargos/<id>/repo` cuyo candado ya no tiene un proceso vivo. Solo toca carpetas reales dentro de
 * `~/.nexakit/encargos/`, nunca sigue enlaces y conserva `informe.json` y `cambios.diff`. Nunca lanza; devuelve un
 * aviso por cada worktree borrado o que no se pudo borrar.
 */
export async function barrerHuerfanos(home: string, ahora: number = Date.now()): Promise<string[]> {
  const avisos: string[] = [];
  const nexakit = path.join(home, '.nexakit');
  const encargos = path.join(nexakit, 'encargos');
  let nombres: string[];
  try {
    // Ni `~/.nexakit` ni `encargos` pueden ser enlaces: el barrido no sale de la carpeta propia.
    const raizNexakit = await lstat(nexakit);
    if (!raizNexakit.isDirectory() || raizNexakit.isSymbolicLink()) return avisos;
    const info = await lstat(encargos);
    if (!info.isDirectory() || info.isSymbolicLink()) return avisos;
    nombres = await readdir(encargos);
  } catch {
    return avisos;
  }
  for (const nombre of nombres) {
    try {
      const carpeta = path.join(encargos, nombre);
      const info = await lstat(carpeta);
      if (!info.isDirectory() || info.isSymbolicLink()) continue;
      const repo = await lstat(path.join(carpeta, 'repo')).catch(() => null);
      // Un `repo` que sea un enlace u otra cosa no se toca: solo se borra un worktree real.
      if (repo === null || !repo.isDirectory() || repo.isSymbolicLink()) continue;
      const candado = await leerCandadoWorktree(carpeta);
      if (candado === null ? ahora - info.mtimeMs < GRACIA_SIN_CANDADO_MS : procesoVivo(candado.pid)) continue;
      const aviso = await quitarWorktreeDeCarpeta(carpeta, nombre);
      if (aviso !== undefined) avisos.push(aviso ?? `Se borró el worktree huérfano de un encargo anterior (${nombre}).`);
    } catch (error) {
      avisos.push(`No se pudo revisar la carpeta de encargo ${nombre}: ${mensajeDe(error)}`);
    }
  }
  return avisos;
}

/**
 * Quita el worktree `repo` (y la carpeta `tmp`) de una carpeta de encargo cuyo proceso ya no vive. Solo ejecuta git en
 * la raíz del candado si ese repo tiene registrado el worktree; si no, solo borra la carpeta (ejecutar git en otro repo
 * lo tocaría sin motivo). Devuelve `undefined` si no había worktree real, `null` si se borró bien y el aviso si no.
 * Lanza si el proceso del candado sigue vivo.
 */
export async function quitarWorktreeDeCarpeta(carpeta: string, nombre: string = path.basename(carpeta)): Promise<string | null | undefined> {
  const candado = await leerCandadoWorktree(carpeta);
  if (candado !== null && procesoVivo(candado.pid)) throw new ErrorFabrica(`el encargo ${nombre} sigue en curso (proceso ${candado.pid})`);
  await borrarCarpeta(path.join(carpeta, 'tmp')).catch(() => {});
  const dir = path.join(carpeta, 'repo');
  const repo = await lstat(dir).catch(() => null);
  if (repo === null || !repo.isDirectory() || repo.isSymbolicLink()) return undefined;
  const raizRepo = candado?.raiz;
  if (raizRepo !== undefined && path.isAbsolute(raizRepo) && (await worktreeRegistrado(raizRepo, dir))) {
    return borrarWorktree({ id: nombre, dir, base: '', raiz: raizRepo, gitDir: '', avisos: [] });
  }
  await borrarCarpeta(dir);
  return null;
}
