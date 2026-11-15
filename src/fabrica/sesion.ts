import { execFile } from 'node:child_process';
import { closeSync, constants, lstatSync, openSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { crearConectorAntigravity } from './conectores/antigravity.js';
import { crearConectorCodex, type OpcionesConectorCodex } from './conectores/codex.js';
import type { Conector } from './conectores/tipos.js';
import { cargarConfig } from './config.js';
import * as ejecutor from './ejecutor.js';
import { aplicarCambios, calcularHuella, proponer, type CambioRecorrido, type Catalogos, type Recorrido } from './enrutador.js';
import { ErrorEntorno, ErrorFabrica } from './errores.js';
import { IA, NombreEstacion } from './esquemas.js';
import * as rastro from './rastro.js';

/**
 * Operaciones comunes de la CLI y del servidor MCP. La frontera de aprobación vive aquí, una sola vez:
 * `lanzarAprobado` exige una propuesta guardada cuya huella coincida antes de aplicar ningún cambio.
 */

const ejecutarArchivo = promisify(execFile);

export const MENSAJE_SIN_PROPUESTA = 'No hay una propuesta con esa huella; vuelve a proponer';
const AGOTADO: unique symbol = Symbol('agotado');

export type Avisar = (texto: string) => Promise<void>;
const sinAvisos: Avisar = async () => {};

/** Quita controles, secuencias de escape y marcas de dirección: el texto del repo o de un revisor no es de fiar. */
export function limpiar(texto: string): string {
  return texto.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/gu, '');
}

export function mensajeDe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function conTope<T>(promesa: Promise<T>, ms: number): Promise<T | typeof AGOTADO> {
  let reloj: NodeJS.Timeout | undefined;
  const tope = new Promise<typeof AGOTADO>((resolve) => {
    reloj = setTimeout(() => resolve(AGOTADO), ms);
  });
  return Promise.race([promesa, tope]).finally(() => clearTimeout(reloj));
}

/** Lee un archivo del rastro sin seguir enlaces; `null` si no existe o no es un archivo normal. */
export function leerSinEnlaces(archivo: string): string | null {
  const info = lstatSync(archivo, { throwIfNoEntry: false });
  if (info === undefined || !info.isFile()) return null;
  const fd = openSync(archivo, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}

/** Raíz del repo que contiene `cwd`; si no es un repo, el propio `cwd`. */
export async function raizDelRepo(cwd: string): Promise<string> {
  try {
    const { stdout } = await ejecutarArchivo('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' });
    const raiz = stdout.trim();
    return raiz === '' ? cwd : path.resolve(raiz);
  } catch {
    return cwd;
  }
}

// ---------------------------------------------------------------------------------------------
// Conectores

export type Conectores = Partial<Record<IA, Conector>>;

/** `NEXAKIT_FABRICA_*`: `[orden, ...argsPrefijo]` en JSON, o la ruta de la orden. Sin valor, el ejecutable real. */
function opcionesDeEntorno(entorno: NodeJS.ProcessEnv, variable: string): OpcionesConectorCodex {
  const valor = entorno[variable];
  if (valor === undefined || valor === '') return {};
  if (!valor.startsWith('[')) return { orden: valor };
  let lista: unknown;
  try {
    lista = JSON.parse(valor);
  } catch {
    throw new ErrorEntorno(`${variable} no es un JSON válido; usa ["orden", "argumento"...] o la ruta de la orden`);
  }
  if (!Array.isArray(lista) || !lista.every((x): x is string => typeof x === 'string') || lista[0] === undefined) {
    throw new ErrorEntorno(`${variable} debe ser una lista de textos que empiece por la orden`);
  }
  const [orden, ...argsPrefijo] = lista as string[];
  return { orden: orden as string, argsPrefijo };
}

/**
 * Crea los conectores externos pedidos (por defecto Codex y Antigravity) con las variables
 * `NEXAKIT_FABRICA_CODEX` y `NEXAKIT_FABRICA_AGY`. Si uno no se puede crear, no entra en el resultado y se avisa.
 */
export async function crearConectoresDesdeEntorno(
  opciones: { ias?: readonly IA[]; entorno?: NodeJS.ProcessEnv; avisar?: Avisar } = {},
): Promise<Conectores> {
  const { ias = ['codex', 'antigravity'], entorno = process.env, avisar = sinAvisos } = opciones;
  const conectores: Conectores = {};
  for (const ia of ias) {
    try {
      if (ia === 'codex') {
        conectores.codex = await crearConectorCodex(opcionesDeEntorno(entorno, 'NEXAKIT_FABRICA_CODEX'));
      } else if (ia === 'antigravity') {
        conectores.antigravity = await crearConectorAntigravity(opcionesDeEntorno(entorno, 'NEXAKIT_FABRICA_AGY'));
      }
    } catch (error) {
      if (error instanceof ErrorEntorno) {
        await cerrarConectores(conectores);
        throw error;
      }
      await avisar(`${ia} no está disponible: ${limpiar(mensajeDe(error))}`);
    }
  }
  return conectores;
}

export async function cerrarConectores(conectores: Conectores): Promise<void> {
  await Promise.allSettled(
    Object.values(conectores).map((c) => conTope(Promise.resolve().then(() => c.cerrar()), ejecutor.TOPE_CATALOGO_MS)),
  );
}

/** Catálogos vivos con un tope de 30 s por IA. Una IA que falla queda sin catálogo y se avisa. */
async function consultarCatalogos(conectores: Conectores, avisar: Avisar): Promise<Catalogos> {
  const catalogos: Catalogos = {};
  await Promise.all(
    (Object.entries(conectores) as Array<[IA, Conector]>).map(async ([ia, conector]) => {
      try {
        const catalogo = await conTope(Promise.resolve().then(() => conector.catalogo()), ejecutor.TOPE_CATALOGO_MS);
        if (catalogo === AGOTADO) await avisar(`${ia} no respondió a tiempo; sus estaciones pasan al siguiente candidato`);
        else catalogos[ia] = catalogo;
      } catch (error) {
        await avisar(`${ia} no está disponible: ${limpiar(mensajeDe(error))}`);
      }
    }),
  );
  return catalogos;
}

// ---------------------------------------------------------------------------------------------
// Propuesta guardada

const Catalogo = z.array(z.object({ modelo: z.string(), esfuerzos: z.array(z.string()) }));
const RecorridoGuardado = z.object({
  huella: z.string(),
  head: z.string(),
  base: z.string(),
  basePedida: z.string(),
  diffSha256: z.string(),
  foco: z.string().optional(),
  estaciones: z.array(
    z.object({
      estacion: NombreEstacion,
      ia: IA.nullable(),
      modelo: z.string().nullable(),
      esfuerzo: z.string().nullable(),
      motivo: z.string(),
      descartes: z.array(z.string()),
      ordenesPermitidas: z.array(z.string()),
      estado: z.enum(['propuesta', 'sin-modelo', 'omitida']),
    }),
  ),
  coste: z.object({ llamadasExternas: z.number(), subagentesClaude: z.number() }),
  catalogos: z.partialRecord(IA, Catalogo),
});

/** Lista de cambios que una persona puede pedir sobre una propuesta antes de lanzarla. */
export const EsquemaCambios = z.array(
  z
    .object({
      estacion: z.string(),
      quitar: z.literal(true).optional(),
      ia: IA.optional(),
      modelo: z.string().optional(),
      esfuerzo: z.string().optional(),
    })
    .strict(),
);

/** Propuesta guardada del repo, o `null` si no existe o no es legible. La huella la comprueba quien la usa. */
function cargarPropuesta(home: string, repo: string): Recorrido | null {
  let dato: unknown;
  try {
    dato = rastro.leerPropuesta(home, repo);
  } catch {
    return null;
  }
  const r = RecorridoGuardado.safeParse(dato);
  return r.success ? (r.data as Recorrido) : null;
}

// ---------------------------------------------------------------------------------------------
// Operaciones

/** Calcula el recorrido propuesto para el diff contra `base` y lo guarda como la propuesta del repo. */
export async function proponerEnRaiz(entrada: {
  raiz: string;
  base: string;
  foco?: string | undefined;
  home: string;
  entorno?: NodeJS.ProcessEnv;
  avisar?: Avisar;
}): Promise<Recorrido> {
  const { raiz, base, foco, home, entorno = process.env, avisar = sinAvisos } = entrada;
  const conectores = await crearConectoresDesdeEntorno({ entorno, avisar });
  let catalogos: Catalogos;
  try {
    catalogos = await consultarCatalogos(conectores, avisar);
  } finally {
    await cerrarConectores(conectores);
  }
  const recorrido = await proponer({ raiz, base, ...(foco === undefined ? {} : { foco }), catalogos });
  await rastro.guardarPropuesta(home, await rastro.nombreRepo(raiz), recorrido);
  return recorrido;
}

export interface Lanzamiento {
  id: string;
  /** El recorrido que se lanzó, con los cambios ya aplicados. */
  recorrido: Recorrido;
  /** Se cumple cuando el recorrido ya terminó y sus conectores están cerrados. Nunca se rechaza. */
  terminado: Promise<void>;
}

/**
 * Lanza el recorrido de la propuesta guardada si su huella coincide con `huella`. La huella se valida
 * antes de aplicar nada: `aplicarCambios` la recalcula, así que una propuesta editada a mano (órdenes
 * añadidas, por ejemplo) pasaría con un cambio que no hace nada. Devuelve el id en cuanto el rastro
 * existe; los conectores se cierran cuando el recorrido termina.
 */
export async function lanzarAprobado(entrada: {
  raiz: string;
  huella: string;
  cambios?: CambioRecorrido[] | undefined;
  home: string;
  entorno?: NodeJS.ProcessEnv;
  avisar?: Avisar;
  /** Se llama con el recorrido definitivo antes de crear los conectores y lanzar. */
  antesDeLanzar?: (recorrido: Recorrido) => Promise<void> | void;
}): Promise<Lanzamiento> {
  const { raiz, huella, cambios = [], home, entorno = process.env, avisar = sinAvisos, antesDeLanzar } = entrada;
  const propuesta = cargarPropuesta(home, await rastro.nombreRepo(raiz));
  if (propuesta === null || propuesta.huella !== huella || calcularHuella(propuesta) !== propuesta.huella) {
    throw new ErrorFabrica(MENSAJE_SIN_PROPUESTA);
  }
  // La huella del recorrido con los cambios ya aplicados es la que `lanzar` comprueba contra el diff.
  const recorrido = cambios.length > 0 ? aplicarCambios(propuesta, cambios) : propuesta;
  const config = await cargarConfig(raiz);
  await antesDeLanzar?.(recorrido);

  const externas = new Set<IA>();
  for (const e of recorrido.estaciones) {
    if (e.estado === 'propuesta' && e.ia !== null && e.ia !== 'claude') externas.add(e.ia);
  }
  const conectores = await crearConectoresDesdeEntorno({ ias: [...externas], entorno, avisar });
  let id: string;
  try {
    ({ id } = await ejecutor.lanzar(recorrido, { raiz, conectores, paralelismo: config.paralelismo, home }));
  } catch (error) {
    await cerrarConectores(conectores);
    throw error;
  }
  const terminado = ejecutor
    .esperar(id, home)
    .then(
      () => {},
      () => {},
    )
    .then(() => cerrarConectores(conectores));
  return { id, recorrido, terminado };
}
