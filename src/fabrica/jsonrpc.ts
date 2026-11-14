import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

/** Tope de la salida de error que se conserva para explicar un fallo. */
const MAX_SALIDA_ERROR = 64 * 1024;
const GRACIA_CIERRE_MS = 2000;

export type IdJsonRpc = string | number;

export interface OpcionesLanzar {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Espera tras cerrar stdin antes de terminar el proceso a la fuerza. */
  graciaCierreMs?: number;
}

export interface OpcionesSolicitud {
  timeoutMs?: number;
}

export interface ResultadoTerminado {
  codigo: number | null;
  motivo: string;
}

export type ManejadorNotificacion = (metodo: string, params: unknown) => void;
export type ManejadorPeticion = (metodo: string, params: unknown) => Promise<unknown>;

export class ErrorTiempo extends Error {
  readonly metodo: string;
  readonly timeoutMs: number;
  constructor(metodo: string, timeoutMs: number) {
    super(`La petición «${metodo}» superó el tiempo de espera de ${timeoutMs} ms`);
    this.name = 'ErrorTiempo';
    this.metodo = metodo;
    this.timeoutMs = timeoutMs;
  }
}

/** El servidor respondió a una petición con un error JSON-RPC. */
export class ErrorJsonRpc extends Error {
  readonly codigo: number;
  readonly datos: unknown;
  constructor(codigo: number, mensaje: string, datos?: unknown) {
    super(mensaje);
    this.name = 'ErrorJsonRpc';
    this.codigo = codigo;
    this.datos = datos;
  }
}

/** El proceso terminó (o no pudo lanzarse) antes de que llegara la respuesta. */
export class ErrorProceso extends Error {
  readonly codigo: number | null;
  constructor(motivo: string, codigo: number | null) {
    super(motivo);
    this.name = 'ErrorProceso';
    this.codigo = codigo;
  }
}

interface Pendiente {
  metodo: string;
  resolver: (valor: unknown) => void;
  rechazar: (error: Error) => void;
  temporizador: NodeJS.Timeout | undefined;
}

function esObjeto(valor: unknown): valor is Record<string, unknown> {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor);
}

function esId(valor: unknown): valor is IdJsonRpc {
  return typeof valor === 'string' || typeof valor === 'number';
}

export class ClienteJsonRpc {
  readonly terminado: Promise<ResultadoTerminado>;

  private readonly hijo: ChildProcess;
  private readonly graciaCierreMs: number;
  private readonly pendientes = new Map<IdJsonRpc, Pendiente>();
  private siguienteId = 1;
  private notificacion: ManejadorNotificacion | undefined;
  private peticion: ManejadorPeticion | undefined;
  private fin: ResultadoTerminado | undefined;
  private cierre: Promise<void> | undefined;
  private errorSalida: Buffer = Buffer.alloc(0);
  private resolverTerminado!: (r: ResultadoTerminado) => void;

  private constructor(hijo: ChildProcess, graciaCierreMs: number) {
    this.hijo = hijo;
    this.graciaCierreMs = graciaCierreMs;
    this.terminado = new Promise((resolver) => {
      this.resolverTerminado = resolver;
    });

    hijo.stdin?.on('error', () => {
      // El cierre del proceso (EPIPE incluido) se informa por 'close'.
    });
    hijo.stderr?.on('data', (trozo: Buffer) => {
      const total = Buffer.concat([this.errorSalida, trozo]);
      this.errorSalida = total.length > MAX_SALIDA_ERROR ? total.subarray(total.length - MAX_SALIDA_ERROR) : total;
    });
    if (hijo.stdout) {
      createInterface({ input: hijo.stdout, crlfDelay: Infinity }).on('line', (linea) => this.alLinea(linea));
    }
    hijo.on('error', (error: Error) => {
      this.finalizar(null, `no se pudo lanzar el proceso: ${error.message}`);
    });
    hijo.on('close', (codigo: number | null, senal: NodeJS.Signals | null) => {
      const como = codigo !== null ? `con código de salida ${codigo}` : `por la señal ${senal ?? 'desconocida'}`;
      this.finalizar(codigo, `el proceso terminó ${como}`);
    });
  }

  /** Lanza el proceso sin shell y habla JSON-RPC 2.0 (un mensaje JSON por línea) por stdin/stdout. */
  static lanzar(orden: string, args: string[], opciones: OpcionesLanzar): ClienteJsonRpc {
    const hijo = spawn(orden, args, {
      cwd: opciones.cwd,
      env: opciones.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });
    return new ClienteJsonRpc(hijo, opciones.graciaCierreMs ?? GRACIA_CIERRE_MS);
  }

  /** Últimos 64 KiB de la salida de error del proceso. */
  get salidaError(): string {
    return this.errorSalida.toString('utf8');
  }

  solicitar<T>(metodo: string, params: unknown, opciones: OpcionesSolicitud = {}): Promise<T> {
    if (this.fin) {
      return Promise.reject(new ErrorProceso(this.motivoCompleto(this.fin.motivo), this.fin.codigo));
    }
    const id = this.siguienteId++;
    return new Promise<T>((resolver, rechazar) => {
      let temporizador: NodeJS.Timeout | undefined;
      const { timeoutMs } = opciones;
      if (timeoutMs !== undefined) {
        temporizador = setTimeout(() => {
          this.pendientes.delete(id);
          rechazar(new ErrorTiempo(metodo, timeoutMs));
        }, timeoutMs);
      }
      this.pendientes.set(id, { metodo, resolver: resolver as (v: unknown) => void, rechazar, temporizador });
      this.escribir({ jsonrpc: '2.0', id, method: metodo, params });
    });
  }

  notificar(metodo: string, params: unknown): void {
    this.escribir({ jsonrpc: '2.0', method: metodo, params });
  }

  alNotificar(fn: ManejadorNotificacion): void {
    this.notificacion = fn;
  }

  alSolicitar(fn: ManejadorPeticion): void {
    this.peticion = fn;
  }

  /** Cierra stdin y espera la salida; si el proceso no termina a tiempo, lo termina a la fuerza. */
  cerrar(): Promise<void> {
    this.cierre ??= this.ejecutarCierre();
    return this.cierre;
  }

  private async ejecutarCierre(): Promise<void> {
    if (!this.fin) {
      this.hijo.stdin?.end();
      const salioSolo = await Promise.race([this.terminado.then(() => true), pausa(this.graciaCierreMs).then(() => false)]);
      if (!salioSolo) {
        this.hijo.kill();
        const termino = await Promise.race([this.terminado.then(() => true), pausa(this.graciaCierreMs).then(() => false)]);
        if (!termino) this.hijo.kill('SIGKILL');
      }
    }
    await this.terminado;
  }

  private motivoCompleto(motivo: string): string {
    const cola = this.salidaError.trim();
    return cola ? `${motivo}. Salida de error: ${cola}` : motivo;
  }

  private finalizar(codigo: number | null, motivo: string): void {
    if (this.fin) return;
    this.fin = { codigo, motivo };
    const completo = this.motivoCompleto(motivo);
    for (const pendiente of this.pendientes.values()) {
      if (pendiente.temporizador) clearTimeout(pendiente.temporizador);
      pendiente.rechazar(new ErrorProceso(completo, codigo));
    }
    this.pendientes.clear();
    this.resolverTerminado(this.fin);
  }

  private escribir(mensaje: Record<string, unknown>): void {
    const stdin = this.hijo.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) return;
    stdin.write(`${JSON.stringify(mensaje)}\n`);
  }

  private alLinea(linea: string): void {
    let mensaje: unknown;
    try {
      mensaje = JSON.parse(linea);
    } catch {
      return;
    }
    if (!esObjeto(mensaje)) return;

    const { id, method } = mensaje;
    if (typeof method === 'string') {
      if (esId(id)) void this.atenderPeticion(id, method, mensaje['params']);
      else this.avisar(method, mensaje['params']);
      return;
    }
    if (esId(id)) this.resolverRespuesta(id, mensaje);
  }

  private avisar(metodo: string, params: unknown): void {
    try {
      this.notificacion?.(metodo, params);
    } catch {
      // Un fallo del manejador no debe tumbar la lectura del flujo.
    }
  }

  private resolverRespuesta(id: IdJsonRpc, mensaje: Record<string, unknown>): void {
    const pendiente = this.pendientes.get(id);
    if (!pendiente) return;
    this.pendientes.delete(id);
    if (pendiente.temporizador) clearTimeout(pendiente.temporizador);
    const error = mensaje['error'];
    if (esObjeto(error)) {
      const codigo = typeof error['code'] === 'number' ? error['code'] : -32603;
      const texto = typeof error['message'] === 'string' ? error['message'] : 'Error JSON-RPC sin mensaje';
      pendiente.rechazar(new ErrorJsonRpc(codigo, texto, error['data']));
    } else {
      pendiente.resolver(mensaje['result']);
    }
  }

  private async atenderPeticion(id: IdJsonRpc, metodo: string, params: unknown): Promise<void> {
    if (!this.peticion) {
      this.escribir({ jsonrpc: '2.0', id, error: { code: -32601, message: `Método no soportado por el cliente: ${metodo}` } });
      return;
    }
    try {
      const result = await this.peticion(metodo, params);
      this.escribir({ jsonrpc: '2.0', id, result: result ?? null });
    } catch (error) {
      const mensaje = error instanceof Error ? error.message : String(error);
      this.escribir({ jsonrpc: '2.0', id, error: { code: -32603, message: `Error del cliente al atender «${metodo}»: ${mensaje}` } });
    }
  }
}

function pausa(ms: number): Promise<void> {
  return new Promise((resolver) => {
    setTimeout(resolver, ms).unref();
  });
}
