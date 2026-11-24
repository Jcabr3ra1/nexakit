import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ClienteJsonRpc,
  ErrorTiempo,
  ErrorJsonRpc,
  ErrorProceso,
} from '../dist/fabrica/jsonrpc.js';

const SERVIDOR = fileURLToPath(new URL('../test-support/fabrica/servidor-falso.mjs', import.meta.url));

function lanzarConGuion(guion, opciones = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'nexakit-jsonrpc-'));
  const ruta = join(dir, 'guion.json');
  writeFileSync(ruta, JSON.stringify(guion));
  const cliente = ClienteJsonRpc.lanzar(process.execPath, [SERVIDOR, ruta], { cwd: dir, ...opciones });
  cliente.terminado.then(() => rmSync(dir, { recursive: true, force: true }));
  return cliente;
}

function esperarNotificacion(cliente, metodo) {
  return new Promise((resolver) => {
    const previas = [];
    cliente.alNotificar((m, p) => {
      if (m === metodo) resolver(p);
      else previas.push(m);
    });
  });
}

test('una petición recibe su respuesta por id aunque lleguen desordenadas', async () => {
  const cliente = lanzarConGuion({
    metodos: {
      lento: { retrasoMs: 150, resultado: 'lento' },
      rapido: { resultado: { ok: true } },
    },
  });
  try {
    const [a, b] = await Promise.all([
      cliente.solicitar('lento', {}),
      cliente.solicitar('rapido', {}),
    ]);
    assert.equal(a, 'lento');
    assert.deepEqual(b, { ok: true });
  } finally {
    await cliente.cerrar();
  }
});

test('una respuesta de error rechaza con ErrorJsonRpc', async () => {
  const cliente = lanzarConGuion({
    metodos: { falla: { error: { code: -32000, message: 'no pude', data: { x: 1 } } } },
  });
  try {
    await assert.rejects(cliente.solicitar('falla', {}), (e) => {
      assert.ok(e instanceof ErrorJsonRpc);
      assert.equal(e.codigo, -32000);
      assert.equal(e.message, 'no pude');
      assert.deepEqual(e.datos, { x: 1 });
      return true;
    });
    await assert.rejects(cliente.solicitar('inexistente', {}), (e) => {
      assert.ok(e instanceof ErrorJsonRpc);
      assert.equal(e.codigo, -32601);
      return true;
    });
  } finally {
    await cliente.cerrar();
  }
});

test('las notificaciones del servidor llegan a alNotificar, tras la respuesta', async () => {
  const cliente = lanzarConGuion({
    metodos: {
      'turn/start': {
        resultado: { turno: 1 },
        notificaciones: [
          { metodo: 'turn/progress', params: { n: 1 } },
          { metodo: 'turn/completed', params: { n: 2 } },
        ],
      },
    },
  });
  const vistas = [];
  const fin = new Promise((resolver) => {
    cliente.alNotificar((metodo, params) => {
      vistas.push([metodo, params]);
      if (metodo === 'turn/completed') resolver();
    });
  });
  try {
    assert.deepEqual(await cliente.solicitar('turn/start', {}), { turno: 1 });
    await fin;
    assert.deepEqual(vistas, [
      ['turn/progress', { n: 1 }],
      ['turn/completed', { n: 2 }],
    ]);
  } finally {
    await cliente.cerrar();
  }
});

test('notificar envía un mensaje sin id que el servidor puede reconocer', async () => {
  const cliente = lanzarConGuion({
    metodos: { initialized: { notificaciones: [{ metodo: 'visto', params: { de: 'initialized' } }] } },
  });
  try {
    const espera = esperarNotificacion(cliente, 'visto');
    cliente.notificar('initialized', {});
    assert.deepEqual(await espera, { de: 'initialized' });
  } finally {
    await cliente.cerrar();
  }
});

test('una petición del servidor se contesta con el valor de alSolicitar', async () => {
  const cliente = lanzarConGuion({
    informarRespuestas: true,
    metodos: {
      'turn/start': {
        resultado: {},
        peticiones: [{ metodo: 'item/fileChange/requestApproval', params: { archivo: 'a.ts' }, id: 'srv-7' }],
      },
    },
  });
  const recibidas = [];
  cliente.alSolicitar(async (metodo, params) => {
    recibidas.push([metodo, params]);
    return { decision: 'decline' };
  });
  try {
    const espera = esperarNotificacion(cliente, 'servidor/respuestaRecibida');
    await cliente.solicitar('turn/start', {});
    assert.deepEqual(await espera, { id: 'srv-7', result: { decision: 'decline' } });
    assert.deepEqual(recibidas, [['item/fileChange/requestApproval', { archivo: 'a.ts' }]]);
  } finally {
    await cliente.cerrar();
  }
});

test('sin manejador, una petición del servidor recibe error de método no encontrado', async () => {
  const cliente = lanzarConGuion({
    informarRespuestas: true,
    metodos: { go: { resultado: 1, peticiones: [{ metodo: 'cosa', params: {} }] } },
  });
  try {
    const espera = esperarNotificacion(cliente, 'servidor/respuestaRecibida');
    await cliente.solicitar('go', {});
    const respuesta = await espera;
    assert.equal(respuesta.error.code, -32601);
  } finally {
    await cliente.cerrar();
  }
});

test('si el manejador de peticiones falla, el servidor recibe un error interno', async () => {
  const cliente = lanzarConGuion({
    informarRespuestas: true,
    metodos: { go: { resultado: 1, peticiones: [{ metodo: 'cosa', params: {} }] } },
  });
  cliente.alSolicitar(async () => {
    throw new Error('explotó');
  });
  try {
    const espera = esperarNotificacion(cliente, 'servidor/respuestaRecibida');
    await cliente.solicitar('go', {});
    const respuesta = await espera;
    assert.equal(respuesta.error.code, -32603);
    assert.match(respuesta.error.message, /explotó/);
  } finally {
    await cliente.cerrar();
  }
});

test('timeoutMs agotado rechaza con ErrorTiempo y una respuesta tardía se ignora', async () => {
  const cliente = lanzarConGuion({
    metodos: {
      tarda: { retrasoMs: 300, resultado: 'tarde' },
      otra: { resultado: 'ok' },
    },
  });
  try {
    await assert.rejects(cliente.solicitar('tarda', {}, { timeoutMs: 50 }), (e) => {
      assert.ok(e instanceof ErrorTiempo);
      assert.match(e.message, /tarda/);
      assert.match(e.message, /50/);
      return true;
    });
    await new Promise((r) => setTimeout(r, 350));
    assert.equal(await cliente.solicitar('otra', {}), 'ok');
  } finally {
    await cliente.cerrar();
  }
});

test('si el proceso muere, se rechazan las pendientes con el código de salida', async () => {
  const cliente = lanzarConGuion({
    metodos: {
      cuelga: { sinRespuesta: true, stderr: 'fallo interno del servidor\n', salir: 3 },
    },
  });
  const pendiente = cliente.solicitar('cuelga', {});
  await assert.rejects(pendiente, (e) => {
    assert.ok(e instanceof ErrorProceso);
    assert.match(e.message, /3/);
    assert.match(e.message, /fallo interno del servidor/);
    return true;
  });
  const fin = await cliente.terminado;
  assert.equal(fin.codigo, 3);
  assert.match(fin.motivo, /3/);
  await assert.rejects(cliente.solicitar('otra', {}), ErrorProceso);
});

test('una línea que no es JSON válido se ignora sin romper', async () => {
  const cliente = lanzarConGuion({
    alIniciar: { ruido: ['esto no es json', '{roto', '42', '"texto"', 'null', '[1,2]', ''] },
    metodos: { ping: { ruido: ['más ruido'], resultado: 'pong' } },
  });
  try {
    assert.equal(await cliente.solicitar('ping', {}), 'pong');
  } finally {
    await cliente.cerrar();
  }
});

test('la salida de error se acota a los últimos 64 KiB', async () => {
  const cliente = lanzarConGuion({
    metodos: { cae: { sinRespuesta: true, stderrRepetir: { texto: 'x', veces: 200 * 1024 }, stderr: 'FIN', salir: 1 } },
  });
  const pendiente = cliente.solicitar('cae', {});
  await assert.rejects(pendiente, (e) => {
    assert.ok(e instanceof ErrorProceso);
    assert.match(e.message, /FIN$/);
    assert.ok(e.message.length < 70 * 1024, `mensaje demasiado largo: ${e.message.length}`);
    return true;
  });
  await cliente.terminado;
  assert.ok(Buffer.byteLength(cliente.salidaError) <= 64 * 1024);
});

test('cerrar termina un servidor que se desconecta al cerrar stdin y es idempotente', async () => {
  const cliente = lanzarConGuion({ metodos: {} });
  await cliente.cerrar();
  await cliente.cerrar();
  const fin = await cliente.terminado;
  assert.equal(fin.codigo, 0);
});

test('cerrar mata a un servidor que ignora el cierre de stdin', async () => {
  const cliente = lanzarConGuion({ ignorarCierre: true, metodos: { espera: { sinRespuesta: true } } }, { graciaCierreMs: 100 });
  const pendiente = cliente.solicitar('espera', {});
  const rechazo = assert.rejects(pendiente, ErrorProceso);
  await cliente.cerrar();
  await rechazo;
  const fin = await cliente.terminado;
  assert.notEqual(fin.codigo, 0);
});

test('una orden inexistente no lanza: terminado informa y solicitar rechaza', async () => {
  const cliente = ClienteJsonRpc.lanzar('nexakit-orden-que-no-existe', [], { cwd: tmpdir() });
  const fin = await cliente.terminado;
  assert.equal(fin.codigo, null);
  assert.match(fin.motivo, /no se pudo lanzar/i);
  await assert.rejects(cliente.solicitar('x', {}), ErrorProceso);
  await cliente.cerrar();
});

/** `true` si el proceso `pid` sigue vivo. */
function vivo(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function hasta(condicion, motivo) {
  for (let i = 0; i < 200; i++) {
    if (condicion()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`no ocurrió: ${motivo}`);
}

test('el proceso va en su propio grupo y cerrar termina también a sus descendientes', { skip: process.platform === 'win32', timeout: 20_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexakit-jsonrpc-grupo-'));
  const archivoPid = join(dir, 'nieto.pid');
  // El hijo lanza un nieto que hereda sus tuberías y no muere solo; el hijo ignora el cierre de stdin.
  const hijo = [
    "const { spawn } = require('node:child_process');",
    "const fs = require('node:fs');",
    "const nieto = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });",
    `fs.writeFileSync(${JSON.stringify(archivoPid)}, String(nieto.pid));`,
    'process.stdin.resume();',
    "process.stdin.on('end', () => {});",
    'setInterval(() => {}, 1000);',
  ].join('\n');
  const cliente = ClienteJsonRpc.lanzar(process.execPath, ['-e', hijo], { cwd: dir, graciaCierreMs: 100 });
  try {
    await hasta(() => {
      try {
        return Number(readFileSync(archivoPid, 'utf8')) > 0;
      } catch {
        return false;
      }
    }, 'el nieto arranca');
    const nieto = Number(readFileSync(archivoPid, 'utf8'));
    assert.equal(vivo(nieto), true);
    await cliente.cerrar();
    await hasta(() => !vivo(nieto), 'el nieto termina con el grupo');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('si el proceso sale solo, el nieto que dejó vivo también se termina', { skip: process.platform === 'win32', timeout: 20_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexakit-jsonrpc-grupo-'));
  const archivoPid = join(dir, 'nieto.pid');
  const hijo = [
    "const { spawn } = require('node:child_process');",
    "const fs = require('node:fs');",
    "const nieto = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    `fs.writeFileSync(${JSON.stringify(archivoPid)}, String(nieto.pid));`,
    'process.exit(0);',
  ].join('\n');
  const cliente = ClienteJsonRpc.lanzar(process.execPath, ['-e', hijo], { cwd: dir });
  try {
    await cliente.terminado;
    const nieto = Number(readFileSync(archivoPid, 'utf8'));
    await hasta(() => !vivo(nieto), 'el nieto termina al salir el hijo');
  } finally {
    await cliente.cerrar();
    rmSync(dir, { recursive: true, force: true });
  }
});
