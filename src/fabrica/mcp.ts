import os from 'node:os';
import path from 'node:path';
import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { escribirConsolidado, hallazgosDe, hallazgosGuardados } from './consolidar.js';
import * as ejecutor from './ejecutor.js';
import { type FabricasConectores, type InformeEncargo, type OpcionesEncargo, ejecutarEncargo, leerInformeEncargo, RE_ID_ENCARGO } from './encargo/ejecutar.js';
import { ErrorEntorno, ErrorFabrica } from './errores.js';
import { Hallazgo } from './esquemas.js';
import * as rastro from './rastro.js';
import { EsquemaCambios, lanzarAprobado, type Lanzamiento, leerSinEnlaces, limpiar, mensajeDe, proponerEnRaiz, raizDelRepo } from './sesion.js';
import { aprenderDeVeredictos, EsquemaVeredictos } from './veredictos.js';

export const NOMBRE_SERVIDOR = 'nexakit-fabrica';
const VERSION_SERVIDOR = '0.1.0';
/** Tope de hallazgos que la sesión de Claude puede aportar al consolidado. */
const MAX_HALLAZGOS_CLAUDE = 500;

export const INSTRUCCIONES = [
  'La fábrica de nexakit pasa un diff por estaciones de revisión (seguridad, arquitectura, pruebas, código, interfaz, rendimiento, documentación) con varias IA en solo lectura.',
  'Lánzala tú por tu cuenta al cerrar una tarea con cambios de código y antes de un PR, con la huella de la propuesta; solo hay un recorrido a la vez y no encadenes recorridos para el mismo diff. Pide aprobación a la persona solo si el recorrido trae órdenes de .nexakit/fabrica.json del repo revisado.',
  'Flujo: fabrica_proponer calcula el recorrido y su huella; revisa el recorrido entero (estaciones, IA, modelo, esfuerzo y órdenes permitidas); fabrica_lanzar con esa huella devuelve un id sin esperar; fabrica_estado consulta el avance; fabrica_resultado devuelve los hallazgos consolidados y la ruta de consolidado.md; fabrica_cancelar interrumpe.',
  'Las estaciones de Claude las lanzas tú como subagentes; pasa sus hallazgos a fabrica_resultado.',
  'Para delegar una tarea de programación con diseño claro en Codex o Antigravity usa fabrica_encargar: devuelve un id sin esperar, la IA escribe solo en una copia aislada del repo, fabrica_estado, fabrica_resultado (informe y ruta de cambios.diff, que revisas y aplicas tú con git apply) y fabrica_cancelar aceptan ese id, y comparte el candado de un solo recorrido o encargo a la vez. Las órdenes por defecto del repo (npm test y npm run typecheck) y las de ordenes se le comunican a la IA como guía: en Codex la frontera real es el sandbox (solo escribe en la copia, sin red; en macOS solo lee de la carpeta personal la copia, node_modules, el .git del repo y las instalaciones de node y Codex, y en Linux y Windows puede leer el disco), no una lista que se haga cumplir; en Antigravity solo se aprueban esas órdenes exactas, en su sandbox sin red y solo en macOS (en Linux y Windows no ejecuta órdenes). Si pasas ordenes extra, enséñalas a la persona y pide su aprobación antes de pasarlas.',
  'Tras verificar los hallazgos contra el código, vuelve a llamar a fabrica_resultado con los veredictos ({ clave, verificado: real | falso | dudoso }) para que la fábrica aprenda qué modelos aciertan.',
  'No sondees en bucle: consulta el estado cuando la persona lo pida o cuando termines tus propias estaciones.',
  'Todas las herramientas trabajan sobre el repo del directorio de trabajo del servidor; ninguna acepta una ruta.',
].join(' ');

const MENSAJE_OCUPADO = 'Ya hay un recorrido en curso; espera a que termine o cancélalo';
const MENSAJE_OCUPADO_ENCARGO = 'Ya hay un encargo en curso; espera a que termine o cancélalo';
const MAX_TEXTO_ENCARGO = 200_000;
const TIEMPO_ENCARGO_MAX_MIN = 120;

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
  /** Solo para pruebas: conectores falsos y ajustes de `fabrica_encargar` (nunca se lanza una CLI real). */
  encargo?: { conectores?: FabricasConectores; recomendar?: OpcionesEncargo['recomendar']; graciaMs?: number; intervaloActivoMs?: number };
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
  let ocupante: 'recorrido' | 'encargo' = 'recorrido';
  // Encargos de este servidor: en curso (con su control) o terminados (con su informe).
  interface EncargoVivo {
    control: AbortController;
    terminado: Promise<void>;
    informe?: InformeEncargo;
    error?: string;
  }
  const encargos = new Map<string, EncargoVivo>();
  // Todos los encargos lanzados (incluso antes de tener id): el cierre los cancela.
  const lanzados = new Set<EncargoVivo>();
  // Los lanzamientos a medias (también los rechazados, que acaban enseguida): el cierre espera a todos para no
  // dejar un recorrido sin atender.
  const enVuelo = new Set<Promise<unknown>>();

  async function lanzar(huella: string, cambios: z.infer<typeof EsquemaCambios> | undefined): Promise<{ id: string }> {
    // Sin ningún await antes de la reserva: dos llamadas simultáneas no pueden pasar las dos.
    if (cerrado) throw new ErrorFabrica('El servidor se está cerrando; no se lanzan más recorridos');
    if (ocupado) throw new ErrorFabrica(ocupante === 'encargo' ? MENSAJE_OCUPADO_ENCARGO : MENSAJE_OCUPADO);
    ocupado = true;
    ocupante = 'recorrido';
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

  /** Lanza un encargo en segundo plano y devuelve su id en cuanto existe su worktree. Comparte el candado con los recorridos. */
  async function encargar(datos: Omit<OpcionesEncargo, 'raiz' | 'home' | 'señal' | 'alCrear'>): Promise<{ id: string }> {
    // Sin ningún await antes de la reserva: dos llamadas simultáneas no pueden pasar las dos.
    if (cerrado) throw new ErrorFabrica('El servidor se está cerrando; no se lanzan más encargos');
    if (ocupado) throw new ErrorFabrica(ocupante === 'encargo' ? MENSAJE_OCUPADO_ENCARGO : MENSAJE_OCUPADO);
    ocupado = true;
    ocupante = 'encargo';
    const vivo: EncargoVivo = { control: new AbortController(), terminado: Promise.resolve() };
    lanzados.add(vivo);
    let darId: (id: string) => void = () => {};
    let fallarId: (error: unknown) => void = () => {};
    const conId = new Promise<string>((resolve, reject) => {
      darId = resolve;
      fallarId = reject;
    });
    vivo.terminado = (async () => ejecutarEncargo({ ...datos, raiz: await raizDelRepo(cwd()), home, señal: vivo.control.signal, alCrear: (id) => {
      // Se registra de forma síncrona al crear el worktree: antes de que la IA arranque ya se puede consultar o cancelar.
      encargos.set(id, vivo);
      darId(id);
    } }))().then(
      (informe) => {
        vivo.informe = informe;
        fallarId(new ErrorFabrica('El encargo terminó sin crear su copia aislada'));
      },
      (error: unknown) => {
        vivo.error = error instanceof ErrorFabrica ? error.message : `Error inesperado: ${mensajeDe(error)}`;
        fallarId(error);
      },
    ).finally(() => {
      ocupado = false;
    });
    // Si el encargo falla antes de tener worktree (fuera de un repo, por ejemplo), la llamada devuelve ese error.
    return { id: await conId };
  }

  /** El encargo `id` de este servidor, o `undefined` (puede ser un recorrido, o un encargo de otro proceso). */
  const encargoDe = (id: string): EncargoVivo | undefined => encargos.get(id);

  function estadoEncargo(id: string, vivo: EncargoVivo): Record<string, unknown> {
    if (vivo.informe !== undefined) return { id, tipo: 'encargo', fase: 'terminado', informe: vivo.informe };
    if (vivo.error !== undefined) return { id, tipo: 'encargo', fase: 'terminado', estado: 'fallido', motivo: vivo.error };
    const activo = rastro.leerActivo(home);
    const estacion = activo?.id === id ? activo.estaciones[0] : undefined;
    return { id, tipo: 'encargo', fase: 'en-curso', ...(estacion === undefined ? {} : { ia: estacion.ia, modelo: estacion.modelo, esfuerzo: estacion.esfuerzo, tokens: estacion.tokens }) };
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
      description: `Lanza el recorrido de la última propuesta si su huella coincide y el diff sigue siendo el mismo. Hazlo con la huella de la propuesta, sin encadenar recorridos para el mismo diff, y pide aprobación a la persona solo si el recorrido trae órdenes de .nexakit/fabrica.json del repo revisado. Devuelve { id } sin esperar: el recorrido corre dentro de este servidor. Solo hay un recorrido a la vez: si ya hay uno en curso, da error hasta que termine o lo canceles. Con cambios puedes quitar estaciones o cambiar IA, modelo y esfuerzo antes de lanzar. ${AVISO_RAIZ}`,
      inputSchema: z.object({
        huella: z.string().min(1).describe('Huella del recorrido que la persona aprobó'),
        cambios: EsquemaCambios.optional().describe('Lista de { estacion, quitar?, ia?, modelo?, esfuerzo? }. Usa codigo-codex o codigo-antigravity en estacion para ajustar una revisión adicional.'),
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
    'fabrica_encargar',
    {
      description: `Delega una tarea de programación con diseño claro en Codex o Antigravity. La IA escribe solo en una copia aislada del repo (un git worktree de HEAD, sin los cambios sin commit) y el resultado es un diff que revisas y aplicas tú con git apply: nunca se escribe en el repo de la persona. Devuelve { id } sin esperar; el encargo corre dentro de este servidor. fabrica_estado consulta el avance, fabrica_resultado devuelve el informe (estado ok, sin-cambios, tiempo-agotado, cancelado, invalido o fallido, resumen de la IA y ruta de cambios.diff) y fabrica_cancelar lo interrumpe, todos con ese id. Un encargo invalido (escritura fuera de la copia, enlaces hacia fuera o cambios en rutas sensibles como .git o .claude) no trae diff. Comparte el candado de un solo recorrido o encargo a la vez con fabrica_lanzar. Pon en texto el objetivo, los archivos, el criterio de hecho y las pruebas. Las órdenes por defecto (npm test y npm run typecheck, si el repo las declara) y las de ordenes son una guía para la IA: en Codex la frontera real es el sandbox (solo escribe en la copia y su carpeta temporal, sin red; en macOS solo lee de la carpeta personal la copia, node_modules, el .git del repo y las instalaciones de node y Codex, y en Linux y Windows puede leer el disco) y en Antigravity solo se aprueban esas órdenes exactas, en su sandbox sin red y solo en macOS con la versión de agy verificada (en Linux y Windows no ejecuta órdenes). Cualquier orden extra en ordenes, enséñalas a la persona y pide su aprobación antes de pasarlas. Revisa el diff, el resumen y las alertas (CLAUDE.md, AGENTS.md, .envrc...) antes de aplicarlo. ${AVISO_RAIZ}`,
      inputSchema: z.object({
        ia: z.enum(['codex', 'antigravity', 'auto']).describe('IA que programa; auto prueba Codex y, si no responde, Antigravity'),
        modelo: z.string().min(1).optional().describe('Modelo; sin él se usa la recomendación de nivel normal de la IA'),
        esfuerzo: z.string().min(1).optional().describe('Esfuerzo del modelo (en Antigravity va dentro del id del modelo y se ignora)'),
        texto: z.string().min(1).max(MAX_TEXTO_ENCARGO).describe('Texto del encargo: objetivo, archivos, criterio de hecho y pruebas'),
        ordenes: z.array(z.string().min(1)).max(100).optional().describe('Órdenes extra, además de npm test y npm run typecheck, que se comunican a la IA (en Codex no se hacen cumplir: manda el sandbox): solo con la aprobación de la persona'),
        tiempoMin: z.number().int().min(1).max(TIEMPO_ENCARGO_MAX_MIN).optional().describe('Minutos máximos; por defecto 20'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    ({ ia, modelo, esfuerzo, texto: instrucciones, ordenes, tiempoMin }) =>
      invocar(() =>
        encargar({
          ia,
          modelo,
          esfuerzo,
          texto: instrucciones,
          ordenesPermitidas: ordenes,
          ...(tiempoMin === undefined ? {} : { tiempoMs: tiempoMin * 60_000 }),
          entorno,
          ...opciones.encargo,
        }),
      ),
  );

  server.registerTool(
    'fabrica_estado',
    {
      description: 'Estado de un recorrido por su id: fase, estado de cada estación y escrituras detectadas en el repo. Con el id de un encargo devuelve su fase (en-curso o terminado) y, si terminó, su informe. Consúltalo cuando la persona lo pida, no en bucle.',
      inputSchema: z.object({ id: z.string().min(1).describe('Id devuelto por fabrica_lanzar o fabrica_encargar') }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ id }) =>
      invocar(async () => {
        const vivo = encargoDe(id);
        if (vivo !== undefined) return estadoEncargo(id, vivo);
        const guardado = leerInformeEncargo(home, id);
        if (guardado !== null) return { id, tipo: 'encargo', fase: 'terminado', informe: guardado };
        return ejecutor.estado(id, home);
      }),
  );

  server.registerTool(
    'fabrica_resultado',
    {
      description:
        'Con el id de un encargo terminado devuelve su informe (estado, resumen de la IA, archivos, avisos y ruta de cambios.diff, listo para git apply); hallazgosClaude y veredictos no valen para un encargo. Hallazgos consolidados de un recorrido terminado y la ruta de su consolidado.md. Las estaciones de Claude las lanzas tú como subagentes: pasa en hallazgosClaude todos sus hallazgos, solo de las estaciones de Claude de este recorrido (cada llamada con hallazgos sustituye a los anteriores, los guarda en el rastro y regenera el consolidado; sin hallazgosClaude se reutilizan los guardados). Cada hallazgo lleva su clave. Tras verificarlos contra el código, pasa en veredictos { clave, verificado: real | falso | dudoso } por hallazgo: los reales y los falsos actualizan la evidencia de cada modelo que lo reportó (los dudosos no cuentan; repetir un veredicto no suma dos veces; uno cambiado deshace el anterior) y la respuesta trae aprendizaje con los avisos. Si el recorrido sigue en curso, devuelve un error.',
      inputSchema: z.object({
        id: z.string().min(1).describe('Id devuelto por fabrica_lanzar o fabrica_encargar'),
        hallazgosClaude: z.array(Hallazgo).max(MAX_HALLAZGOS_CLAUDE).optional().describe('Hallazgos de las estaciones que lanzaste tú como subagentes'),
        veredictos: EsquemaVeredictos.optional().describe('Veredicto de la sesión por hallazgo ya verificado, con la clave que devolvió esta herramienta'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    ({ id, hallazgosClaude, veredictos }) =>
      invocar(async () => {
        const vivo = encargoDe(id);
        if (vivo !== undefined) {
          if (hallazgosClaude !== undefined || veredictos !== undefined) {
            throw new ErrorFabrica('Un encargo no tiene hallazgos ni veredictos: pide solo su informe con el id');
          }
          if (vivo.error !== undefined) throw new ErrorFabrica(`El encargo falló: ${vivo.error}`);
          if (vivo.informe === undefined) {
            throw new ErrorFabrica(`El encargo sigue en curso (${id}); consulta fabrica_estado y vuelve a pedir el resultado cuando termine`);
          }
          return { id, tipo: 'encargo', informe: vivo.informe };
        }
        if (RE_ID_ENCARGO.test(id)) {
          // Un encargo de un servidor anterior: su informe sigue en disco.
          if (hallazgosClaude !== undefined || veredictos !== undefined) {
            throw new ErrorFabrica('Un encargo no tiene hallazgos ni veredictos: pide solo su informe con el id');
          }
          const guardado = leerInformeEncargo(home, id);
          if (guardado === null) {
            throw new ErrorFabrica(`No hay un encargo con el id ${id} en este servidor ni un informe guardado en ~/.nexakit/encargos/${id}/informe.json`);
          }
          return { id, tipo: 'encargo', informe: guardado };
        }
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
        const hallazgos = hallazgosDe(e, claude);
        // Con hallazgos de Claude nuevos también se revisa lo ya contado: puede haber veredictos sobre hallazgos corregidos.
        if (veredictos === undefined && hallazgosClaude === undefined) return { id: e.id, fase: e.fase, consolidado, hallazgos };
        const raiz = await raizDelRepo(cwd());
        const repo = await rastro.nombreRepo(raiz);
        const aprendizaje = await aprenderDeVeredictos({ home, repo, raiz, estado: e, hallazgos, veredictos: veredictos ?? [] });
        const informar = veredictos !== undefined || aprendizaje.revertidos > 0 || aprendizaje.avisos.length > 0;
        return { id: e.id, fase: e.fase, consolidado, hallazgos, ...(informar ? { aprendizaje } : {}) };
      }),
  );

  server.registerTool(
    'fabrica_cancelar',
    {
      description: 'Cancela un recorrido o un encargo en curso: aborta sus estaciones (o la IA que programa), espera a que cierren y, en un encargo, borra su copia aislada. Si ya terminó, no hace nada.',
      inputSchema: z.object({ id: z.string().min(1).describe('Id devuelto por fabrica_lanzar o fabrica_encargar') }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    ({ id }) =>
      invocar(async () => {
        const vivo = encargoDe(id);
        if (vivo !== undefined) {
          const yaTerminado = vivo.informe !== undefined || vivo.error !== undefined;
          vivo.control.abort();
          await vivo.terminado;
          const final = vivo.informe?.estado ?? 'fallido';
          return yaTerminado ? `El encargo ${id} ya había terminado (${final})` : `Encargo ${id} cancelado (estado final: ${final})`;
        }
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
    // Los encargos se cancelan primero: no se espera a que una IA termine de programar para cerrar el servidor.
    for (const vivo of lanzados) vivo.control.abort();
    await Promise.allSettled([...lanzados].map((v) => v.terminado));
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
