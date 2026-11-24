import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';
import { z } from 'zod';
import { escaparMarkdown, escribirConsolidado, type HallazgoConsolidado, hallazgosDe, hallazgosGuardados } from './consolidar.js';
import * as ejecutor from './ejecutor.js';
import type { CambioRecorrido, Recorrido } from './enrutador.js';
import { describirPlan, ejecutarBanco, planificarBanco, verificarPlanAprobado, type EjecucionMedida, type ResultadoBanco } from './banco/ejecutar.js';
import { type FabricasConectores, type InformeEncargo, type OpcionesEncargo, ejecutarEncargo } from './encargo/ejecutar.js';
import { ErrorEntorno, ErrorFabrica } from './errores.js';
import { cargar } from './evidencia.js';
import { esCriterio, guardarCriterio, leerCriterio } from './preferencias.js';
import { consumirPlanBanco, guardarPlanBanco, nombreRepo } from './rastro.js';
import {
  cerrarConectores,
  consultarCatalogos,
  crearConectoresDesdeEntorno,
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
  /** Solo para pruebas: conectores falsos y ajustes de `encargar` (nunca se lanza una CLI real). */
  encargo?: { conectores?: FabricasConectores; recomendar?: OpcionesEncargo['recomendar']; graciaMs?: number; intervaloActivoMs?: number };
}

const AYUDA = `Uso: nexakit fabrica proponer --base <rama> [--foco <texto>] [--json]
     nexakit fabrica lanzar --huella <huella> [--cambios <archivo.json>] [--json]
     nexakit fabrica estado --id <id> [--json]
     nexakit fabrica resultado --id <id> [--veredictos <archivo.json>] [--json]
     nexakit fabrica cancelar --id <id>
     nexakit fabrica preferencias [--criterio calidad|barato] [--json]
     nexakit encargar --ia codex|antigravity|auto --encargo <archivo.md> [--modelo <modelo>] [--esfuerzo <esfuerzo>]
                      [--ordenes <archivo.json>] [--tiempo <min>] [--json]
     nexakit fabrica banco planificar [--fase 1|2] [--estacion <estacion>] [--json]
     nexakit fabrica banco ejecutar --huella <huella> [--json]

proponer lee el diff contra la rama base, consulta los modelos disponibles y muestra el
recorrido de revisión: estaciones, IA, modelo, esfuerzo, órdenes permitidas y huella. Cada
modelo externo se elige con la evidencia medida, el umbral del riesgo y el criterio global;
sin datos manda la tabla manual y se avisa de que conviene medir.
preferencias muestra el criterio global o lo guarda con --criterio (por defecto, barato).
lanzar ejecuta ese recorrido en primer plano si la huella coincide con la propuesta y el
diff sigue siendo el mismo; muestra el progreso y, al terminar, la ruta de consolidado.md.
  --cambios es un JSON con una lista de { "estacion", "quitar"?, "ia"?, "modelo"?, "esfuerzo"? }.
estado y resultado consultan un recorrido por su id; cancelar lo interrumpe (Ctrl+C también).
  --veredictos es un JSON con una lista de { "clave", "verificado": "real" | "falso" | "dudoso" }, con las claves de
  consolidado.md: los reales y los falsos actualizan la evidencia de cada modelo que reportó el hallazgo.
banco mide los modelos con casos con fallos sembrados y suma el resultado a la evidencia. planificar no ejecuta
nada: muestra las llamadas, el coste estimado y la huella, y guarda el plan en ~/.nexakit/fabrica/banco-plan.json.
ejecutar solo lanza ese plan guardado si la huella coincide, en primer plano, y lo consume antes de empezar. La fase 1 mide
cada modelo con su esfuerzo más bajo; la fase 2 (necesita la fase 1) mide los finalistas por estación (el mejor par de cada IA y los mejores restantes hasta 3).
encargar delega una tarea de programación en Codex o Antigravity. La IA escribe solo en una copia aislada del repo (un git
worktree de HEAD en ~/.nexakit/encargos/<id>/repo, que se borra siempre) y la orden devuelve el diff en
~/.nexakit/encargos/<id>/cambios.diff, listo para «git apply», junto con informe.json y el resumen de la IA. Nunca escribe en tu repo:
tú revisas el diff y lo aplicas. Los cambios sin commit no se copian (parte de HEAD); una escritura fuera de la copia, un enlace
simbólico hacia fuera o un cambio en .git, .claude, .codex, .gemini, .agents, .nexakit, .vscode, .husky o .github/workflows dejan
el encargo «invalido» sin diff. Hay un encargo o recorrido a la vez.
  --ia auto prueba Codex y, si no responde, Antigravity; sin --modelo usa la recomendación de nivel normal de esa IA.
  --encargo es el archivo con el texto (objetivo, archivos, criterio de hecho y pruebas); admite hasta 1 MiB.
  --ordenes es un JSON con una lista de órdenes exactas que se añaden a «npm test» y «npm run typecheck» del repo.
  --tiempo son los minutos máximos (entero de 1 a 120; por defecto 20). Ctrl+C cancela y borra la copia.
Códigos de salida: 0 bien, 1 fallo de estación o escritura detectada, 2 argumentos inválidos. Con encargar, 0 solo si el
estado es «ok» o «sin-cambios».
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
  for (const a of e.avisos ?? []) lineas.push(`Aviso: ${limpiar(a)}`);
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
  encargo: NonNullable<OpcionesCli['encargo']>;
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

async function aprenderConVeredictos(
  ctx: Contexto,
  estado: ejecutor.EstadoRecorrido,
  hallazgos: HallazgoConsolidado[],
  veredictos: Veredicto[],
): ReturnType<typeof aprenderDeVeredictos> {
  const raiz = await raizDelRepo(ctx.cwd);
  return aprenderDeVeredictos({ home: ctx.home, repo: await nombreRepo(raiz), raiz, estado, hallazgos, veredictos });
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
    veredictos === undefined ? undefined : await aprenderConVeredictos(ctx, e, hallazgos, veredictos);
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
// Encargar

const TIEMPO_POR_DEFECTO_MIN = 20;
const TIEMPO_MAXIMO_MIN = 120;
const EsquemaOrdenes = z.array(z.string().min(1)).max(100);
const IAS_ENCARGO = ['codex', 'antigravity', 'auto'] as const;

async function leerTextoEncargo(archivo: string): Promise<string> {
  let bytes: Buffer;
  try {
    bytes = await readFile(archivo);
  } catch (error) {
    throw new ErrorUso(`No se pudo leer el archivo del encargo ${archivo}: ${mensajeDe(error)}`);
  }
  if (bytes.length > MAX_BYTES_CAMBIOS) throw new ErrorUso('El archivo del encargo supera 1 MiB');
  const texto = bytes.toString('utf8').replace(/^﻿/u, '');
  if (texto.trim() === '') throw new ErrorUso('El archivo del encargo está vacío');
  return texto;
}

/** Estados con los que `encargar` sale con 0. */
const estadoBueno = (estado: InformeEncargo['estado']): boolean => estado === 'ok' || estado === 'sin-cambios';

export function lineasInforme(i: InformeEncargo): string[] {
  const lineas = [`Encargo ${limpiar(i.id)}: ${limpiar(i.estado)}`];
  if (i.ia !== null) {
    lineas.push(`IA: ${enUnaLinea(i.ia)} · modelo: ${enUnaLinea(i.modelo ?? '-')}${i.esfuerzo === null ? '' : ` · esfuerzo: ${enUnaLinea(i.esfuerzo)}`}`);
  }
  lineas.push(`Duración: ${i.segundos} s${i.tokens === null ? ' · tokens: sin cifra' : ` · tokens: ${i.tokens.total}`}`);
  if (i.motivo !== undefined) lineas.push(`Motivo: ${enUnaLinea(i.motivo)}`);
  if (i.ordenesPorDefecto.length > 0) lineas.push(`Órdenes por defecto: ${i.ordenesPorDefecto.map((o) => `«${enUnaLinea(o)}»`).join(', ')}`);
  if (i.ordenesExtra.length > 0) lineas.push(`Órdenes extra (aprobadas por quien encargó): ${i.ordenesExtra.map((o) => `«${enUnaLinea(o)}»`).join(', ')}`);
  if (i.rutaDiff !== null) {
    lineas.push(`Diff: ${i.rutaDiff}`, `Para aplicarlo tras revisarlo: git apply ${i.rutaDiff}`);
    if (i.archivos.length > 0) lineas.push('Archivos:', ...i.archivos.map((a) => `  - ${enUnaLinea(a)}`));
  }
  if (i.rutasVetadas.length > 0) lineas.push('Rutas vetadas (no se guarda ningún diff):', ...i.rutasVetadas.map((r) => `  - ${enUnaLinea(r)}`));
  if (i.escriturasFuera.length > 0) lineas.push('Escrituras fuera de la copia:', ...i.escriturasFuera.map((r) => `  - ${enUnaLinea(r)}`));
  if (i.denegaciones.length > 0) lineas.push(`Denegaciones: ${i.denegaciones.length}`);
  for (const a of i.avisos) lineas.push(`Aviso: ${enUnaLinea(a)}`);
  if (i.resumen !== '') lineas.push('', 'Resumen de la IA:', limpiar(i.resumen).trimEnd());
  lineas.push('', `Informe: ${i.rutaInforme}`);
  return lineas;
}

async function ordenEncargar(ctx: Contexto, valores: Record<string, unknown>, json: boolean): Promise<number> {
  // Un valor vacío explícito no es «sin bandera»: se rechaza en vez de caer al valor por defecto.
  const ia = valores['ia'] === undefined ? 'auto' : String(valores['ia']);
  if (!(IAS_ENCARGO as readonly string[]).includes(ia)) throw new ErrorUso('--ia debe ser codex, antigravity o auto');
  const tiempoTexto = valores['tiempo'] === undefined ? undefined : String(valores['tiempo']);
  let tiempoMin = TIEMPO_POR_DEFECTO_MIN;
  if (tiempoTexto !== undefined) {
    tiempoMin = /^\d{1,3}$/u.test(tiempoTexto) ? Number(tiempoTexto) : 0;
    if (tiempoMin < 1 || tiempoMin > TIEMPO_MAXIMO_MIN) throw new ErrorUso(`--tiempo debe ser un entero de 1 a ${TIEMPO_MAXIMO_MIN} (minutos)`);
  }
  const texto = await leerTextoEncargo(exigir(valorTexto(valores, 'encargo'), '--encargo'));
  const archivoOrdenes = valorTexto(valores, 'ordenes');
  const ordenes = archivoOrdenes === undefined ? undefined : await leerJsonValidado(archivoOrdenes, 'órdenes', EsquemaOrdenes);
  const raiz = await raizDelRepo(ctx.cwd);

  const control = new AbortController();
  const alInterrumpir = (): void => {
    // El segundo aviso termina el proceso aunque el cierre ordenado siga en curso.
    if (control.signal.aborted) {
      ctx.salir(130);
      return;
    }
    if (!json) void ctx.io.out('\nCancelando el encargo; espero a que la IA cierre y borro la copia aislada...\n');
    control.abort();
  };
  process.on('SIGINT', alInterrumpir);
  process.on('SIGTERM', alInterrumpir);
  let informe: InformeEncargo;
  try {
    if (!json) await salida(ctx, `Encargo a ${ia}: preparando la copia aislada del repo (máximo ${tiempoMin} min; Ctrl+C cancela)...`);
    informe = await ejecutarEncargo({
      raiz,
      ia: ia as (typeof IAS_ENCARGO)[number],
      modelo: valorTexto(valores, 'modelo'),
      esfuerzo: valorTexto(valores, 'esfuerzo'),
      texto,
      ordenesPermitidas: ordenes,
      tiempoMs: tiempoMin * 60_000,
      home: ctx.home,
      entorno: ctx.entorno,
      señal: control.signal,
      ...ctx.encargo,
      alCrear: (id) => {
        if (!json) void ctx.io.out(`Encargo ${limpiar(id)}: la IA trabaja en ~/.nexakit/encargos/${limpiar(id)}/repo\n`);
      },
    });
  } finally {
    process.off('SIGINT', alInterrumpir);
    process.off('SIGTERM', alInterrumpir);
  }
  if (json) await salida(ctx, JSON.stringify(informe, null, 2));
  else await salida(ctx, lineasInforme(informe).join('\n'));
  return estadoBueno(informe.estado) ? 0 : 1;
}

// ---------------------------------------------------------------------------------------------
// Banco

async function ordenBancoPlanificar(ctx: Contexto, faseTexto: string | undefined, estacion: string | undefined, json: boolean): Promise<number> {
  if (faseTexto !== undefined && faseTexto !== '1' && faseTexto !== '2') throw new ErrorUso('--fase debe ser 1 o 2');
  const fase = faseTexto === '2' ? 2 : 1;
  const { evidencia, aviso: avisoEvidencia } = await cargar(ctx.home);
  if (fase === 2 && !evidencia.filas.some((f) => f.banco > 0)) {
    throw new ErrorFabrica('La fase 2 necesita medidas del banco: planifica y ejecuta antes la fase 1');
  }
  if (avisoEvidencia !== null) await aviso(ctx)(enUnaLinea(avisoEvidencia));
  const conectores = await crearConectoresDesdeEntorno({ entorno: ctx.entorno, avisar: aviso(ctx) });
  let catalogos;
  try {
    catalogos = await consultarCatalogos(conectores, aviso(ctx));
  } finally {
    await cerrarConectores(conectores);
  }
  const plan = planificarBanco({ fase, catalogos, evidencia, ...(estacion === undefined ? {} : { estaciones: [estacion] }) });
  const ruta = await guardarPlanBanco(ctx.home, plan);
  if (json) await salida(ctx, JSON.stringify({ ...plan, archivo: ruta }, null, 2));
  else {
    await salida(ctx, limpiar(describirPlan(plan)));
    await salida(ctx, `\nPlan guardado en ${ruta}`);
    await salida(ctx, `Para ejecutarlo, con la aprobación de la persona: nexakit fabrica banco ejecutar --huella ${plan.huella}`);
  }
  return 0;
}

interface ResumenEstacion {
  estacion: string;
  aciertos: number;
  fallos: number;
  invalidas: number;
  tokens: number;
}

/** Suma por estación los aciertos, fallos, ejecuciones inválidas y tokens de lo medido. */
function resumirBanco(ejecuciones: readonly EjecucionMedida[]): ResumenEstacion[] {
  const por = new Map<string, ResumenEstacion>();
  for (const e of ejecuciones) {
    const estacion = e.caso.split('/')[0] ?? e.caso;
    const r = por.get(estacion) ?? { estacion, aciertos: 0, fallos: 0, invalidas: 0, tokens: 0 };
    if (e.valida) {
      r.aciertos += e.observacion?.aciertos ?? 0;
      r.fallos += e.observacion?.fallos ?? 0;
    } else r.invalidas += 1;
    r.tokens += e.tokens ?? 0;
    por.set(estacion, r);
  }
  return [...por.values()];
}

async function ordenBancoEjecutar(ctx: Contexto, huella: string, json: boolean): Promise<number> {
  // El plan solo llega del archivo que dejó `planificar`: nunca por argumentos ni por stdin.
  // Se consume antes de nada: una aprobación vale para una sola ejecución, aunque falle la verificación o se corte.
  const guardado = await consumirPlanBanco(ctx.home);
  if (guardado === null) throw new ErrorFabrica('No hay un plan del banco guardado; planifícalo antes con «nexakit fabrica banco planificar»');
  const plan = verificarPlanAprobado(guardado, huella);
  const ias = [...new Set(plan.ejecuciones.map((e) => e.ia))];
  const conectores = await crearConectoresDesdeEntorno({ ias, entorno: ctx.entorno, avisar: aviso(ctx) });
  let resultado: ResultadoBanco;
  // Ctrl+C aborta la ejecución en curso (y borra su repo temporal) y no lanza las siguientes.
  const control = new AbortController();
  const alInterrumpir = (): void => {
    // El segundo Ctrl+C termina el proceso aunque el cierre ordenado siga en curso.
    if (control.signal.aborted) {
      ctx.salir(130);
      return;
    }
    if (!json) void ctx.io.out('\nInterrumpido por Ctrl+C; cierro la ejecución en curso y borro su repo temporal...\n');
    control.abort();
  };
  process.on('SIGINT', alInterrumpir);
  try {
    resultado = await ejecutarBanco(plan, {
      huella,
      conectores,
      home: ctx.home,
      señal: control.signal,
      alAvanzar: (m, i, total) => {
        if (json) return;
        const estado = m.valida ? 'válida' : `inválida (${m.motivo ?? 'sin motivo'})`;
        void ctx.io.out(`[${i + 1}/${total}] ${enUnaLinea(m.caso)}: ${enUnaLinea(m.ia)} ${enUnaLinea(m.modelo)}${m.esfuerzo === null ? '' : ` ${enUnaLinea(m.esfuerzo)}`} - ${estado}\n`);
      },
    });
  } finally {
    process.off('SIGINT', alInterrumpir);
    await cerrarConectores(conectores);
  }
  const resumen = resumirBanco(resultado.ejecuciones);
  const invalidas = resumen.reduce((n, r) => n + r.invalidas, 0);
  if (json) await salida(ctx, JSON.stringify({ ...resultado, resumen }, null, 2));
  else {
    await salida(ctx, `\nResumen del banco, fase ${resultado.fase}:`);
    for (const r of resumen) {
      await salida(ctx, `  ${enUnaLinea(r.estacion)}: ${r.aciertos} aciertos, ${r.fallos} fallos, ${r.invalidas} inválidas, ${r.tokens} tokens`);
    }
    for (const a of resultado.avisos) await aviso(ctx)(enUnaLinea(a));
    const validas = resultado.ejecuciones.filter((e) => e.valida && e.observacion !== undefined).length;
    await salida(
      ctx,
      validas > 0
        ? `La evidencia quedó actualizada con ${validas} ${validas === 1 ? 'ejecución válida' : 'ejecuciones válidas'}. El plan ya se consumió: para medir de nuevo hay que planificar otra vez.`
        : 'Ninguna ejecución fue válida: la evidencia no cambió. El plan ya se consumió: para medir de nuevo hay que planificar otra vez.',
    );
  }
  return invalidas > 0 || control.signal.aborted ? 1 : 0;
}

// ---------------------------------------------------------------------------------------------
// Entrada

async function ordenPreferencias(ctx: Contexto, valor: unknown, json: boolean): Promise<number> {
  if (valor !== undefined && !esCriterio(valor)) {
    throw new ErrorUso('El criterio debe ser «calidad» o «barato»');
  }
  const criterio = valor ?? await leerCriterio(ctx.home);
  if (valor !== undefined) await guardarCriterio(ctx.home, criterio);
  await salida(ctx, json ? JSON.stringify({ criterio }) : `Criterio de la fábrica: ${criterio}`);
  return 0;
}

const OPCIONES: Record<string, ParseArgsOptionsConfig> = {
  preferencias: { criterio: { type: 'string' }, json: { type: 'boolean' } },
  proponer: { base: { type: 'string' }, foco: { type: 'string' }, json: { type: 'boolean' } },
  lanzar: { huella: { type: 'string' }, cambios: { type: 'string' }, json: { type: 'boolean' } },
  estado: { id: { type: 'string' }, json: { type: 'boolean' } },
  resultado: { id: { type: 'string' }, veredictos: { type: 'string' }, json: { type: 'boolean' } },
  cancelar: { id: { type: 'string' } },
  encargar: {
    ia: { type: 'string' },
    modelo: { type: 'string' },
    esfuerzo: { type: 'string' },
    encargo: { type: 'string' },
    ordenes: { type: 'string' },
    tiempo: { type: 'string' },
    json: { type: 'boolean' },
  },
  'banco planificar': { fase: { type: 'string' }, estacion: { type: 'string' }, json: { type: 'boolean' } },
  'banco ejecutar': { huella: { type: 'string' }, json: { type: 'boolean' } },
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
    encargo: opciones.encargo ?? {},
    salir: opciones.salir ?? ((codigo) => process.exit(codigo)),
  };
  const [primera, ...siguientes] = argv;
  // `banco` lleva su propia orden: `banco planificar` y `banco ejecutar`.
  const compuesta = primera === 'banco';
  const orden = compuesta ? `banco ${siguientes[0] ?? ''}`.trimEnd() : primera;
  const resto = compuesta ? siguientes.slice(1) : siguientes;
  if (orden === '--help' || orden === '-h' || (compuesta && (siguientes[0] === '--help' || siguientes[0] === '-h'))) {
    await io.out(AYUDA);
    return 0;
  }
  // `banco` solo, sin subcomando: la ayuda, sin «Orden desconocida».
  if (compuesta && siguientes[0] === undefined) {
    await io.err(AYUDA);
    return 2;
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
      case 'preferencias':
        return await ordenPreferencias(ctx, valores['criterio'], json);
      case 'proponer':
        return await ordenProponer(ctx, exigir(valorTexto(valores, 'base'), '--base'), valorTexto(valores, 'foco'), json);
      case 'lanzar':
        return await ordenLanzar(ctx, exigir(valorTexto(valores, 'huella'), '--huella'), valorTexto(valores, 'cambios'), json);
      case 'encargar':
        return await ordenEncargar(ctx, valores, json);
      case 'banco planificar':
        return await ordenBancoPlanificar(ctx, valorTexto(valores, 'fase'), valorTexto(valores, 'estacion'), json);
      case 'banco ejecutar':
        return await ordenBancoEjecutar(ctx, exigir(valorTexto(valores, 'huella'), '--huella'), json);
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
