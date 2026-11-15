import { execFile } from 'node:child_process';
import { constants, lstatSync, openSync, readFileSync, closeSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs, promisify, type ParseArgsOptionsConfig } from 'node:util';
import { z } from 'zod';
import { crearConectorAntigravity } from './conectores/antigravity.js';
import { crearConectorCodex, type OpcionesConectorCodex } from './conectores/codex.js';
import type { Conector } from './conectores/tipos.js';
import { cargarConfig } from './config.js';
import { escaparMarkdown, escribirConsolidado, hallazgosDe } from './consolidar.js';
import * as ejecutor from './ejecutor.js';
import { aplicarCambios, proponer, type CambioRecorrido, type Catalogos, type Recorrido } from './enrutador.js';
import { ErrorFabrica } from './errores.js';
import { IA, NombreEstacion } from './esquemas.js';
import * as rastro from './rastro.js';

const ejecutarArchivo = promisify(execFile);

export interface IoCli {
  out: (texto: string) => unknown;
  err: (texto: string) => unknown;
}

export interface OpcionesCli {
  /** Carpeta personal donde vive `~/.nexakit`; por defecto la de la persona. */
  homeDirectory?: string;
  /** Variables de entorno; por defecto las del proceso. */
  environment?: NodeJS.ProcessEnv;
  /** Carpeta desde la que se busca el repo; por defecto la actual. */
  cwd?: string;
  /** Cada cuánto se mira el estado al lanzar, en milisegundos. */
  sondeoMs?: number;
}

const AYUDA = `Uso: nexakit fabrica proponer --base <rama> [--foco <texto>] [--json]
     nexakit fabrica lanzar --huella <huella> [--cambios <archivo.json>] [--json]
     nexakit fabrica estado --id <id> [--json]
     nexakit fabrica resultado --id <id> [--json]
     nexakit fabrica cancelar --id <id>

proponer lee el diff contra la rama base, consulta los modelos disponibles y muestra el
recorrido de revisión: estaciones, IA, modelo, esfuerzo, órdenes permitidas y huella.
lanzar ejecuta ese recorrido en primer plano si la huella coincide con la propuesta y el
diff sigue siendo el mismo; muestra el progreso y, al terminar, la ruta de consolidado.md.
  --cambios es un JSON con una lista de { "estacion", "quitar"?, "ia"?, "modelo"?, "esfuerzo"? }.
estado y resultado consultan un recorrido por su id; cancelar lo interrumpe (Ctrl+C también).
Códigos de salida: 0 bien, 1 fallo de estación o escritura detectada, 2 argumentos inválidos.
`;

const MENSAJE_SIN_PROPUESTA = 'No hay una propuesta con esa huella; vuelve a proponer';
const NOTA_CLAUDE = 'la ejecuta la sesión de Claude';
const SONDEO_MS = 1000;
const MAX_BYTES_CAMBIOS = 1024 * 1024;
const AGOTADO: unique symbol = Symbol('agotado');

/** Argumentos inválidos: salida con código 2. */
class ErrorUso extends Error {}

/** Quita controles, secuencias de escape y marcas de dirección: el texto del repo o de un revisor no es de fiar. */
function limpiar(texto: string): string {
  return texto.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/gu, '');
}

const celda = (texto: string): string => escaparMarkdown(limpiar(texto));

function mensajeDe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function conTope<T>(promesa: Promise<T>, ms: number): Promise<T | typeof AGOTADO> {
  let reloj: NodeJS.Timeout | undefined;
  const tope = new Promise<typeof AGOTADO>((resolve) => {
    reloj = setTimeout(() => resolve(AGOTADO), ms);
  });
  return Promise.race([promesa, tope]).finally(() => clearTimeout(reloj));
}

// ---------------------------------------------------------------------------------------------
// Conectores

type Conectores = Partial<Record<IA, Conector>>;

/** `NEXAKIT_FABRICA_*`: `[orden, ...argsPrefijo]` en JSON, o la ruta de la orden. Sin valor, el ejecutable real. */
function opcionesDeEntorno(entorno: NodeJS.ProcessEnv, variable: string): OpcionesConectorCodex {
  const valor = entorno[variable];
  if (valor === undefined || valor === '') return {};
  if (!valor.startsWith('[')) return { orden: valor };
  let lista: unknown;
  try {
    lista = JSON.parse(valor);
  } catch {
    throw new ErrorUso(`${variable} no es un JSON válido; usa ["orden", "argumento"...] o la ruta de la orden`);
  }
  if (!Array.isArray(lista) || !lista.every((x): x is string => typeof x === 'string') || lista[0] === undefined) {
    throw new ErrorUso(`${variable} debe ser una lista de textos que empiece por la orden`);
  }
  const [orden, ...argsPrefijo] = lista as string[];
  return { orden: orden as string, argsPrefijo };
}

/** Crea los conectores pedidos. Si uno no se puede crear, no entra en el resultado y se avisa. */
async function crearConectores(ias: readonly IA[], entorno: NodeJS.ProcessEnv, avisar: (texto: string) => Promise<void>): Promise<Conectores> {
  const conectores: Conectores = {};
  for (const ia of ias) {
    try {
      if (ia === 'codex') {
        conectores.codex = await crearConectorCodex(opcionesDeEntorno(entorno, 'NEXAKIT_FABRICA_CODEX'));
      } else if (ia === 'antigravity') {
        conectores.antigravity = await crearConectorAntigravity(opcionesDeEntorno(entorno, 'NEXAKIT_FABRICA_AGY'));
      }
    } catch (error) {
      if (error instanceof ErrorUso) throw error;
      await avisar(`${ia} no está disponible: ${limpiar(mensajeDe(error))}`);
    }
  }
  return conectores;
}

async function cerrar(conectores: Conectores): Promise<void> {
  await Promise.allSettled(
    Object.values(conectores).map((c) => conTope(Promise.resolve().then(() => c.cerrar()), ejecutor.TOPE_CATALOGO_MS)),
  );
}

/** Catálogos vivos con un tope de 30 s por IA. Una IA que falla queda sin catálogo y se avisa. */
async function consultarCatalogos(conectores: Conectores, avisar: (texto: string) => Promise<void>): Promise<Catalogos> {
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
// Formato

function tablaRecorrido(r: Recorrido): string[] {
  const lineas = [
    `Recorrido propuesto, huella ${r.huella}`,
    `Base: ${limpiar(r.basePedida)} (${r.base.slice(0, 12)}) · HEAD: ${r.head.slice(0, 12)}`,
  ];
  if (r.foco !== undefined) lineas.push(`Foco: ${limpiar(r.foco)}`);
  lineas.push('', '| Estación | IA | Modelo | Esfuerzo | Estado | Motivo | Notas |', '| --- | --- | --- | --- | --- | --- | --- |');
  for (const e of r.estaciones) {
    const notas: string[] = [];
    if (e.ia === 'claude') notas.push(NOTA_CLAUDE);
    if (e.ordenesPermitidas.length > 0) notas.push(`órdenes permitidas: ${e.ordenesPermitidas.map((o) => `«${o}»`).join(', ')}`);
    if (e.descartes.length > 0) notas.push(`descartes: ${e.descartes.join(' / ')}`);
    const campos = [e.estacion, e.ia ?? '-', e.modelo ?? '-', e.esfuerzo ?? '-', e.estado, e.motivo, notas.join('; ')];
    lineas.push(`| ${campos.map(celda).join(' | ')} |`);
  }
  lineas.push('', `Coste estimado: ${r.coste.llamadasExternas} llamadas externas y ${r.coste.subagentesClaude} subagentes de Claude.`);
  return lineas;
}

function lineasEstado(e: ejecutor.EstadoRecorrido): string[] {
  const lineas = [`Recorrido ${limpiar(e.id)}: ${limpiar(e.fase)}`];
  for (const x of e.estaciones) {
    const nota = x.estado === 'claude' ? NOTA_CLAUDE : x.motivo;
    lineas.push(`  - ${limpiar(x.estacion)}: ${limpiar(x.estado)}${nota === undefined ? '' : ` (${limpiar(nota)})`}`);
  }
  if (e.motivo !== undefined) lineas.push(`Motivo: ${limpiar(e.motivo)}`);
  if (e.escriturasDetectadas.length > 0) {
    lineas.push('Escrituras detectadas en el repo:', ...e.escriturasDetectadas.map((a) => `  - ${limpiar(a)}`));
  }
  return lineas;
}

/** 0 si el recorrido terminó sin fallos; 1 si falló, se canceló, sigue en curso, una estación falló o hubo escrituras. */
function codigoSalida(e: ejecutor.EstadoRecorrido): number {
  if (e.fase !== 'terminado' || e.escriturasDetectadas.length > 0) return 1;
  return e.estaciones.some((x) => x.estado === 'fallida' || x.estado === 'cancelada') ? 1 : 0;
}

// ---------------------------------------------------------------------------------------------
// Propuesta guardada y cambios

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

const Cambios = z.array(
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

function detalleZod(error: z.ZodError): string {
  return error.issues
    .map((p) => `campo «${p.path.length > 0 ? p.path.map(String).join('.') : '(raíz)'}»: ${p.message}`)
    .join('; ');
}

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

async function leerCambios(archivo: string): Promise<CambioRecorrido[]> {
  let texto: string;
  try {
    texto = await readFile(archivo, 'utf8');
  } catch (error) {
    throw new ErrorUso(`No se pudo leer el archivo de cambios ${archivo}: ${mensajeDe(error)}`);
  }
  if (Buffer.byteLength(texto, 'utf8') > MAX_BYTES_CAMBIOS) throw new ErrorUso('El archivo de cambios supera 1 MiB');
  let dato: unknown;
  try {
    dato = JSON.parse(texto.replace(/^﻿/u, ''));
  } catch (error) {
    throw new ErrorUso(`El archivo de cambios no es un JSON válido: ${mensajeDe(error)}`);
  }
  const r = Cambios.safeParse(dato);
  if (!r.success) throw new ErrorUso(`El archivo de cambios no es válido: ${detalleZod(r.error)}`);
  return r.data;
}

// ---------------------------------------------------------------------------------------------
// Órdenes

interface Contexto {
  io: IoCli;
  home: string;
  entorno: NodeJS.ProcessEnv;
  cwd: string;
  sondeoMs: number;
}

const salida = async (ctx: Contexto, texto: string): Promise<void> => {
  await ctx.io.out(`${texto}\n`);
};
const aviso = (ctx: Contexto) => async (texto: string): Promise<void> => {
  await ctx.io.err(`Aviso: ${texto}\n`);
};

async function raizDelRepo(cwd: string): Promise<string> {
  try {
    const { stdout } = await ejecutarArchivo('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' });
    const raiz = stdout.trim();
    return raiz === '' ? cwd : path.resolve(raiz);
  } catch {
    return cwd;
  }
}

async function ordenProponer(ctx: Contexto, base: string, foco: string | undefined, json: boolean): Promise<number> {
  const raiz = await raizDelRepo(ctx.cwd);
  const conectores = await crearConectores(['codex', 'antigravity'], ctx.entorno, aviso(ctx));
  let catalogos: Catalogos;
  try {
    catalogos = await consultarCatalogos(conectores, aviso(ctx));
  } finally {
    await cerrar(conectores);
  }
  const recorrido = await proponer({ raiz, base, ...(foco === undefined ? {} : { foco }), catalogos });
  await rastro.guardarPropuesta(ctx.home, await rastro.nombreRepo(raiz), recorrido);
  if (json) await salida(ctx, JSON.stringify(recorrido, null, 2));
  else {
    await salida(ctx, tablaRecorrido(recorrido).join('\n'));
    await salida(ctx, `\nPara lanzarlo: nexakit fabrica lanzar --huella ${recorrido.huella} [--cambios <archivo.json>]`);
  }
  return 0;
}

async function ordenLanzar(ctx: Contexto, huella: string, archivoCambios: string | undefined, json: boolean): Promise<number> {
  const raiz = await raizDelRepo(ctx.cwd);
  const propuesta = cargarPropuesta(ctx.home, await rastro.nombreRepo(raiz));
  if (propuesta === null || propuesta.huella !== huella) throw new ErrorFabrica(MENSAJE_SIN_PROPUESTA);
  const cambios = archivoCambios === undefined ? [] : await leerCambios(archivoCambios);
  // La huella del recorrido con los cambios ya aplicados es la que `lanzar` comprueba contra el diff.
  const recorrido = cambios.length > 0 ? aplicarCambios(propuesta, cambios) : propuesta;
  const config = await cargarConfig(raiz);

  if (!json) {
    // Lo que se va a ejecutar, con sus órdenes permitidas, queda a la vista antes de empezar.
    await salida(ctx, tablaRecorrido(recorrido).join('\n'));
    await salida(ctx, '');
  }
  const externas = new Set<IA>();
  for (const e of recorrido.estaciones) {
    if (e.estado === 'propuesta' && e.ia !== null && e.ia !== 'claude') externas.add(e.ia);
  }
  const conectores = await crearConectores([...externas], ctx.entorno, aviso(ctx));
  try {
    const { id } = await ejecutor.lanzar(recorrido, { raiz, conectores, paralelismo: config.paralelismo, home: ctx.home });
    let cancelando: Promise<void> | undefined;
    const alInterrumpir = (): void => {
      if (cancelando !== undefined) return;
      if (!json) void ctx.io.out('\nCancelando el recorrido; espero a que las estaciones cierren...\n');
      cancelando = ejecutor.cancelar(id, ctx.home).catch(() => {});
    };
    process.on('SIGINT', alInterrumpir);
    let final: ejecutor.EstadoRecorrido;
    try {
      final = await esperarConProgreso(ctx, id, json);
      await cancelando;
    } finally {
      process.off('SIGINT', alInterrumpir);
    }
    const consolidado = await escribirConsolidado(final);
    if (json) await salida(ctx, JSON.stringify({ ...final, consolidado }, null, 2));
    else {
      await salida(ctx, lineasEstado(final).join('\n'));
      if (recorrido.estaciones.some((e) => e.estado === 'propuesta' && e.ia === 'claude')) {
        await salida(ctx, `Las estaciones de Claude no se lanzaron aquí: ${NOTA_CLAUDE}.`);
      }
      await salida(ctx, `Consolidado: ${consolidado}`);
    }
    return codigoSalida(final);
  } finally {
    await cerrar(conectores);
  }
}

/** Espera al recorrido y, si no es `--json`, imprime cada cambio de estado por estación. */
async function esperarConProgreso(ctx: Contexto, id: string, json: boolean): Promise<ejecutor.EstadoRecorrido> {
  let terminado = false;
  const espera = ejecutor.esperar(id, ctx.home).finally(() => {
    terminado = true;
  });
  const vistos = new Map<string, string>();
  const mostrar = async (e: ejecutor.EstadoRecorrido): Promise<void> => {
    if (json) return;
    for (const x of e.estaciones) {
      const nota = x.estado === 'claude' ? NOTA_CLAUDE : x.motivo;
      const linea = `[${limpiar(x.estacion)}] ${limpiar(x.estado)}${nota === undefined ? '' : `: ${limpiar(nota)}`}`;
      if (vistos.get(x.estacion) === linea) continue;
      vistos.set(x.estacion, linea);
      await salida(ctx, linea);
    }
  };
  while (!terminado) {
    await mostrar(ejecutor.estado(id, ctx.home));
    let reloj: NodeJS.Timeout | undefined;
    const pausa = new Promise<void>((resolve) => {
      reloj = setTimeout(resolve, ctx.sondeoMs);
    });
    await Promise.race([espera.then(() => {}, () => {}), pausa]);
    clearTimeout(reloj);
  }
  const final = await espera;
  await mostrar(final);
  return final;
}

async function ordenEstado(ctx: Contexto, id: string, json: boolean): Promise<number> {
  const e = ejecutor.estado(id, ctx.home);
  await salida(ctx, json ? JSON.stringify(e, null, 2) : lineasEstado(e).join('\n'));
  return 0;
}

/** Lee un archivo del rastro sin seguir enlaces; `null` si no existe o no es un archivo normal. */
function leerSinEnlaces(archivo: string): string | null {
  const info = lstatSync(archivo, { throwIfNoEntry: false });
  if (info === undefined || !info.isFile()) return null;
  const fd = openSync(archivo, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}

async function ordenResultado(ctx: Contexto, id: string, json: boolean): Promise<number> {
  const e = ejecutor.estado(id, ctx.home);
  if (e.fase === 'en-curso') throw new ErrorFabrica(`El recorrido ${id} sigue en curso; espera a que termine`);
  let ruta = path.join(e.dir, 'consolidado.md');
  let texto = leerSinEnlaces(ruta);
  if (texto === null) {
    ruta = await escribirConsolidado(e);
    texto = leerSinEnlaces(ruta) ?? '';
  }
  if (json) await salida(ctx, JSON.stringify({ ...e, consolidado: ruta, hallazgos: hallazgosDe(e) }, null, 2));
  else await salida(ctx, limpiar(texto).trimEnd());
  return codigoSalida(e);
}

async function ordenCancelar(ctx: Contexto, id: string): Promise<number> {
  await ejecutor.cancelar(id, ctx.home);
  const e = ejecutor.estado(id, ctx.home);
  if (e.fase === 'en-curso') {
    // Un recorrido solo se puede interrumpir desde el proceso que lo ejecuta.
    await ctx.io.err(
      `El recorrido ${limpiar(id)} figura en curso en otro proceso y desde aquí no se puede interrumpir; pulsa Ctrl+C en la terminal donde lo lanzaste\n`,
    );
    return 1;
  }
  await salida(ctx, e.fase === 'cancelado' ? `Recorrido ${limpiar(id)} cancelado` : `El recorrido ${limpiar(id)} ya había terminado (${limpiar(e.fase)})`);
  return 0;
}

// ---------------------------------------------------------------------------------------------
// Entrada

const OPCIONES: Record<string, ParseArgsOptionsConfig> = {
  proponer: { base: { type: 'string' }, foco: { type: 'string' }, json: { type: 'boolean' } },
  lanzar: { huella: { type: 'string' }, cambios: { type: 'string' }, json: { type: 'boolean' } },
  estado: { id: { type: 'string' }, json: { type: 'boolean' } },
  resultado: { id: { type: 'string' }, json: { type: 'boolean' } },
  cancelar: { id: { type: 'string' } },
};

function valorTexto(valores: Record<string, unknown>, nombre: string): string | undefined {
  const v = valores[nombre];
  return typeof v === 'string' && v !== '' ? v : undefined;
}

function exigir(valor: string | undefined, bandera: string): string {
  if (valor === undefined) throw new ErrorUso(`Falta ${bandera}`);
  return valor;
}

/**
 * Ejecuta `nexakit fabrica`. Devuelve el código de salida: 0 bien, 1 fallo de estación o escritura
 * detectada, 2 argumentos inválidos.
 */
export async function ejecutarCli(argv: string[], io: IoCli, opciones: OpcionesCli = {}): Promise<number> {
  const ctx: Contexto = {
    io,
    home: opciones.homeDirectory ?? os.homedir(),
    entorno: opciones.environment ?? process.env,
    cwd: opciones.cwd ?? process.cwd(),
    sondeoMs: opciones.sondeoMs ?? SONDEO_MS,
  };
  const [orden, ...resto] = argv;
  if (orden === '--help' || orden === '-h') {
    await io.out(AYUDA);
    return 0;
  }
  const especificacion = orden === undefined ? undefined : Object.hasOwn(OPCIONES, orden) ? OPCIONES[orden] : undefined;
  if (orden === undefined || especificacion === undefined) {
    if (orden !== undefined) await io.err(`Orden desconocida: ${limpiar(orden)}\n`);
    await io.err(AYUDA);
    return 2;
  }

  try {
    let valores: Record<string, unknown>;
    try {
      const analizado = parseArgs({ args: resto, options: especificacion, allowPositionals: true, strict: true });
      if (analizado.positionals.length > 0) throw new ErrorUso('Sobran argumentos');
      valores = analizado.values;
    } catch (error) {
      throw error instanceof ErrorUso ? error : new ErrorUso(`Argumentos no válidos para «fabrica ${orden}»`);
    }
    const json = valores['json'] === true;
    switch (orden) {
      case 'proponer':
        return await ordenProponer(ctx, exigir(valorTexto(valores, 'base'), '--base'), valorTexto(valores, 'foco'), json);
      case 'lanzar':
        return await ordenLanzar(ctx, exigir(valorTexto(valores, 'huella'), '--huella'), valorTexto(valores, 'cambios'), json);
      case 'estado':
        return await ordenEstado(ctx, exigir(valorTexto(valores, 'id'), '--id'), json);
      case 'resultado':
        return await ordenResultado(ctx, exigir(valorTexto(valores, 'id'), '--id'), json);
      default:
        return await ordenCancelar(ctx, exigir(valorTexto(valores, 'id'), '--id'));
    }
  } catch (error) {
    if (error instanceof ErrorUso) {
      await io.err(`${error.message}\n\n${AYUDA}`);
      return 2;
    }
    await io.err(`${error instanceof ErrorFabrica ? limpiar(error.message) : `Error inesperado: ${limpiar(mensajeDe(error))}`}\n`);
    return 1;
  }
}
