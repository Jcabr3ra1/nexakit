// Servidor JSON-RPC falso por stdio (NDJSON) para probar a los conectores de la fábrica.
// Uso: node test-support/fabrica/servidor-falso.mjs <guion.json>
// El formato del guion está documentado en .superpowers/sdd/2026-11-14-fabrica-nucleo/tarea-3-report.md.
// Añadidos para ACP (tarea 5):
// - `registroArgs`: ruta donde se guardan, como JSON, los argumentos que siguen al guion.
// - `registroCwd`: ruta donde se guarda la carpeta de trabajo con que se lanzó el servidor.
// - `diferir: true` en un paso: no responde todavía; guarda el id de la petición para ese método.
// - `responder: [{ metodo, resultado?, error? }]` en los efectos (pasos y `alResponder`): contesta la petición
//   diferida de ese método. Va después de las notificaciones y peticiones del mismo efecto.
import { appendFileSync, existsSync, lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const rutaGuion = process.argv[2];
if (!rutaGuion) {
  process.stderr.write('Uso: servidor-falso.mjs <guion.json>\n');
  process.exit(2);
}
const guion = JSON.parse(readFileSync(rutaGuion, 'utf8'));
// `<servidor> <guion> --version` imita `codex --version` con el texto de `guion.version`.
if (process.argv[3] === '--version') {
  process.stdout.write(`${guion.version ?? 'servidor-falso 0.0.0'}\n`);
  process.exit(0);
}
if (guion.registroArgs) writeFileSync(guion.registroArgs, JSON.stringify(process.argv.slice(3)));
if (guion.registroCwd) writeFileSync(guion.registroCwd, process.cwd());
// `registroEnv`: guarda CODEX_HOME con que se lanzó el servidor y qué contiene (para probar el modo escritura de Codex).
if (guion.registroEnv) {
  const home = process.env.CODEX_HOME ?? null;
  const archivos = home !== null && existsSync(home) ? readdirSync(home).sort() : null;
  const modo = home !== null && existsSync(home) ? (lstatSync(home).mode & 0o777) : null;
  const enlaceAuth = home !== null && archivos?.includes('auth.json') ? lstatSync(`${home}/auth.json`).isSymbolicLink() : null;
  const temporales = { TMPDIR: process.env.TMPDIR ?? null, TMP: process.env.TMP ?? null, TEMP: process.env.TEMP ?? null };
  const config = home !== null && archivos?.includes('config.toml') ? readFileSync(`${home}/config.toml`, 'utf8') : null;
  writeFileSync(guion.registroEnv, JSON.stringify({ home, archivos, modo, enlaceAuth, temporales, config }));
}
const metodos = guion.metodos ?? {};
const contadores = new Map();
const diferidas = new Map();
let siguientePeticion = 1;

function escribir(texto) {
  return new Promise((resolver) => process.stdout.write(texto, resolver));
}
const enviar = (mensaje) => escribir(`${JSON.stringify({ jsonrpc: '2.0', ...mensaje })}\n`);
const pausa = (ms) => new Promise((resolver) => setTimeout(resolver, ms));

function escribirStderr(texto) {
  return new Promise((resolver) => process.stderr.write(texto, resolver));
}

// Un método puede declarar una lista de pasos: se consumen en orden y el último se repite.
function elegirPaso(metodo) {
  const definicion = metodos[metodo];
  if (definicion === undefined) return undefined;
  if (!Array.isArray(definicion)) return definicion;
  const n = contadores.get(metodo) ?? 0;
  contadores.set(metodo, n + 1);
  return definicion[Math.min(n, definicion.length - 1)];
}

// Ejecuta lo que un paso describe, salvo la respuesta (la envía quien llama).
async function ejecutarEfectos(paso) {
  for (const linea of paso.ruido ?? []) await escribir(`${linea}\n`);
  if (paso.stderrRepetir) {
    await escribirStderr(String(paso.stderrRepetir.texto).repeat(paso.stderrRepetir.veces));
  }
  if (paso.stderr) await escribirStderr(paso.stderr);
  for (const n of paso.notificaciones ?? []) {
    if (n.retrasoMs) await pausa(n.retrasoMs);
    await enviar({ method: n.metodo, params: n.params });
  }
  for (const p of paso.peticiones ?? []) {
    if (p.retrasoMs) await pausa(p.retrasoMs);
    await enviar({ id: p.id ?? `srv-${siguientePeticion++}`, method: p.metodo, params: p.params });
  }
  for (const r of paso.responder ?? []) {
    if (r.retrasoMs) await pausa(r.retrasoMs);
    const id = diferidas.get(r.metodo);
    if (id === undefined) continue;
    diferidas.delete(r.metodo);
    if (r.error) await enviar({ id, error: r.error });
    else await enviar({ id, result: r.resultado ?? null });
  }
  if (typeof paso.salir === 'number') process.exit(paso.salir);
}

async function atender(mensaje) {
  if (typeof mensaje.method === 'string') {
    const tienePeticion = mensaje.id !== undefined;
    const paso = elegirPaso(mensaje.method);
    if (paso === undefined) {
      if (tienePeticion) {
        await enviar({ id: mensaje.id, error: { code: -32601, message: `Método no encontrado: ${mensaje.method}` } });
      }
      return;
    }
    if (paso.retrasoMs) await pausa(paso.retrasoMs);
    // El ruido y la salida de error van antes de la respuesta; las notificaciones y peticiones, después.
    for (const linea of paso.ruido ?? []) await escribir(`${linea}\n`);
    if (tienePeticion && paso.diferir) diferidas.set(mensaje.method, mensaje.id);
    else if (tienePeticion && !paso.sinRespuesta) {
      if (paso.error) await enviar({ id: mensaje.id, error: paso.error });
      else await enviar({ id: mensaje.id, result: paso.resultado ?? null });
    }
    await ejecutarEfectos({ ...paso, ruido: [] });
    return;
  }
  if (mensaje.id !== undefined && guion.informarRespuestas) {
    const params = { id: mensaje.id };
    if ('error' in mensaje) params.error = mensaje.error;
    else params.result = mensaje.result;
    await enviar({ method: 'servidor/respuestaRecibida', params });
  }
  // `alResponder[id]`: efectos (notificaciones, peticiones...) cuando el cliente contesta esa petición.
  const efectos = mensaje.id !== undefined ? guion.alResponder?.[String(mensaje.id)] : undefined;
  if (efectos) {
    if (efectos.retrasoMs) await pausa(efectos.retrasoMs);
    await ejecutarEfectos(efectos);
  }
}

// Los mensajes se atienden en orden de llegada, para que los retrasos sean deterministas.
let cola = Promise.resolve();
const lector = createInterface({ input: process.stdin, crlfDelay: Infinity });
lector.on('line', (linea) => {
  let mensaje;
  try {
    mensaje = JSON.parse(linea);
  } catch {
    return;
  }
  if (mensaje === null || typeof mensaje !== 'object') return;
  // `registro`: cada mensaje recibido se guarda como una línea JSON para que la prueba lo afirme.
  if (guion.registro) appendFileSync(guion.registro, `${JSON.stringify(mensaje)}\n`);
  cola = cola.then(() => atender(mensaje)).catch((error) => {
    process.stderr.write(`servidor-falso: ${error?.stack ?? error}\n`);
  });
});
// Al cerrarse stdin (el cliente terminó) el servidor sale solo, salvo que el guion lo impida.
lector.on('close', () => {
  if (guion.ignorarCierre) return;
  cola.then(() => process.exit(0));
});
if (guion.ignorarCierre) setInterval(() => {}, 1 << 30);

if (guion.alIniciar) cola = cola.then(() => ejecutarEfectos(guion.alIniciar));
