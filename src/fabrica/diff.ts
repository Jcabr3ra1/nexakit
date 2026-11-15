import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, readlink } from 'node:fs/promises';
import path from 'node:path';
import type { ConfigFabrica } from './esquemas.js';
import { ErrorFabrica } from './errores.js';

/** Tope del diff que se envía a los revisores: 400 KiB, igual que `revision-context`. */
export const LIMITE_DIFF_BYTES = 400 * 1024;
/** Tope de un archivo nuevo (no seguido) que se lee para el diff. */
const LIMITE_ARCHIVO_NUEVO_BYTES = 1024 * 1024;
const MAX_BUFFER = 16 * 1024 * 1024;

export type TipoCambio = 'A' | 'M' | 'D' | 'R';
export interface ArchivoCambiado {
  ruta: string;
  tipo: TipoCambio;
}
export interface ResultadoDiff {
  /** Commit de `HEAD`. */
  head: string;
  /** Commit del ancestro común entre la rama base y `HEAD` (el diff se calcula contra él). */
  base: string;
  archivos: ArchivoCambiado[];
  texto: string;
  sha256: string;
}

export type Categoria = 'hooks' | 'interfaz' | 'docs' | 'codigo' | 'critica' | 'caliente' | 'pruebas';

interface ResultadoGit {
  stdout: string;
}

class ErrorGit extends Error {
  readonly stderr: string;
  readonly codigo: unknown;
  constructor(args: string[], stderr: string, codigo: unknown, causa: unknown) {
    super(`git ${args[0] ?? ''} falló: ${stderr.trim()}`, { cause: causa });
    this.name = 'ErrorGit';
    this.stderr = stderr;
    this.codigo = codigo;
  }
}

function git(args: string[], cwd: string): Promise<ResultadoGit> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-c', 'core.quotepath=off', '-c', 'color.ui=false', ...args],
      { cwd, encoding: 'utf8', maxBuffer: MAX_BUFFER, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) reject(new ErrorGit(args, String(stderr ?? ''), (error as NodeJS.ErrnoException).code, error));
        else resolve({ stdout });
      },
    );
  });
}

function dividirNombres(texto: string): string[] {
  return texto.split('\0').filter(Boolean);
}

function comprobarLimite(texto: string): void {
  const bytes = Buffer.byteLength(texto, 'utf8');
  if (bytes > LIMITE_DIFF_BYTES) {
    throw new ErrorFabrica(
      `El diff tiene ${bytes} bytes y supera el límite de ${LIMITE_DIFF_BYTES} bytes. Usa una base más reciente o menos archivos para revisar por partes.`,
    );
  }
}

function esErrorDeTamano(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
}

async function raizDelRepositorio(raiz: string): Promise<string> {
  try {
    return (await git(['rev-parse', '--show-toplevel'], raiz)).stdout.trim();
  } catch (error) {
    if (error instanceof ErrorGit && error.codigo === 'ENOENT') {
      throw new ErrorFabrica('No se encontró git en el PATH.', { cause: error });
    }
    throw new ErrorFabrica(`${raiz} no es un repositorio Git.`, { cause: error });
  }
}

async function resolverCommit(ref: string, cwd: string): Promise<string | null> {
  if (!ref || ref.startsWith('-') || /[\0\r\n]/u.test(ref)) return null;
  try {
    const { stdout } = await git(['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], cwd);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** Interpreta `git diff --name-status -z -M`: `estado\0ruta\0` y, en renombrados, `estado\0origen\0destino\0`. */
function parsearEstados(salida: string): ArchivoCambiado[] {
  const campos = dividirNombres(salida);
  const archivos: ArchivoCambiado[] = [];
  for (let i = 0; i < campos.length; ) {
    const estado = campos[i++] ?? '';
    const letra = estado.charAt(0);
    if (letra === 'R' || letra === 'C') {
      i++; // origen
      const destino = campos[i++];
      if (destino !== undefined) archivos.push({ ruta: destino, tipo: letra === 'R' ? 'R' : 'A' });
      continue;
    }
    const ruta = campos[i++];
    if (ruta === undefined) break;
    archivos.push({ ruta, tipo: letra === 'A' ? 'A' : letra === 'D' ? 'D' : 'M' });
  }
  return archivos;
}

async function textoArchivoNuevo(raiz: string, nombre: string): Promise<string> {
  const archivo = path.join(raiz, nombre);
  const cabecera = `\nArchivo nuevo: ${JSON.stringify(nombre)}\n`;
  const info = await lstat(archivo);
  if (info.isSymbolicLink()) return `${cabecera}Enlace: ${await readlink(archivo)}\n`;
  if (!info.isFile()) return `${cabecera}Archivo especial: sin contenido textual\n`;
  if (info.size > LIMITE_ARCHIVO_NUEVO_BYTES) {
    throw new ErrorFabrica(
      `El archivo nuevo ${nombre} tiene ${info.size} bytes y supera el máximo de ${LIMITE_ARCHIVO_NUEVO_BYTES} bytes para revisar.`,
    );
  }
  const contenido = await readFile(archivo);
  if (contenido.includes(0)) return `${cabecera}Binario: sin diff textual\n`;
  return `${cabecera}${contenido.toString('utf8')}\n`;
}

/**
 * Calcula el diff de la rama de trabajo contra el ancestro común con `base`, incluyendo
 * el índice, el árbol de trabajo y los archivos no seguidos.
 */
export async function leerDiff(raiz: string, base: string): Promise<ResultadoDiff> {
  const cwd = await raizDelRepositorio(raiz);
  const head = await resolverCommit('HEAD', cwd);
  if (head === null) throw new ErrorFabrica('El repositorio no tiene commits');
  const baseCommit = await resolverCommit(base, cwd);
  if (baseCommit === null) throw new ErrorFabrica(`No existe la rama base ${base}`);

  let ancestros: string[];
  try {
    const { stdout } = await git(['merge-base', '--all', baseCommit, head], cwd);
    ancestros = stdout.trim().split(/\s+/u).filter(Boolean);
  } catch {
    ancestros = [];
  }
  if (ancestros.length !== 1 || ancestros[0] === undefined) {
    throw new ErrorFabrica(`La rama base ${base} y HEAD no tienen un ancestro común único`);
  }
  const ancestro = ancestros[0];

  const opcionesDiff = ['--no-ext-diff', '--no-textconv', '--no-color', '--src-prefix=a/', '--dst-prefix=b/', '-M'];
  let seguidos: ArchivoCambiado[];
  let nuevos: string[];
  let texto: string;
  try {
    seguidos = parsearEstados((await git(['diff', ...opcionesDiff, '--name-status', '-z', ancestro, '--'], cwd)).stdout);
    nuevos = dividirNombres((await git(['ls-files', '--others', '--exclude-standard', '-z'], cwd)).stdout);
    texto = (await git(['diff', ...opcionesDiff, ancestro, '--'], cwd)).stdout;
  } catch (error) {
    if (esErrorDeTamano(error)) {
      throw new ErrorFabrica(
        `El diff supera ${MAX_BUFFER} bytes y el límite de ${LIMITE_DIFF_BYTES} bytes. Usa una base más reciente o menos archivos para revisar por partes.`,
        { cause: error },
      );
    }
    throw new ErrorFabrica(`No se pudo leer el diff: ${(error as Error).message}`, { cause: error });
  }
  comprobarLimite(texto);

  const archivos = [...seguidos, ...[...new Set(nuevos)].map((ruta): ArchivoCambiado => ({ ruta, tipo: 'A' }))];
  if (archivos.length === 0) throw new ErrorFabrica('No hay cambios que revisar');
  archivos.sort((a, b) => (a.ruta < b.ruta ? -1 : a.ruta > b.ruta ? 1 : 0));

  for (const nombre of [...new Set(nuevos)].sort()) {
    texto += await textoArchivoNuevo(cwd, nombre);
    comprobarLimite(texto);
  }

  return {
    head,
    base: ancestro,
    archivos,
    texto,
    sha256: createHash('sha256').update(texto, 'utf8').digest('hex'),
  };
}

const RE_INTERFAZ = /\.(html|css|scss|jsx|tsx|vue|svelte|astro)$/iu;
const RE_PRUEBAS = /(^|\/)(test|tests|__tests__)\/|\.(test|spec)\.[^/]+$/iu;
const RE_HOOKS = /hook|pre-tool/iu;
const RE_DOCS = /^docs\/|\.md$/iu;

function coincide(ruta: string, patrones: readonly string[] | undefined): boolean {
  return (patrones ?? []).some((patron) => path.posix.matchesGlob(ruta, patron));
}

/** Etiqueta el conjunto de archivos con las categorías que usa el enrutador. */
export function clasificar(
  archivos: ReadonlyArray<{ ruta: string }>,
  config: Pick<ConfigFabrica, 'rutasCriticas' | 'rutasCalientes'>,
): Set<Categoria> {
  const categorias = new Set<Categoria>();
  for (const { ruta: original } of archivos) {
    const ruta = original.replaceAll('\\', '/');
    const esDocs = RE_DOCS.test(ruta);
    if (esDocs) categorias.add('docs');
    else categorias.add('codigo');
    if (RE_HOOKS.test(ruta)) categorias.add('hooks');
    if (RE_INTERFAZ.test(ruta)) categorias.add('interfaz');
    if (RE_PRUEBAS.test(ruta)) categorias.add('pruebas');
    if (coincide(ruta, config.rutasCriticas)) categorias.add('critica');
    if (coincide(ruta, config.rutasCalientes)) categorias.add('caliente');
  }
  return categorias;
}
