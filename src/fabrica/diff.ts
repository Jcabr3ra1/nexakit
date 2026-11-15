import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
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

interface EntradaHuella {
  ruta: string;
  tipo: TipoCambio;
  /** `borrado` si ya no existe en el árbol de trabajo; si no, `archivo`, `enlace` o `especial`. */
  estado: 'borrado' | 'archivo' | 'enlace' | 'especial';
  /** Modo del árbol de trabajo (octal) o null si no existe. */
  modo: string | null;
  /** SHA-256 de los bytes reales (o del destino del enlace), sin pasar por UTF-8. */
  digest: string | null;
}

async function digestContenido(archivo: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const trozo of createReadStream(archivo)) hash.update(trozo as Buffer);
  return hash.digest('hex');
}

async function entradaHuella(raiz: string, { ruta, tipo }: ArchivoCambiado): Promise<EntradaHuella> {
  const archivo = path.join(raiz, ruta);
  let info;
  try {
    info = await lstat(archivo);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ruta, tipo, estado: 'borrado', modo: null, digest: null };
    }
    throw error;
  }
  const modo = (info.mode & 0o177777).toString(8);
  if (info.isSymbolicLink()) {
    const destino = Buffer.from(await readlink(archivo), 'utf8');
    return { ruta, tipo, estado: 'enlace', modo, digest: createHash('sha256').update(destino).digest('hex') };
  }
  if (!info.isFile()) return { ruta, tipo, estado: 'especial', modo, digest: null };
  return { ruta, tipo, estado: 'archivo', modo, digest: await digestContenido(archivo) };
}

/**
 * Huella del estado revisado: JSON con campos en orden fijo (las cadenas van escapadas, así que
 * ningún contenido puede imitar la estructura). Cubre HEAD, el ancestro, el índice y, por cada
 * archivo cambiado, su ruta, tipo, modo y el digest de sus bytes reales. No depende de `texto`.
 */
function calcularHuella(head: string, ancestro: string, indice: string, entradas: EntradaHuella[]): string {
  const estructura = {
    version: 1,
    head,
    base: ancestro,
    indice,
    archivos: entradas.map((e) => [e.ruta, e.tipo, e.estado, e.modo, e.digest]),
  };
  return createHash('sha256').update(JSON.stringify(estructura), 'utf8').digest('hex');
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

  let indice: string;
  let entradas: EntradaHuella[];
  try {
    const { stdout } = await git(['ls-files', '--stage', '-z'], cwd);
    indice = createHash('sha256').update(stdout, 'utf8').digest('hex');
    entradas = [];
    for (const archivo of archivos) entradas.push(await entradaHuella(cwd, archivo));
  } catch (error) {
    throw new ErrorFabrica(`No se pudo calcular la huella del diff: ${(error as Error).message}`, { cause: error });
  }

  return { head, base: ancestro, archivos, texto, sha256: calcularHuella(head, ancestro, indice, entradas) };
}

const RE_INTERFAZ = /\.(html|css|scss|jsx|tsx|vue|svelte|astro)$/iu;
const RE_PRUEBAS = /(^|\/)(test|tests|__tests__)\/|\.(test|spec)\.[^/]+$/iu;
const RE_HOOKS = /hook|pre-tool/iu;
const RE_DOCS = /^docs\/|\.md$/iu;

// `matchesGlob` no hace coincidir segmentos que empiezan por punto con `*` ni `**`. Se sustituye
// el punto inicial de cada segmento (en ruta y patrón) por un carácter de control antes de comparar.
const PUNTO = '\u0001';

function ocultarPuntos(ruta: string): string {
  return ruta.replace(/(^|\/)\./gu, (_, previo: string) => previo + PUNTO);
}

function ocultarPuntosPatron(patron: string): string {
  const inicio = patron.includes('{') ? /(^|\/|\{|,)\./gu : /(^|\/)\./gu;
  return patron.replace(inicio, (_, previo: string) => previo + PUNTO);
}

function coincide(ruta: string, patrones: readonly string[] | undefined): boolean {
  const normalizada = ocultarPuntos(ruta);
  return (patrones ?? []).some((patron) => path.posix.matchesGlob(normalizada, ocultarPuntosPatron(patron)));
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
