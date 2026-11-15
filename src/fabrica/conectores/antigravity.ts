// Conector de la fábrica con Antigravity por `agy acp` (Agent Client Protocol por stdio, SDK oficial).
// Frontera de seguridad: el revisor nunca escribe. Toda `session/request_permission` se contesta con la opción de
// rechazo (o `cancelled` si no la hay) y cualquier otra petición del agente (escribir archivos, terminales...) con error.
//
// Comprobado contra agy 1.5.9 sin llamar al modelo (`initialize`, `session/new` y ajustes de sesión no consumen):
// - Modelo: `session/set_model` con el id completo (`gemini-4-hydrogen-xhigh`) fija el modelo y el nivel de
//   razonamiento; un id desconocido da el error -32602. `session/set_config_option` también vale, pero por partes
//   (`model` = id base y `thought_level` = esfuerzo). `agy acp` no admite `--settings`.
// - Aislamiento: con el directorio de datos de la persona, la sesión ACP arranca sus MCP (`mcp_config.json`), carga
//   sus skills y plugins y aplica sus ajustes, incluida su lista `permissions.allow`, que aprobaría órdenes sin
//   preguntar. `--include-default-customizations=false` no cambia nada de eso. `--gemini-dir <carpeta temporal>` sí:
//   sin MCP, sin skills ni plugins de la persona, con los ajustes por defecto y la autenticación del llavero intacta.
// - Siguen activas las personalizaciones del repo (`.agents/`): sus skills e instrucciones pasan por los permisos,
//   pero sus hooks y los MCP de sus plugins ejecutan código sin preguntar; por eso, si existen, no se abre la sesión.
// - El modo `default` pide permiso antes de editar y de ejecutar órdenes. Si la sesión abre o pasa a otro modo, se
//   cancela. `/teamwork`, `/boost` y `/swarm` son órdenes de barra que la fábrica no envía; que sus subagentes pasen
//   por los mismos permisos no se puede comprobar sin llamar al modelo.
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { client, ndJsonStream, PROTOCOL_VERSION, RequestError } from '@agentclientprotocol/sdk';
import type {
  ClientCapabilities,
  ClientConnection,
  ContentBlock,
  InitializeRequest,
  NewSessionRequest,
  PromptRequest,
  RequestPermissionResponse,
  SessionNotification,
} from '@agentclientprotocol/sdk';
import { resolveCliInvocation } from '../../../src/cli-executable.js';
import { hallazgosJsonSchema, InformeEstacion } from '../esquemas.js';
import type { Conector, Encargo, ResultadoEstacion } from './tipos.js';

const NO_INSTALADO = 'Antigravity no está instalado';
const HALLAZGOS_INVALIDOS = 'El revisor no devolvió hallazgos válidos';
const CANCELADA = 'La revisión se canceló';
const INSTRUCCION_ESQUEMA = 'Responde solo con JSON que cumpla este esquema';
const CORRECCION = 'Tu respuesta anterior no cumplía el esquema.';
const TIEMPO_PETICION_MS = 60_000;
const TIEMPO_CANCELACION_MS = 10_000;
const TIEMPO_CIERRE_SESION_MS = 5_000;
const GRACIA_CIERRE_MS = 2_000;
const MAX_SALIDA_ERROR = 64 * 1024;
const MAX_DETALLE = 500;
/** Argumentos de `agy acp`; detrás va `--gemini-dir <carpeta aislada>`. */
const ARGUMENTOS_ACP = ['acp', '--sandbox', '--process-per-session', '--disable-telemetry'];
/** Modo de Antigravity que pide permiso antes de editar y de ejecutar órdenes. */
const MODO_CON_PERMISOS = 'default';
const SUFIJO_ESFUERZO = /-(low|medium|high|xhigh)$/u;
/** Ni lectura ni escritura de archivos por el cliente, ni terminales. */
const CAPACIDADES_CLIENTE: ClientCapabilities = { fs: { readTextFile: false, writeTextFile: false }, terminal: false };
const RAICES_PERSONALIZACION = ['.agents', '.agent', '_agents', '_agent'];
/** Personalizaciones del repo que ejecutan código sin pasar por los permisos (o que traen otras que lo hacen). */
const PERSONALIZACIONES_PELIGROSAS = ['hooks.json', 'plugins', 'plugins.json', 'mcp_config.json'];
const TIPOS_IMAGEN: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

export interface OpcionesConectorAntigravity {
  /** Ejecutable que se lanza; por defecto se resuelve `agy` (sin shell, también `agy.cmd` en Windows). */
  orden?: string;
  /** Argumentos previos a `acp` (solo con `orden`). */
  argsPrefijo?: string[];
}

class ErrorNoInstalado extends Error {
  constructor() {
    super(NO_INSTALADO);
    this.name = 'ErrorNoInstalado';
  }
}

/** No se pudo garantizar que la sesión no tenga una vía para escribir sin pedir permiso. */
class ErrorAislamiento extends Error {
  constructor(mensaje: string) {
    super(mensaje);
    this.name = 'ErrorAislamiento';
  }
}

class ErrorProceso extends Error {
  constructor(mensaje: string) {
    super(mensaje);
    this.name = 'ErrorProceso';
  }
}

interface Invocacion {
  orden: string;
  argsPrefijo: string[];
}

async function resolverInvocacion(opciones: OpcionesConectorAntigravity): Promise<Invocacion> {
  if (opciones.orden !== undefined) return { orden: opciones.orden, argsPrefijo: opciones.argsPrefijo ?? [] };
  try {
    const { executable, argsPrefix } = await resolveCliInvocation({ name: 'agy' });
    return { orden: executable, argsPrefijo: argsPrefix };
  } catch {
    throw new ErrorNoInstalado();
  }
}

function esObjeto(valor: unknown): valor is Record<string, unknown> {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor);
}

function texto(valor: unknown): string | null {
  return typeof valor === 'string' ? valor : null;
}

function recortar(valor: string): string {
  return valor.length > MAX_DETALLE ? `${valor.slice(0, MAX_DETALLE)}…` : valor;
}

function mensajeDe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pausa(ms: number): Promise<void> {
  return new Promise((resolver) => setTimeout(resolver, ms).unref());
}

function existe(ruta: string): boolean {
  return lstatSync(ruta, { throwIfNoEntry: false }) !== undefined;
}

/**
 * Hooks, plugins o MCP en las carpetas `.agents/` (y variantes) que Antigravity cargaría para `raiz`: desde `raiz`
 * hasta la raíz del repo (la carpeta con `.git`), ambas incluidas. Las skills y las reglas no cuentan.
 */
export function personalizacionesPeligrosas(raiz: string): string[] {
  const halladas: string[] = [];
  let carpeta = path.resolve(raiz);
  for (;;) {
    for (const base of RAICES_PERSONALIZACION) {
      for (const nombre of PERSONALIZACIONES_PELIGROSAS) {
        const ruta = path.join(carpeta, base, nombre);
        if (existe(ruta)) halladas.push(ruta);
      }
    }
    if (existe(path.join(carpeta, '.git'))) break;
    const padre = path.dirname(carpeta);
    if (padre === carpeta) break;
    carpeta = padre;
  }
  return halladas;
}

function analizarInforme(crudo: string): InformeEstacion | null {
  const recortado = crudo.trim();
  const sinVallas = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/u.exec(recortado)?.[1] ?? recortado;
  let datos: unknown;
  try {
    datos = JSON.parse(sinVallas);
  } catch {
    return null;
  }
  const informe = InformeEstacion.safeParse(datos);
  return informe.success ? informe.data : null;
}

function conEsquema(texto: string): ContentBlock {
  return { type: 'text', text: `${texto}\n\n${INSTRUCCION_ESQUEMA}:\n${JSON.stringify(hallazgosJsonSchema())}` };
}

async function leerImagenes(rutas: string[]): Promise<ContentBlock[]> {
  return Promise.all(rutas.map(async (ruta): Promise<ContentBlock> => {
    const mimeType = TIPOS_IMAGEN[path.extname(ruta).toLowerCase()];
    if (mimeType === undefined) throw new Error(`formato de imagen no admitido: ${ruta}`);
    return { type: 'image', mimeType, data: (await readFile(ruta)).toString('base64') };
  }));
}

/** Modo con que abrió la sesión, según `modes` y la opción `mode`; null si no lo dice o se contradicen. */
function modoDeSesion(sesion: Record<string, unknown>): string | null {
  const modo = esObjeto(sesion['modes']) ? texto(sesion['modes']['currentModeId']) : null;
  const opciones = Array.isArray(sesion['configOptions']) ? sesion['configOptions'] : [];
  const opcion = opciones.find((o: unknown) => esObjeto(o) && o['id'] === 'mode');
  const valor = esObjeto(opcion) ? texto(opcion['currentValue']) : null;
  if (modo !== null && valor !== null && modo !== valor) return null;
  return modo ?? valor;
}

function errorModo(modo: string | null): ErrorAislamiento {
  return new ErrorAislamiento(
    `Antigravity usa el modo «${modo ?? 'desconocido'}», que no pide permiso antes de editar; se detuvo la revisión`,
  );
}

interface Fin {
  motivo: string;
  noEncontrado: boolean;
}

interface Proceso {
  conexion: ClientConnection;
  hijo: ChildProcess;
  terminado: Promise<Fin>;
  /** Carpeta de datos aislada de Antigravity (`--gemini-dir`); se borra cuando el proceso termina. */
  carpeta: string;
  salidaError: () => string;
  listo: Promise<void>;
  cierreSesiones: boolean;
  imagenes: boolean;
}

type Desenlace =
  | { tipo: 'fin'; parada: string }
  | { tipo: 'abortado' }
  | { tipo: 'inseguro'; modo: string }
  | { tipo: 'muerto'; motivo: string };

interface EnCurso {
  resultado: ResultadoEstacion;
  /** Texto del agente en el turno actual. */
  texto: string;
  alertarModo: (modo: string) => void;
  modoInseguro: Promise<Desenlace>;
}

function esperarAborto(señal: AbortSignal): { promesa: Promise<Desenlace>; quitar: () => void } {
  let quitar = () => {};
  const promesa = new Promise<Desenlace>((resolver) => {
    const alAbortar = () => resolver({ tipo: 'abortado' });
    señal.addEventListener('abort', alAbortar, { once: true });
    quitar = () => señal.removeEventListener('abort', alAbortar);
  });
  return { promesa, quitar };
}

class ConectorAntigravity implements Conector {
  readonly ia = 'antigravity' as const;
  private readonly opciones: OpcionesConectorAntigravity;
  private proceso: Proceso | undefined;
  private readonly sesiones = new Map<string, EnCurso>();
  private cerrado = false;

  constructor(opciones: OpcionesConectorAntigravity) {
    this.opciones = opciones;
  }

  async catalogo(): Promise<Array<{ modelo: string; esfuerzos: string[] }>> {
    const proceso = await this.asegurarProceso();
    // Una carpeta vacía como espacio de trabajo: el catálogo no carga personalizaciones de ningún repo.
    const vacia = path.join(proceso.carpeta, 'vacia');
    mkdirSync(vacia, { recursive: true, mode: 0o700 });
    const sesion = await this.pedir(proceso, 'session/new', { cwd: vacia, mcpServers: [] } satisfies NewSessionRequest);
    const id = esObjeto(sesion) ? texto(sesion['sessionId']) : null;
    if (id !== null) void this.cerrarSesion(proceso, id);
    const modelos = esObjeto(sesion) && esObjeto(sesion['models']) ? sesion['models']['availableModels'] : undefined;
    if (!Array.isArray(modelos)) return [];
    return modelos
      .map((m: unknown) => (esObjeto(m) ? texto(m['modelId']) : null))
      .filter((modelo): modelo is string => modelo !== null)
      .map((modelo) => {
        const esfuerzo = SUFIJO_ESFUERZO.exec(modelo)?.[1];
        return { modelo, esfuerzos: esfuerzo === undefined ? [] : [esfuerzo] };
      });
  }

  async ejecutar(encargo: Encargo, señal: AbortSignal): Promise<ResultadoEstacion> {
    const resultado: ResultadoEstacion = { estado: 'fallida', crudo: '', modeloInformado: null, tokens: null, denegaciones: [] };
    const cancelada = (): ResultadoEstacion => ({ ...resultado, estado: 'cancelada', motivo: CANCELADA });
    if (señal.aborted) return cancelada();
    let sessionId: string | null = null;
    let proceso: Proceso | undefined;
    const aborto = esperarAborto(señal);
    try {
      // Antes de abrir la sesión: los hooks del repo podrían ejecutarse al empezar.
      const peligrosas = personalizacionesPeligrosas(encargo.raiz);
      if (peligrosas.length > 0) {
        throw new ErrorAislamiento(`El repo tiene personalizaciones que ejecutan código sin pedir permiso: ${peligrosas.join(', ')}`);
      }
      const imagenes = await leerImagenes(encargo.imagenes ?? []);
      proceso = await this.asegurarProceso();
      if (imagenes.length > 0 && !proceso.imagenes) throw new Error('el agente no admite imágenes');
      if (señal.aborted) return cancelada();

      const sesion = await this.pedir(proceso, 'session/new', { cwd: encargo.raiz, mcpServers: [] } satisfies NewSessionRequest);
      const id = esObjeto(sesion) ? texto(sesion['sessionId']) : null;
      if (id === null || !esObjeto(sesion)) throw new Error('Antigravity no devolvió el identificador de la sesión');
      sessionId = id;
      let alertarModo: (modo: string) => void = () => {};
      const modoInseguro = new Promise<Desenlace>((resolver) => {
        alertarModo = (modo) => resolver({ tipo: 'inseguro', modo });
      });
      const enCurso: EnCurso = { resultado, texto: '', alertarModo, modoInseguro };
      this.sesiones.set(id, enCurso);
      const modo = modoDeSesion(sesion);
      if (modo !== MODO_CON_PERMISOS) throw errorModo(modo);

      try {
        await this.pedir(proceso, 'session/set_model', { sessionId: id, modelId: encargo.modelo });
      } catch (error) {
        if (error instanceof ErrorProceso) throw error;
        throw new Error(`no acepta el modelo «${encargo.modelo}»: ${mensajeDe(error)}`);
      }
      resultado.modeloInformado = encargo.modelo;
      if (señal.aborted) return cancelada();

      let informe: InformeEstacion | null = null;
      for (const prompt of [[conEsquema(encargo.instrucciones), ...imagenes], [conEsquema(CORRECCION)]]) {
        const desenlace = await this.turno(proceso, id, enCurso, prompt, aborto.promesa);
        resultado.crudo = enCurso.texto;
        if (desenlace.tipo === 'abortado') return cancelada();
        if (desenlace.tipo === 'inseguro') throw errorModo(desenlace.modo);
        if (desenlace.tipo === 'muerto') {
          return { ...resultado, motivo: `El proceso de Antigravity terminó antes de acabar la revisión: ${desenlace.motivo}` };
        }
        if (desenlace.parada === 'cancelled' && señal.aborted) return cancelada();
        if (desenlace.parada !== 'end_turn') return { ...resultado, motivo: `Antigravity no completó la revisión: ${desenlace.parada}` };
        informe = analizarInforme(enCurso.texto);
        if (informe !== null) break;
      }
      if (informe === null) return { ...resultado, motivo: HALLAZGOS_INVALIDOS };
      return { ...resultado, estado: 'ok', informe };
    } catch (error) {
      if (error instanceof ErrorNoInstalado) return { ...resultado, motivo: NO_INSTALADO };
      if (error instanceof ErrorAislamiento) return { ...resultado, motivo: error.message };
      if (señal.aborted) return cancelada();
      if (error instanceof ErrorProceso) {
        return { ...resultado, motivo: `El proceso de Antigravity terminó antes de acabar la revisión: ${error.message}` };
      }
      return { ...resultado, motivo: `Antigravity falló: ${mensajeDe(error)}` };
    } finally {
      aborto.quitar();
      if (sessionId !== null) {
        this.sesiones.delete(sessionId);
        if (proceso) void this.cerrarSesion(proceso, sessionId);
      }
    }
  }

  async cerrar(): Promise<void> {
    this.cerrado = true;
    const proceso = this.proceso;
    this.proceso = undefined;
    if (!proceso) return;
    proceso.conexion.close();
    proceso.hijo.stdin?.end();
    const terminado = proceso.terminado.then(() => true);
    if (!(await Promise.race([terminado, pausa(GRACIA_CIERRE_MS).then(() => false)]))) {
      proceso.hijo.kill();
      if (!(await Promise.race([terminado, pausa(GRACIA_CIERRE_MS).then(() => false)]))) proceso.hijo.kill('SIGKILL');
    }
    await proceso.terminado;
  }

  /** Un turno (`session/prompt`); si se aborta o el agente sale del modo con permisos, envía `session/cancel`. */
  private async turno(proceso: Proceso, sessionId: string, enCurso: EnCurso, prompt: ContentBlock[], abortado: Promise<Desenlace>): Promise<Desenlace> {
    enCurso.texto = '';
    const peticion = proceso.conexion.agent.request('session/prompt', { sessionId, prompt } satisfies PromptRequest);
    peticion.catch(() => undefined);
    const desenlace = await Promise.race([
      peticion.then(
        (r): Desenlace => ({ tipo: 'fin', parada: texto(esObjeto(r) ? r['stopReason'] : null) ?? 'desconocida' }),
        async (error: unknown): Promise<Desenlace> => {
          throw await this.errorDeProceso(proceso, error);
        },
      ),
      abortado,
      enCurso.modoInseguro,
      proceso.terminado.then((fin): Desenlace => ({ tipo: 'muerto', motivo: this.motivoCompleto(proceso, fin) })),
    ]);
    if (desenlace.tipo === 'abortado' || desenlace.tipo === 'inseguro') {
      await proceso.conexion.agent.notify('session/cancel', { sessionId }).catch(() => undefined);
      await Promise.race([peticion.catch(() => undefined), pausa(TIEMPO_CANCELACION_MS)]);
    }
    return desenlace;
  }

  /** Petición al agente con tiempo máximo; si el proceso muere antes, lanza `ErrorProceso`. */
  private async pedir(proceso: Proceso, metodo: string, params: unknown, timeoutMs = TIEMPO_PETICION_MS): Promise<unknown> {
    const peticion = proceso.conexion.agent.request<unknown, unknown>(metodo, params, {
      cancellationSignal: AbortSignal.timeout(timeoutMs),
      stopWaitingOnCancel: true,
    });
    peticion.catch(() => undefined);
    const muerto = proceso.terminado.then((fin): never => {
      throw new ErrorProceso(this.motivoCompleto(proceso, fin));
    });
    muerto.catch(() => undefined);
    try {
      return await Promise.race([peticion, muerto]);
    } catch (error) {
      if (error instanceof RequestError && error.code === -32800) {
        throw new Error(`la petición «${metodo}» superó el tiempo de espera de ${timeoutMs} ms`);
      }
      throw await this.errorDeProceso(proceso, error);
    }
  }

  /**
   * Un error que no viene del agente (la conexión se cerró) suele llegar justo antes de que el proceso termine:
   * se espera un poco para informar del fin del proceso en vez del cierre de la conexión.
   */
  private async errorDeProceso(proceso: Proceso, error: unknown): Promise<unknown> {
    if (error instanceof RequestError || error instanceof ErrorProceso) return error;
    const fin = await Promise.race([proceso.terminado, pausa(GRACIA_CIERRE_MS).then(() => null)]);
    return fin === null ? error : new ErrorProceso(this.motivoCompleto(proceso, fin));
  }

  private async cerrarSesion(proceso: Proceso, sessionId: string): Promise<void> {
    if (!proceso.cierreSesiones) return;
    await this.pedir(proceso, 'session/close', { sessionId }, TIEMPO_CIERRE_SESION_MS).catch(() => undefined);
  }

  private motivoCompleto(proceso: Proceso, fin: Fin): string {
    const cola = proceso.salidaError().trim();
    return cola ? `${fin.motivo}. Salida de error: ${cola}` : fin.motivo;
  }

  /** Un proceso `agy acp` por conector, con `initialize` una sola vez; si muere, el siguiente uso lo relanza. */
  private async asegurarProceso(): Promise<Proceso> {
    if (this.cerrado) throw new Error('El conector de Antigravity está cerrado');
    if (!this.proceso) {
      const invocacion = await resolverInvocacion(this.opciones);
      if (this.cerrado) throw new Error('El conector de Antigravity está cerrado');
      if (!this.proceso) {
        const proceso = this.lanzar(invocacion);
        this.proceso = proceso;
        const olvidar = () => {
          if (this.proceso === proceso) this.proceso = undefined;
        };
        void proceso.terminado.then(olvidar);
        proceso.listo.catch(olvidar);
      }
    }
    const proceso = this.proceso;
    if (!proceso) throw new Error('El proceso de Antigravity terminó al arrancar');
    await proceso.listo;
    return proceso;
  }

  private lanzar(invocacion: Invocacion): Proceso {
    // `mkdtemp` crea la carpeta con permisos 0o700.
    const carpeta = mkdtempSync(path.join(tmpdir(), 'nexakit-agy-'));
    const hijo = spawn(invocacion.orden, [...invocacion.argsPrefijo, ...ARGUMENTOS_ACP, '--gemini-dir', carpeta], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });
    let salidaError = Buffer.alloc(0);
    hijo.stderr?.on('data', (trozo: Buffer) => {
      const total = Buffer.concat([salidaError, trozo]);
      salidaError = total.length > MAX_SALIDA_ERROR ? total.subarray(total.length - MAX_SALIDA_ERROR) : total;
    });
    hijo.stdin?.on('error', () => {
      // El cierre del proceso (EPIPE incluido) se informa por 'close'.
    });
    const terminado = new Promise<Fin>((resolver) => {
      hijo.on('error', (error: NodeJS.ErrnoException) => {
        resolver({ motivo: `no se pudo lanzar el proceso: ${error.message}`, noEncontrado: error.code === 'ENOENT' });
      });
      hijo.on('close', (codigo: number | null, senal: NodeJS.Signals | null) => {
        const como = codigo !== null ? `con código de salida ${codigo}` : `por la señal ${senal ?? 'desconocida'}`;
        resolver({ motivo: `el proceso terminó ${como}`, noEncontrado: false });
      });
    });
    void terminado.then(() => rmSync(carpeta, { recursive: true, force: true }));

    if (!hijo.stdin || !hijo.stdout) throw new Error('no se pudo abrir la entrada y la salida del proceso');
    const flujo = ndJsonStream(
      Writable.toWeb(hijo.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(hijo.stdout) as ReadableStream<Uint8Array>,
    );
    const app = client({ name: 'nexakit-fabrica' })
      // Sin validar la forma: una petición de permiso inesperada también se rechaza (y queda registrada).
      .onRequest('session/request_permission', (params: unknown) => params, ({ params }) => this.rechazarPermiso(params))
      .onRequest('*', ({ method, params }) => this.denegarPeticion(method, params))
      .onNotification('session/update', ({ params }) => this.alActualizar(params));
    const conexion = app.connect(flujo);
    void terminado.then(() => conexion.close());

    const proceso: Proceso = {
      conexion,
      hijo,
      terminado,
      carpeta,
      salidaError: () => salidaError.toString('utf8'),
      listo: Promise.resolve(),
      cierreSesiones: false,
      imagenes: false,
    };
    proceso.listo = this.inicializar(proceso);
    return proceso;
  }

  private async inicializar(proceso: Proceso): Promise<void> {
    const params: InitializeRequest = {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: CAPACIDADES_CLIENTE,
      clientInfo: { name: 'nexakit-fabrica', title: 'Fábrica de revisión de nexakit', version: '1' },
    };
    let respuesta: unknown;
    try {
      respuesta = await this.pedir(proceso, 'initialize', params);
    } catch (error) {
      await this.forzarFin(proceso);
      const fin = await Promise.race([proceso.terminado, pausa(0).then(() => null)]);
      if (fin?.noEncontrado) throw new ErrorNoInstalado();
      throw error;
    }
    const capacidades = esObjeto(respuesta) && esObjeto(respuesta['agentCapabilities']) ? respuesta['agentCapabilities'] : {};
    const sesiones = esObjeto(capacidades['sessionCapabilities']) ? capacidades['sessionCapabilities'] : {};
    const prompt = esObjeto(capacidades['promptCapabilities']) ? capacidades['promptCapabilities'] : {};
    proceso.cierreSesiones = esObjeto(sesiones['close']);
    proceso.imagenes = prompt['image'] === true;
  }

  private async forzarFin(proceso: Proceso): Promise<void> {
    proceso.conexion.close();
    proceso.hijo.kill();
    await Promise.race([proceso.terminado, pausa(GRACIA_CIERRE_MS)]);
  }

  private alActualizar(params: SessionNotification): void {
    const enCurso = this.sesiones.get(params.sessionId);
    if (!enCurso) return;
    const actualizacion = params.update;
    switch (actualizacion.sessionUpdate) {
      case 'agent_message_chunk':
        if (actualizacion.content.type === 'text') enCurso.texto += actualizacion.content.text;
        break;
      case 'usage_update':
        enCurso.resultado.tokens = { entrada: 0, salida: 0, total: actualizacion.used };
        break;
      case 'current_mode_update':
        if (actualizacion.currentModeId !== MODO_CON_PERMISOS) enCurso.alertarModo(actualizacion.currentModeId);
        break;
      case 'config_option_update': {
        const modo = actualizacion.configOptions.find((o) => o.id === 'mode');
        const valor = modo && 'currentValue' in modo ? modo.currentValue : MODO_CON_PERMISOS;
        if (valor !== MODO_CON_PERMISOS) enCurso.alertarModo(String(valor));
        break;
      }
      default:
        break;
    }
  }

  /** Toda petición de permiso se rechaza: la opción de rechazo si la hay; si no, `cancelled`. */
  private rechazarPermiso(params: unknown): RequestPermissionResponse {
    const p = esObjeto(params) ? params : {};
    const sessionId = texto(p['sessionId']);
    const enCurso = sessionId === null ? undefined : this.sesiones.get(sessionId);
    const llamada = esObjeto(p['toolCall']) ? p['toolCall'] : {};
    const detalle = texto(llamada['title']) ?? texto(llamada['kind']) ?? 'sin detalle';
    enCurso?.resultado.denegaciones.push({ tipo: 'session/request_permission', detalle: recortar(`Permiso denegado: ${detalle}`) });
    const opciones = Array.isArray(p['options']) ? p['options'].filter(esObjeto) : [];
    for (const tipo of ['reject_once', 'reject_always']) {
      const opcion = opciones.find((o) => o['kind'] === tipo && typeof o['optionId'] === 'string');
      if (opcion) return { outcome: { outcome: 'selected', optionId: opcion['optionId'] as string } };
    }
    return { outcome: { outcome: 'cancelled' } };
  }

  /** Cualquier otra petición del agente (escribir archivos, terminales, preguntas...) se contesta con error. */
  private denegarPeticion(metodo: string, params: unknown): never {
    const sessionId = esObjeto(params) ? texto(params['sessionId']) : null;
    const enCurso = sessionId === null ? undefined : this.sesiones.get(sessionId);
    enCurso?.resultado.denegaciones.push({ tipo: metodo, detalle: recortar(`Petición denegada: ${metodo}`) });
    throw new RequestError(-32601, `La fábrica de revisión no atiende «${metodo}»`);
  }
}

export async function crearConectorAntigravity(opciones: OpcionesConectorAntigravity = {}): Promise<Conector> {
  return new ConectorAntigravity(opciones);
}
