import os from 'node:os';
import path from 'node:path';
import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { escribirConsolidado, hallazgosDe } from './consolidar.js';
import * as ejecutor from './ejecutor.js';
import { ErrorEntorno, ErrorFabrica } from './errores.js';
import { Hallazgo } from './esquemas.js';
import * as rastro from './rastro.js';
import { EsquemaCambios, lanzarAprobado, type Lanzamiento, leerSinEnlaces, limpiar, mensajeDe, proponerEnRaiz, raizDelRepo } from './sesion.js';

export const NOMBRE_SERVIDOR = 'nexakit-fabrica';
const VERSION_SERVIDOR = '0.1.0';
/** Tope de hallazgos que la sesión de Claude puede aportar al consolidado. */
const MAX_HALLAZGOS_CLAUDE = 500;

export const INSTRUCCIONES = [
  'La fábrica de nexakit pasa un diff por estaciones de revisión (seguridad, arquitectura, pruebas, código, interfaz, rendimiento, documentación) con varias IA en solo lectura.',
  'Muestra el recorrido a la persona y lanza solo tras su aprobación explícita; nunca encadenes recorridos sin que lo pida.',
  'Flujo: fabrica_proponer calcula el recorrido y su huella; enséñalo entero (estaciones, IA, modelo, esfuerzo y órdenes permitidas) y espera la aprobación; fabrica_lanzar con esa huella devuelve un id sin esperar; fabrica_estado consulta el avance; fabrica_resultado devuelve los hallazgos consolidados y la ruta de consolidado.md; fabrica_cancelar interrumpe.',
  'Las estaciones de Claude las lanzas tú como subagentes; pasa sus hallazgos a fabrica_resultado.',
  'No sondees en bucle: consulta el estado cuando la persona lo pida o cuando termines tus propias estaciones.',
  'Todas las herramientas trabajan sobre el repo del directorio de trabajo del servidor; ninguna acepta una ruta.',
].join(' ');

const MENSAJE_OCUPADO = 'Ya hay un recorrido en curso; espera a que termine o cancélalo';

const AVISO_RAIZ = 'El repo es el del directorio de trabajo del servidor; esta herramienta no acepta una raíz.';

export interface OpcionesServidorFabrica {
  /** Carpeta personal donde vive `~/.nexakit`; por defecto la de la persona. */
  homeDirectory?: string;
  /** Directorio de trabajo del que se deduce el repo; por defecto el del proceso. */
  cwd?: string;
  /** Variables de entorno con los conectores (`NEXAKIT_FABRICA_*`); por defecto las del proceso. */
  environment?: NodeJS.ProcessEnv;
  /** Dónde van los avisos de los conectores; por defecto stderr. */
  avisar?: (texto: string) => void;
}

export interface ServidorFabrica {
  server: McpServer;
  /** Cancela los recorridos en curso y espera a que sus conectores se cierren. */
  detener(): Promise<void>;
}

function texto(valor: unknown): CallToolResult {
  return { content: [{ type: 'text', text: limpiar(typeof valor === 'string' ? valor : JSON.stringify(valor, null, 2)) }] };
}

function falla(error: unknown): CallToolResult {
  const mensaje =
    error instanceof ErrorFabrica || error instanceof ErrorEntorno ? error.message : `Error inesperado: ${mensajeDe(error)}`;
  return { isError: true, content: [{ type: 'text', text: limpiar(mensaje) }] };
}

async function invocar(operacion: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return texto(await operacion());
  } catch (error) {
    return falla(error);
  }
}

const RecorridoGuardado = z.object({
  estaciones: z.array(z.object({ estacion: z.string(), ia: z.string().nullable(), estado: z.string() })),
});

/** Estaciones del recorrido que la sesión de Claude debe atender: las propuestas con `ia === 'claude'`. */
function estacionesDeClaude(dir: string): string[] {
  let dato: unknown;
  try {
    dato = rastro.leerRecorrido(dir);
  } catch {
    dato = null;
  }
  const r = RecorridoGuardado.safeParse(dato);
  if (!r.success) throw new ErrorFabrica('No se pudo leer el recorrido guardado en el rastro');
  return r.data.estaciones.filter((x) => x.ia === 'claude' && x.estado === 'propuesta').map((x) => x.estacion);
}

/** Hallazgos de Claude que ya se pasaron a este recorrido; una lista vacía si no hay o no son válidos. */
function hallazgosGuardados(dir: string): Hallazgo[] {
  try {
    const r = z.array(Hallazgo).safeParse(rastro.leerHallazgosClaude(dir));
    return r.success ? r.data : [];
  } catch {
    return [];
  }
}

/** Crea el servidor MCP de la fábrica, sin conectarlo a ningún transporte. */
export function crearServidorFabrica(opciones: OpcionesServidorFabrica = {}): ServidorFabrica {
  const home = opciones.homeDirectory ?? os.homedir();
  const entorno = opciones.environment ?? process.env;
  const cwd = (): string => opciones.cwd ?? process.cwd();
  const registrar = opciones.avisar ?? ((t: string) => void process.stderr.write(`${NOMBRE_SERVIDOR}: ${limpiar(t)}\n`));
  const enCurso = new Map<string, Promise<void>>();
  let cerrado = false;
  // Un solo recorrido a la vez: se reserva de forma síncrona al empezar a lanzar y se libera cuando
  // el recorrido termina y sus conectores se cierran, así el tope de estaciones externas no se supera.
  let ocupado = false;
  // Los lanzamientos a medias (también los rechazados, que acaban enseguida): el cierre espera a todos para no
  // dejar un recorrido sin atender.
  const enVuelo = new Set<Promise<unknown>>();

  async function lanzar(huella: string, cambios: z.infer<typeof EsquemaCambios> | undefined): Promise<{ id: string }> {
    // Sin ningún await antes de la reserva: dos llamadas simultáneas no pueden pasar las dos.
    if (cerrado) throw new ErrorFabrica('El servidor se está cerrando; no se lanzan más recorridos');
    if (ocupado) throw new ErrorFabrica(MENSAJE_OCUPADO);
    ocupado = true;
    let lanzamiento: Lanzamiento;
    try {
      lanzamiento = await lanzarAprobado({
        raiz: await raizDelRepo(cwd()),
        huella,
        cambios,
        home,
        entorno,
        avisar: async (aviso) => {
          registrar(aviso);
        },
      });
    } catch (error) {
      ocupado = false;
      throw error;
    }
    const { id, terminado } = lanzamiento;
    enCurso.set(id, terminado);
    void terminado.then(() => {
      enCurso.delete(id);
      ocupado = false;
    });
    if (cerrado) {
      // El servidor se cerró mientras se lanzaba: este recorrido no tiene a nadie que lo atienda.
      await ejecutor.cancelar(id, home).catch(() => {});
      await terminado;
      throw new ErrorFabrica('El servidor se está cerrando; el recorrido se canceló');
    }
    return { id };
  }

  const server = new McpServer({ name: NOMBRE_SERVIDOR, version: VERSION_SERVIDOR }, { instructions: INSTRUCCIONES });

  server.registerTool(
    'fabrica_proponer',
    {
      description: `Calcula el recorrido de revisión del diff contra la rama base (estaciones, IA, modelo, esfuerzo, órdenes permitidas y huella) y lo guarda como la propuesta del repo. No lanza nada: muéstraselo a la persona. ${AVISO_RAIZ}`,
      inputSchema: z.object({
        base: z.string().min(1).describe('Rama o commit contra el que se compara el diff, por ejemplo main'),
        foco: z.string().min(1).optional().describe('Texto opcional que orienta a los revisores'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    ({ base, foco }) =>
      invocar(async () => {
        const avisos: string[] = [];
        const recorrido = await proponerEnRaiz({
          raiz: await raizDelRepo(cwd()),
          base,
          foco,
          home,
          entorno,
          avisar: async (aviso) => {
            avisos.push(limpiar(aviso));
          },
        });
        return { recorrido, avisos };
      }),
  );

  server.registerTool(
    'fabrica_lanzar',
    {
      description: `Lanza el recorrido de la última propuesta si su huella coincide y el diff sigue siendo el mismo. Hazlo solo tras la aprobación explícita de la persona. Devuelve { id } sin esperar: el recorrido corre dentro de este servidor. Solo hay un recorrido a la vez: si ya hay uno en curso, da error hasta que termine o lo canceles. Con cambios puedes quitar estaciones o cambiar IA, modelo y esfuerzo antes de lanzar. ${AVISO_RAIZ}`,
      inputSchema: z.object({
        huella: z.string().min(1).describe('Huella del recorrido que la persona aprobó'),
        cambios: EsquemaCambios.optional().describe('Lista de { estacion, quitar?, ia?, modelo?, esfuerzo? } que la persona pidió'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    ({ huella, cambios }) =>
      invocar(async () => {
        const lanzamiento = lanzar(huella, cambios);
        enVuelo.add(lanzamiento);
        try {
          return await lanzamiento;
        } finally {
          enVuelo.delete(lanzamiento);
        }
      }),
  );

  server.registerTool(
    'fabrica_estado',
    {
      description: 'Estado de un recorrido por su id: fase, estado de cada estación y escrituras detectadas en el repo. Consúltalo cuando la persona lo pida, no en bucle.',
      inputSchema: z.object({ id: z.string().min(1).describe('Id devuelto por fabrica_lanzar') }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ id }) => invocar(async () => ejecutor.estado(id, home)),
  );

  server.registerTool(
    'fabrica_resultado',
    {
      description:
        'Hallazgos consolidados de un recorrido terminado y la ruta de su consolidado.md. Las estaciones de Claude las lanzas tú como subagentes: pasa en hallazgosClaude todos sus hallazgos, solo de las estaciones de Claude de este recorrido (cada llamada con hallazgos sustituye a los anteriores, los guarda en el rastro y regenera el consolidado; sin hallazgosClaude se reutilizan los guardados). Si el recorrido sigue en curso, devuelve un error.',
      inputSchema: z.object({
        id: z.string().min(1).describe('Id devuelto por fabrica_lanzar'),
        hallazgosClaude: z.array(Hallazgo).max(MAX_HALLAZGOS_CLAUDE).optional().describe('Hallazgos de las estaciones que lanzaste tú como subagentes'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    ({ id, hallazgosClaude }) =>
      invocar(async () => {
        const e = ejecutor.estado(id, home);
        if (e.fase === 'en-curso') {
          throw new ErrorFabrica(`El recorrido sigue en curso (${id}); consulta fabrica_estado y vuelve a pedir el resultado cuando termine`);
        }
        let claude: Hallazgo[];
        if (hallazgosClaude === undefined) claude = hallazgosGuardados(e.dir);
        else {
          const permitidas = estacionesDeClaude(e.dir);
          const ajenas = [...new Set(hallazgosClaude.map((h) => h.estacion).filter((x) => !permitidas.includes(x)))];
          if (ajenas.length > 0) {
            throw new ErrorFabrica(
              `Solo se aceptan hallazgos de las estaciones de Claude de este recorrido (${permitidas.join(', ') || 'ninguna'}); no se aceptan los de: ${ajenas.join(', ')}`,
            );
          }
          await rastro.guardarHallazgosClaude(e.dir, hallazgosClaude);
          claude = hallazgosClaude;
        }
        let consolidado = path.join(e.dir, 'consolidado.md');
        // Sin hallazgos nuevos se conserva el consolidado ya escrito, que incluye los de la llamada anterior.
        if (hallazgosClaude !== undefined || leerSinEnlaces(consolidado) === null) {
          consolidado = await escribirConsolidado(e, claude);
        }
        return { id: e.id, fase: e.fase, consolidado, hallazgos: hallazgosDe(e, claude) };
      }),
  );

  server.registerTool(
    'fabrica_cancelar',
    {
      description: 'Cancela un recorrido en curso: aborta sus estaciones y espera a que cierren. Si ya terminó, no hace nada.',
      inputSchema: z.object({ id: z.string().min(1).describe('Id devuelto por fabrica_lanzar') }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    ({ id }) =>
      invocar(async () => {
        await ejecutor.cancelar(id, home);
        const e = ejecutor.estado(id, home);
        if (e.fase === 'en-curso') {
          throw new ErrorFabrica(`El recorrido ${id} figura en curso en otro proceso y desde aquí no se puede interrumpir`);
        }
        return e.fase === 'cancelado' ? `Recorrido ${id} cancelado` : `El recorrido ${id} ya había terminado (${e.fase})`;
      }),
  );

  async function detener(): Promise<void> {
    cerrado = true;
    await Promise.allSettled([...enVuelo]);
    const pendientes = [...enCurso.entries()];
    await Promise.allSettled(pendientes.map(([id]) => ejecutor.cancelar(id, home)));
    await Promise.allSettled(pendientes.map(([, terminado]) => terminado));
  }

  return { server, detener };
}

/**
 * Sirve la fábrica por stdio hasta que el cliente cierre la entrada o llegue SIGTERM/SIGINT. Al cerrarse,
 * cancela los recorridos en curso y cierra los conectores.
 */
export async function ejecutarServidorMcp(opciones: OpcionesServidorFabrica = {}): Promise<void> {
  const { server, detener } = crearServidorFabrica(opciones);
  let terminar: () => void = () => {};
  const fin = new Promise<void>((resolve) => {
    terminar = resolve;
  });
  server.server.onclose = terminar;
  const alSenal = (): void => terminar();
  process.once('SIGTERM', alSenal);
  process.once('SIGINT', alSenal);
  try {
    await server.connect(new StdioServerTransport());
    await fin;
  } finally {
    process.off('SIGTERM', alSenal);
    process.off('SIGINT', alSenal);
    await detener();
    await server.close();
  }
}
