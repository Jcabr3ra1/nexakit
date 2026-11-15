import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';
import type { z } from 'zod';
import { escaparMarkdown, escribirConsolidado, hallazgosDe, hallazgosGuardados } from './consolidar.js';
import * as ejecutor from './ejecutor.js';
import type { CambioRecorrido, Recorrido } from './enrutador.js';
import { ErrorEntorno, ErrorFabrica } from './errores.js';
import {
  EsquemaCambios,
  limpiar,
  lanzarAprobado,
  leerSinEnlaces,
  mensajeDe,
  proponerEnRaiz,
  raizDelRepo,
} from './sesion.js';
import { aprenderDeVeredictos, EsquemaVeredictos, type Veredicto } from './veredictos.js';

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
  /** Termina el proceso con un código; por defecto `process.exit`. */
  salir?: (codigo: number) => void;
  /** Cada cuánto se mira el estado al lanzar, en milisegundos. */
  sondeoMs?: number;
}

const AYUDA = `Uso: nexakit fabrica proponer --base <rama> [--foco <texto>] [--json]
     nexakit fabrica lanzar --huella <huella> [--cambios <archivo.json>] [--json]
     nexakit fabrica estado --id <id> [--json]
     nexakit fabrica resultado --id <id> [--veredictos <archivo.json>] [--json]
     nexakit fabrica cancelar --id <id>

proponer lee el diff contra la rama base, consulta los modelos disponibles y muestra el
recorrido de revisión: estaciones, IA, modelo, esfuerzo, órdenes permitidas y huella. Cada
modelo se elige con la evidencia medida (el más barato que basta según el riesgo) y se explica;
sin datos manda la tabla manual y se avisa de que conviene medir.
lanzar ejecuta ese recorrido en primer plano si la huella coincide con la propuesta y el
diff sigue siendo el mismo; muestra el progreso y, al terminar, la ruta de consolidado.md.
  --cambios es un JSON con una lista de { "estacion", "quitar"?, "ia"?, "modelo"?, "esfuerzo"? }.
estado y resultado consultan un recorrido por su id; cancelar lo interrumpe (Ctrl+C también).
  --veredictos es un JSON con una lista de { "clave", "verificado": "real" | "falso" | "dudoso" }, con las claves de
  consolidado.md: los reales y los falsos actualizan la evidencia de cada modelo que reportó el hallazgo.
Códigos de salida: 0 bien, 1 fallo de estación o escritura detectada, 2 argumentos inválidos.
`;

const NOTA_CLAUDE = 'la ejecuta la sesión de Claude';
const SONDEO_MS = 1000;
const MAX_BYTES_CAMBIOS = 1024 * 1024;

/** Argumentos inválidos: salida con código 2. */
class ErrorUso extends Error {}

/**
 * Texto de una sola línea: `limpiar` deja pasar `\n` y `\t`, y un nombre de modelo con ellos partiría una celda, una
 * explicación o un aviso y permitiría colar una línea «Aviso:» o una fila de la tabla falsas.
 */
const enUnaLinea = (texto: string): string => limpiar(texto).replace(/[\r\n\t\p{Zl}\p{Zp}]+/gu, ' ');

const celda = (texto: string): string => escaparMarkdown(enUnaLinea(texto));

const COLUMNAS_EXPLICACION = 160;

/** Recorta a `max` columnas (caracteres) con «…» al final si no cabe. */
function recortar(texto: string, max: number): string {
  const letras = [...texto];
  return letras.length <= max ? texto : `${letras.slice(0, max - 1).join('')}…`;
}

// ---------------------------------------------------------------------------------------------
// Formato

export function tablaRecorrido(r: Recorrido): string[] {
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
  const elecciones = r.estaciones.filter((e) => e.explicacion !== '');
  if (elecciones.length > 0) {
    lineas.push('', 'Por qué cada modelo:');
    for (const e of elecciones) lineas.push(recortar(`  ${enUnaLinea(e.estacion)}: ${enUnaLinea(e.explicacion)}`, COLUMNAS_EXPLICACION));
  }
  if (r.avisos.length > 0) lineas.push('', ...r.avisos.map((a) => `Aviso: ${enUnaLinea(a)}`));
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

function detalleZod(error: z.ZodError): string {
  return error.issues
    .map((p) => `campo «${p.path.length > 0 ? p.path.map(String).join('.') : '(raíz)'}»: ${p.message}`)
    .join('; ');
}

/** Lee un archivo JSON de la persona (`cambios`, `veredictos`...) con tope de tamaño y lo valida con su esquema. */
async function leerJsonValidado<T>(archivo: string, nombre: string, esquema: z.ZodType<T>): Promise<T> {
  let texto: string;
  try {
    texto = await readFile(archivo, 'utf8');
  } catch (error) {
    throw new ErrorUso(`No se pudo leer el archivo de ${nombre} ${archivo}: ${mensajeDe(error)}`);
  }
  if (Buffer.byteLength(texto, 'utf8') > MAX_BYTES_CAMBIOS) throw new ErrorUso(`El archivo de ${nombre} supera 1 MiB`);
  let dato: unknown;
  try {
    dato = JSON.parse(texto.replace(/^﻿/u, ''));
  } catch (error) {
    throw new ErrorUso(`El archivo de ${nombre} no es un JSON válido: ${mensajeDe(error)}`);
  }
  const r = esquema.safeParse(dato);
  if (!r.success) throw new ErrorUso(`El archivo de ${nombre} no es válido: ${detalleZod(r.error)}`);
  return r.data;
}

const leerCambios = (archivo: string): Promise<CambioRecorrido[]> => leerJsonValidado(archivo, 'cambios', EsquemaCambios);
const leerVeredictos = (archivo: string): Promise<Veredicto[]> => leerJsonValidado(archivo, 'veredictos', EsquemaVeredictos);

// ---------------------------------------------------------------------------------------------
// Órdenes

interface Contexto {
  io: IoCli;
  home: string;
  entorno: NodeJS.ProcessEnv;
  cwd: string;
  sondeoMs: number;
  salir: (codigo: number) => void;
}

const salida = async (ctx: Contexto, texto: string): Promise<void> => {
  await ctx.io.out(`${texto}\n`);
};
const aviso = (ctx: Contexto) => async (texto: string): Promise<void> => {
  await ctx.io.err(`Aviso: ${texto}\n`);
};

async function ordenProponer(ctx: Contexto, base: string, foco: string | undefined, json: boolean): Promise<number> {
  const raiz = await raizDelRepo(ctx.cwd);
  const recorrido = await proponerEnRaiz({ raiz, base, foco, home: ctx.home, entorno: ctx.entorno, avisar: aviso(ctx) });
  if (json) await salida(ctx, JSON.stringify(recorrido, null, 2));
  else {
    await salida(ctx, tablaRecorrido(recorrido).join('\n'));
    await salida(ctx, `\nPara lanzarlo: nexakit fabrica lanzar --huella ${recorrido.huella} [--cambios <archivo.json>]`);
  }
  return 0;
}

async function ordenLanzar(ctx: Contexto, huella: string, archivoCambios: string | undefined, json: boolean): Promise<number> {
  const raiz = await raizDelRepo(ctx.cwd);
  const cambios = archivoCambios === undefined ? [] : await leerCambios(archivoCambios);
  const lanzamiento = await lanzarAprobado({
    raiz,
    huella,
    cambios,
    home: ctx.home,
    entorno: ctx.entorno,
    avisar: aviso(ctx),
    antesDeLanzar: async (recorrido) => {
      if (json) return;
      // Lo que se va a ejecutar, con sus órdenes permitidas, queda a la vista antes de empezar.
      await salida(ctx, tablaRecorrido(recorrido).join('\n'));
      await salida(ctx, '');
    },
  });
  const { id, recorrido } = lanzamiento;
  try {
    let cancelando: Promise<void> | undefined;
    const alInterrumpir = (): void => {
      // El segundo Ctrl+C termina el proceso aunque el cierre ordenado siga en curso.
      if (cancelando !== undefined) {
        ctx.salir(130);
        return;
      }
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
  } catch (error) {
    // Si algo falla con el recorrido en marcha, se interrumpe en vez de dejarlo sin quien lo atienda.
    await ejecutor.cancelar(id, ctx.home).catch(() => {});
    throw error;
  } finally {
    await lanzamiento.terminado;
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

async function ordenResultado(ctx: Contexto, id: string, archivoVeredictos: string | undefined, json: boolean): Promise<number> {
  const veredictos = archivoVeredictos === undefined ? undefined : await leerVeredictos(archivoVeredictos);
  const e = ejecutor.estado(id, ctx.home);
  if (e.fase === 'en-curso') throw new ErrorFabrica(`El recorrido ${id} sigue en curso; espera a que termine`);
  let ruta = path.join(e.dir, 'consolidado.md');
  let texto = leerSinEnlaces(ruta);
  if (texto === null) {
    ruta = await escribirConsolidado(e, hallazgosGuardados(e.dir));
    texto = leerSinEnlaces(ruta) ?? '';
  }
  const hallazgos = hallazgosDe(e, hallazgosGuardados(e.dir));
  const aprendizaje =
    veredictos === undefined ? undefined : await aprenderDeVeredictos({ home: ctx.home, estado: e, hallazgos, veredictos });
  if (json) await salida(ctx, JSON.stringify({ ...e, consolidado: ruta, hallazgos, ...(aprendizaje === undefined ? {} : { aprendizaje }) }, null, 2));
  else {
    await salida(ctx, limpiar(texto).trimEnd());
    if (aprendizaje !== undefined) {
      await salida(
        ctx,
        `\nEvidencia: ${aprendizaje.aplicados} veredictos aplicados, ${aprendizaje.repetidos} repetidos, ${aprendizaje.dudosos} dudosos, ${aprendizaje.ignorados} ignorados.`,
      );
      for (const a of aprendizaje.avisos) await aviso(ctx)(enUnaLinea(a));
    }
  }
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
  resultado: { id: { type: 'string' }, veredictos: { type: 'string' }, json: { type: 'boolean' } },
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
    salir: opciones.salir ?? ((codigo) => process.exit(codigo)),
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
        return await ordenResultado(ctx, exigir(valorTexto(valores, 'id'), '--id'), valorTexto(valores, 'veredictos'), json);
      default:
        return await ordenCancelar(ctx, exigir(valorTexto(valores, 'id'), '--id'));
    }
  } catch (error) {
    if (error instanceof ErrorUso || error instanceof ErrorEntorno) {
      await io.err(`${error.message}\n\n${AYUDA}`);
      return 2;
    }
    await io.err(`${error instanceof ErrorFabrica ? limpiar(error.message) : `Error inesperado: ${limpiar(mensajeDe(error))}`}\n`);
    return 1;
  }
}
