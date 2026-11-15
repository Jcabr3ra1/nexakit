import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crearConectorAntigravity, personalizacionesPeligrosas } from '../dist/fabrica/conectores/antigravity.js';
import { hallazgosJsonSchema } from '../dist/fabrica/esquemas.js';

const SERVIDOR = fileURLToPath(new URL('../test-support/fabrica/servidor-falso.mjs', import.meta.url));
const GUIONES = fileURLToPath(new URL('../test-support/fabrica/', import.meta.url));
const ESQUEMA = JSON.stringify(hallazgosJsonSchema());
const INSTRUCCION = 'Responde solo con JSON que cumpla este esquema';

function guionBase(nombre) {
  return JSON.parse(readFileSync(join(GUIONES, `acp-${nombre}.json`), 'utf8'));
}

/** Prepara un guion con registro de mensajes y argumentos, y una carpeta que hace de raíz del repo. */
function preparar(nombre, cambios = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'nexakit-agy-prueba-'));
  const raiz = join(dir, 'repo');
  mkdirSync(join(raiz, '.git'), { recursive: true });
  const guion = { ...guionBase(nombre), ...cambios };
  guion.registro = join(dir, 'registro.ndjson');
  guion.registroArgs = join(dir, 'args.json');
  const rutaGuion = join(dir, 'guion.json');
  writeFileSync(rutaGuion, JSON.stringify(guion));
  const conector = crearConectorAntigravity({ orden: process.execPath, argsPrefijo: [SERVIDOR, rutaGuion] });
  return {
    dir,
    raiz,
    conector,
    mensajes: () => (existsSync(guion.registro) ? readFileSync(guion.registro, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
    args: () => JSON.parse(readFileSync(guion.registroArgs, 'utf8')),
    async limpiar() {
      await (await conector).cerrar();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function encargo(raiz, cambios = {}) {
  return {
    estacion: 'pruebas',
    modelo: 'gemini-4-argon-high',
    esfuerzo: null,
    raiz,
    base: 'abc123',
    instrucciones: 'Revisa el diff.',
    ordenesPermitidas: ['npm test'],
    ...cambios,
  };
}

/** Respuesta que el conector envió a la petición del servidor con ese id. */
function respuesta(mensajes, id) {
  const encontrada = mensajes.find((m) => m.id === id && !('method' in m));
  assert.ok(encontrada, `sin respuesta a ${id}`);
  return encontrada;
}

async function esperarMensaje(obtener, metodo) {
  for (let i = 0; i < 250; i++) {
    if (obtener().some((m) => m.method === metodo)) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`no llegó ${metodo}`);
}

test('catalogo() sale de session/new y deduce el esfuerzo del sufijo del id', async () => {
  const p = preparar('catalogo');
  try {
    const conector = await p.conector;
    assert.equal(conector.ia, 'antigravity');
    assert.deepEqual(await conector.catalogo(), [
      { modelo: 'gemini-4-argon-medium', esfuerzos: ['medium'] },
      { modelo: 'gemini-4-argon-high', esfuerzos: ['high'] },
      { modelo: 'gemini-4-hydrogen-xhigh', esfuerzos: ['xhigh'] },
      { modelo: 'gemini-3.8-flash-low', esfuerzos: ['low'] },
      { modelo: 'gemini-pro-orchestrator-g1-pro', esfuerzos: [] },
    ]);
    await conector.catalogo();
    const mensajes = p.mensajes();
    assert.equal(mensajes.filter((m) => m.method === 'initialize').length, 1, 'initialize una sola vez');
    const sesiones = mensajes.filter((m) => m.method === 'session/new');
    assert.equal(sesiones.length, 2);
    assert.deepEqual(sesiones[0].params.mcpServers, []);
    assert.equal(mensajes.some((m) => m.method === 'session/prompt'), false, 'el catálogo no llama al modelo');
    await esperarMensaje(p.mensajes, 'session/close');
  } finally {
    await p.limpiar();
  }
});

test('initialize no declara escritura de archivos ni terminal, y el proceso se lanza aislado', async () => {
  const p = preparar('catalogo');
  try {
    const conector = await p.conector;
    await conector.catalogo();
    const inicio = p.mensajes().find((m) => m.method === 'initialize').params;
    assert.equal(inicio.protocolVersion, 1);
    assert.deepEqual(inicio.clientCapabilities, { fs: { readTextFile: false, writeTextFile: false }, terminal: false });

    const args = p.args();
    assert.deepEqual(args.slice(0, 5), ['acp', '--sandbox', '--process-per-session', '--disable-telemetry', '--gemini-dir']);
    assert.equal(args.length, 6);
    const carpeta = args[5];
    assert.ok(isAbsolute(carpeta), 'la carpeta de datos aislada es absoluta');
    assert.ok(!carpeta.startsWith(process.env.HOME ?? '\0'), 'no está en el HOME real');
    assert.equal(statSync(carpeta).mode & 0o777, 0o700);
    await conector.cerrar();
    assert.equal(existsSync(carpeta), false, 'la carpeta aislada se borra al cerrar');
  } finally {
    await p.limpiar();
  }
});

test('ejecutar fija el modelo, pide hallazgos con el esquema y rechaza todo permiso', async () => {
  const p = preparar('revision');
  try {
    const conector = await p.conector;
    const resultado = await conector.ejecutar(encargo(p.raiz), AbortSignal.timeout(10_000));
    assert.equal(resultado.estado, 'ok', resultado.motivo);
    assert.equal(resultado.informe.hallazgos.length, 1);
    assert.equal(resultado.informe.resumen, 'Un hallazgo.');
    assert.equal(resultado.modeloInformado, 'gemini-4-argon-high');
    assert.equal(resultado.tokens.total, 1500);

    const mensajes = p.mensajes();
    const sesion = mensajes.find((m) => m.method === 'session/new').params;
    assert.deepEqual(sesion, { cwd: p.raiz, mcpServers: [] });
    assert.deepEqual(mensajes.find((m) => m.method === 'session/set_model').params, { sessionId: 'ses-1', modelId: 'gemini-4-argon-high' });
    const indice = (metodo) => mensajes.findIndex((m) => m.method === metodo);
    assert.ok(indice('session/set_model') < indice('session/prompt'), 'el modelo se fija antes del turno');
    const turnos = mensajes.filter((m) => m.method === 'session/prompt');
    assert.equal(turnos.length, 1);
    const [bloque, ...resto] = turnos[0].params.prompt;
    assert.equal(resto.length, 0);
    assert.equal(bloque.type, 'text');
    assert.ok(bloque.text.startsWith('Revisa el diff.'));
    assert.ok(bloque.text.endsWith(`${INSTRUCCION}:\n${ESQUEMA}`), 'el esquema va al final de las instrucciones');

    // Permisos: siempre la opción de rechazo; si no la hay o la forma es inesperada, cancelled.
    assert.deepEqual(respuesta(mensajes, 'srv-1').result, { outcome: { outcome: 'selected', optionId: 'op-reject_once' } });
    assert.deepEqual(respuesta(mensajes, 'srv-2').result, { outcome: { outcome: 'selected', optionId: 'op-reject_always' } });
    assert.deepEqual(respuesta(mensajes, 'srv-3').result, { outcome: { outcome: 'cancelled' } });
    assert.deepEqual(respuesta(mensajes, 'srv-4').result, { outcome: { outcome: 'cancelled' } });
    assert.deepEqual(respuesta(mensajes, 'srv-5').result, { outcome: { outcome: 'selected', optionId: 'op-reject_once' } }, 'sesión ajena');
    // Camino por defecto: cualquier otra petición se contesta con error, nunca con un resultado.
    for (const id of ['srv-6', 'srv-7']) {
      const r = respuesta(mensajes, id);
      assert.equal(r.result, undefined, id);
      assert.equal(r.error.code, -32601, id);
    }

    assert.deepEqual(resultado.denegaciones.map((d) => d.tipo), [
      'session/request_permission',
      'session/request_permission',
      'session/request_permission',
      'session/request_permission',
      'fs/write_text_file',
      'terminal/create',
    ]);
    assert.match(resultado.denegaciones[0].detalle, /Editar src\/a\.js/);
    await esperarMensaje(p.mensajes, 'session/close');
    assert.deepEqual(p.mensajes().find((m) => m.method === 'session/close').params, { sessionId: 'ses-1' });
  } finally {
    await p.limpiar();
  }
});

test('las imágenes del encargo van como bloques image del prompt', async () => {
  const p = preparar('revision');
  try {
    const png = join(p.dir, 'captura.png');
    writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const resultado = await (await p.conector).ejecutar(encargo(p.raiz, { imagenes: [png] }), AbortSignal.timeout(10_000));
    assert.equal(resultado.estado, 'ok', resultado.motivo);
    const prompt = p.mensajes().find((m) => m.method === 'session/prompt').params.prompt;
    assert.equal(prompt.length, 2);
    assert.deepEqual(prompt[1], { type: 'image', mimeType: 'image/png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64') });
  } finally {
    await p.limpiar();
  }
});

test('una respuesta fuera de esquema provoca un solo reintento con el mensaje de corrección', async () => {
  const p = preparar('reintento');
  try {
    const resultado = await (await p.conector).ejecutar(encargo(p.raiz), AbortSignal.timeout(10_000));
    assert.equal(resultado.estado, 'ok', resultado.motivo);
    assert.equal(resultado.informe.resumen, 'Un hallazgo.');
    const turnos = p.mensajes().filter((m) => m.method === 'session/prompt');
    assert.equal(turnos.length, 2);
    assert.equal(turnos[1].params.sessionId, 'ses-1');
    const correccion = turnos[1].params.prompt[0].text;
    assert.match(correccion, /no cumplía el esquema/);
    assert.ok(correccion.endsWith(`${INSTRUCCION}:\n${ESQUEMA}`));
  } finally {
    await p.limpiar();
  }
});

test('si el reintento tampoco cumple el esquema, da fallida sin un tercer turno', async () => {
  const p = preparar('invalido');
  try {
    const resultado = await (await p.conector).ejecutar(encargo(p.raiz), AbortSignal.timeout(10_000));
    assert.equal(resultado.estado, 'fallida');
    assert.equal(resultado.motivo, 'El revisor no devolvió hallazgos válidos');
    assert.equal(resultado.crudo, '{"hallazgos": "no es una lista"}');
    assert.equal(resultado.informe, undefined);
    assert.equal(resultado.tokens.total, 900);
    assert.equal(p.mensajes().filter((m) => m.method === 'session/prompt').length, 2);
  } finally {
    await p.limpiar();
  }
});

test('abortar la señal envía session/cancel y da cancelada', async () => {
  const p = preparar('cancelar');
  try {
    const conector = await p.conector;
    const control = new AbortController();
    const promesa = conector.ejecutar(encargo(p.raiz), control.signal);
    await esperarMensaje(p.mensajes, 'session/prompt');
    control.abort();
    const resultado = await promesa;
    assert.equal(resultado.estado, 'cancelada');
    assert.equal(resultado.motivo, 'La revisión se canceló');
    await esperarMensaje(p.mensajes, 'session/cancel');
    assert.deepEqual(p.mensajes().find((m) => m.method === 'session/cancel').params, { sessionId: 'ses-1' });
  } finally {
    await p.limpiar();
  }
});

test('una señal ya abortada no abre ninguna sesión', async () => {
  const p = preparar('cancelar');
  try {
    const control = new AbortController();
    control.abort();
    const resultado = await (await p.conector).ejecutar(encargo(p.raiz), control.signal);
    assert.equal(resultado.estado, 'cancelada');
    assert.equal(p.mensajes().some((m) => m.method === 'session/new'), false);
  } finally {
    await p.limpiar();
  }
});

test('si el agente sale del modo que pide permiso a mitad del turno, se cancela y da fallida', async () => {
  const p = preparar('cambio-modo');
  try {
    const resultado = await (await p.conector).ejecutar(encargo(p.raiz), AbortSignal.timeout(10_000));
    assert.equal(resultado.estado, 'fallida');
    assert.match(resultado.motivo, /modo «accept-edits»/);
    await esperarMensaje(p.mensajes, 'session/cancel');
  } finally {
    await p.limpiar();
  }
});

test('si la sesión no abre en el modo que pide permiso, no empieza el turno', async () => {
  const guion = guionBase('revision');
  const nueva = guion.metodos['session/new'];
  nueva.resultado.modes.currentModeId = 'auto';
  nueva.resultado.configOptions[0].currentValue = 'auto';
  const p = preparar('revision', { metodos: guion.metodos });
  try {
    const resultado = await (await p.conector).ejecutar(encargo(p.raiz), AbortSignal.timeout(10_000));
    assert.equal(resultado.estado, 'fallida');
    assert.match(resultado.motivo, /modo «auto»/);
    assert.equal(p.mensajes().some((m) => m.method === 'session/prompt'), false);
  } finally {
    await p.limpiar();
  }
});

test('si Antigravity no acepta el modelo, da fallida sin turno', async () => {
  const guion = guionBase('revision');
  guion.metodos['session/set_model'] = { error: { code: -32602, message: 'Unknown model ID: no-existe-high' } };
  const p = preparar('revision', { metodos: guion.metodos });
  try {
    const resultado = await (await p.conector).ejecutar(encargo(p.raiz, { modelo: 'no-existe-high' }), AbortSignal.timeout(10_000));
    assert.equal(resultado.estado, 'fallida');
    assert.match(resultado.motivo, /no-existe-high/);
    assert.equal(p.mensajes().some((m) => m.method === 'session/prompt'), false);
  } finally {
    await p.limpiar();
  }
});

test('con hooks, plugins o MCP del repo, no se abre la sesión', async () => {
  for (const [ruta, esCarpeta] of [['.agents/hooks.json', false], ['.agents/plugins', true], ['_agent/mcp_config.json', false], ['.agent/plugins.json', false]]) {
    const p = preparar('revision');
    try {
      const destino = join(p.raiz, ruta);
      if (esCarpeta) mkdirSync(destino, { recursive: true });
      else {
        mkdirSync(join(destino, '..'), { recursive: true });
        writeFileSync(destino, '{}');
      }
      const resultado = await (await p.conector).ejecutar(encargo(p.raiz), AbortSignal.timeout(10_000));
      assert.equal(resultado.estado, 'fallida', ruta);
      assert.match(resultado.motivo, /personalizaciones que ejecutan código/, ruta);
      assert.ok(resultado.motivo.includes(destino), ruta);
      assert.equal(p.mensajes().some((m) => m.method === 'session/new'), false, ruta);
    } finally {
      await p.limpiar();
    }
  }
});

test('personalizacionesPeligrosas sube hasta la raíz git y admite skills', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexakit-agy-personal-'));
  try {
    const repo = join(dir, 'repo');
    const sub = join(repo, 'paquete');
    mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(join(sub, '.agents', 'skills', 'x'), { recursive: true });
    mkdirSync(join(dir, '.agents'), { recursive: true });
    writeFileSync(join(dir, '.agents', 'hooks.json'), '{}');
    assert.deepEqual(personalizacionesPeligrosas(sub), [], 'las skills solas no cuentan; fuera del repo no se mira');
    mkdirSync(join(repo, '.agents'), { recursive: true });
    writeFileSync(join(repo, '.agents', 'hooks.json'), '{}');
    assert.deepEqual(personalizacionesPeligrosas(sub), [join(repo, '.agents', 'hooks.json')]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('si el proceso de Antigravity muere a mitad del turno, da fallida', async () => {
  const guion = guionBase('cancelar');
  guion.metodos['session/prompt'] = { diferir: true, salir: 3 };
  const p = preparar('cancelar', { metodos: guion.metodos });
  try {
    const resultado = await (await p.conector).ejecutar(encargo(p.raiz), AbortSignal.timeout(10_000));
    assert.equal(resultado.estado, 'fallida');
    assert.match(resultado.motivo, /Antigravity terminó/);
  } finally {
    await p.limpiar();
  }
});

test('si la orden no existe: fallida con «Antigravity no está instalado»', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexakit-agy-prueba-'));
  const conector = await crearConectorAntigravity({ orden: join(dir, 'no-existe', 'agy') });
  try {
    const resultado = await conector.ejecutar(encargo(dir), AbortSignal.timeout(10_000));
    assert.equal(resultado.estado, 'fallida');
    assert.equal(resultado.motivo, 'Antigravity no está instalado');
    await assert.rejects(conector.catalogo(), /Antigravity no está instalado/);
  } finally {
    await conector.cerrar();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sin agy en el PATH, el conector por defecto da «Antigravity no está instalado»', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexakit-agy-prueba-'));
  const antes = process.env.PATH;
  process.env.PATH = dir;
  try {
    const conector = await crearConectorAntigravity();
    const resultado = await conector.ejecutar(encargo(dir), AbortSignal.timeout(10_000));
    assert.equal(resultado.estado, 'fallida');
    assert.equal(resultado.motivo, 'Antigravity no está instalado');
    await conector.cerrar();
  } finally {
    process.env.PATH = antes;
    rmSync(dir, { recursive: true, force: true });
  }
});
