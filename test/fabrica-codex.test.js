import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv } from 'ajv';
import { crearConectorCodex, esShellDelSistema, ordenPermitida, versionTiposCodex } from '../dist/fabrica/conectores/codex.js';
import { hallazgosJsonSchema } from '../dist/fabrica/esquemas.js';
import { resolveCliInvocation } from '../src/cli-executable.js';

const SERVIDOR = fileURLToPath(new URL('../test-support/fabrica/servidor-falso.mjs', import.meta.url));
const GUIONES = fileURLToPath(new URL('../test-support/fabrica/', import.meta.url));
const VERSION_TIPOS = readFileSync(new URL('../src/fabrica/protocolos/codex/VERSION', import.meta.url), 'utf8').trim();

/** Prepara un guion con registro de mensajes y una carpeta de trabajo que hace de raíz del repo. */
function preparar(nombre, cambios = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'nexakit-codex-'));
  const guion = { ...JSON.parse(readFileSync(join(GUIONES, `codex-${nombre}.json`), 'utf8')), ...cambios };
  guion.registro = join(dir, 'registro.ndjson');
  const rutaGuion = join(dir, 'guion.json');
  writeFileSync(rutaGuion, JSON.stringify(guion));
  const conector = crearConectorCodex({ orden: process.execPath, argsPrefijo: [SERVIDOR, rutaGuion] });
  return {
    dir,
    rutaGuion,
    conector,
    mensajes: () => (existsSync(guion.registro) ? readFileSync(guion.registro, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
    async limpiar() {
      await (await conector).cerrar();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function encargo(raiz, cambios = {}) {
  return {
    estacion: 'pruebas',
    modelo: 'gpt-5.5',
    esfuerzo: 'high',
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

test('catalogo() traduce model/list a modelo y esfuerzos, siguiendo las páginas', async () => {
  const p = preparar('catalogo');
  try {
    const conector = await p.conector;
    assert.equal(conector.ia, 'codex');
    assert.deepEqual(await conector.catalogo(), [
      { modelo: 'gpt-5.5', esfuerzos: ['low', 'medium', 'high', 'xhigh'] },
      { modelo: 'gpt-5.5-mini', esfuerzos: ['medium'] },
    ]);
    await conector.catalogo();
    const metodos = p.mensajes().map((m) => m.method);
    assert.equal(metodos.filter((m) => m === 'initialize').length, 1, 'initialize una sola vez');
    assert.deepEqual(p.mensajes().filter((m) => m.method === 'model/list').slice(0, 2).map((m) => m.params.cursor ?? null), [null, 'pagina-2']);
  } finally {
    await p.limpiar();
  }
});

test('ejecutar abre un hilo de solo lectura y pide hallazgos con el esquema; deniega toda escritura', async () => {
  const p = preparar('revision');
  try {
    const conector = await p.conector;
    const resultado = await conector.ejecutar(encargo(p.dir), new AbortController().signal);
    assert.equal(resultado.estado, 'ok', resultado.motivo);
    assert.equal(resultado.informe.hallazgos.length, 1);
    assert.equal(resultado.informe.resumen, 'Un hallazgo.');
    assert.equal(resultado.modeloInformado, 'gpt-5.5');
    assert.deepEqual(resultado.tokens, { entrada: 1200, salida: 300, total: 1500 });

    const mensajes = p.mensajes();
    const hilo = mensajes.find((m) => m.method === 'thread/start').params;
    assert.equal(hilo.sandbox, 'read-only');
    assert.equal(hilo.cwd, p.dir);
    assert.equal(hilo.ephemeral, true);
    assert.equal(hilo.approvalsReviewer, 'user');
    // Aislamiento: cada MCP de la configuración efectiva en la raíz se desactiva por nombre, y también las funciones
    // con herramientas fuera del sandbox.
    assert.deepEqual(mensajes.find((m) => m.method === 'config/read').params, { cwd: p.dir });
    assert.deepEqual(hilo.config.mcp_servers, { memoria: { enabled: false }, railway: { enabled: false } });
    for (const funcion of ['apps', 'plugins', 'computer_use', 'browser_use', 'multi_agent']) assert.equal(hilo.config.features[funcion], false, funcion);
    const comprobacion = mensajes.find((m) => m.method === 'mcpServerStatus/list');
    assert.equal(comprobacion.params.threadId, 'hilo-1');
    assert.ok(mensajes.indexOf(comprobacion) < mensajes.findIndex((m) => m.method === 'turn/start'), 'se comprueba antes del turno');
    const turno = mensajes.find((m) => m.method === 'turn/start').params;
    assert.equal(turno.threadId, 'hilo-1');
    assert.equal(turno.model, 'gpt-5.5');
    assert.equal(turno.effort, 'high');
    assert.deepEqual(turno.outputSchema, hallazgosJsonSchema());
    assert.deepEqual(turno.sandboxPolicy, { type: 'readOnly', networkAccess: false });
    assert.equal(turno.input[0].text, 'Revisa el diff.');

    // Escrituras: siempre denegadas.
    assert.deepEqual(respuesta(mensajes, 'srv-1').result, { decision: 'decline' });
    assert.equal(respuesta(mensajes, 'srv-2').result.decision.denied !== undefined, true);
    assert.deepEqual(respuesta(mensajes, 'srv-3').result, { permissions: {}, scope: 'turn' });
    // Órdenes: solo la exacta declarada por la estación.
    assert.deepEqual(respuesta(mensajes, 'srv-4').result, { decision: 'accept' }, 'npm test');
    assert.deepEqual(respuesta(mensajes, 'srv-5').result, { decision: 'decline' }, 'rm -rf x');
    assert.deepEqual(respuesta(mensajes, 'srv-6').result, { decision: 'decline' }, 'npm test && rm -rf x');
    assert.deepEqual(respuesta(mensajes, 'srv-7').result, { decision: 'accept' }, "zsh -lc 'npm test'");
    assert.deepEqual(respuesta(mensajes, 'srv-8').result, { decision: 'decline' }, "zsh -lc 'npm test; rm -rf x'");
    assert.deepEqual(respuesta(mensajes, 'srv-9').result, { decision: 'decline' }, 'escribir en una terminal');
    assert.deepEqual(respuesta(mensajes, 'srv-10').result, { decision: 'decline' }, 'cwd fuera de la raíz');
    assert.equal(respuesta(mensajes, 'srv-11').result.decision, 'approved', 'execCommandApproval npm test');
    assert.ok(respuesta(mensajes, 'srv-12').result.decision.denied, 'execCommandApproval con un solo argumento');
    // Preguntas a la persona y elicitaciones MCP: siempre denegadas.
    assert.deepEqual(respuesta(mensajes, 'srv-13').result, { answers: {} });
    assert.equal(respuesta(mensajes, 'srv-14').result.action, 'decline');
    // Saltos de línea y shells que no son del sistema: denegados aunque el texto parezca `npm test`.
    assert.deepEqual(respuesta(mensajes, 'srv-15').result, { decision: 'decline' }, "zsh -lc 'npm\\ntest'");
    assert.ok(respuesta(mensajes, 'srv-16').result.decision.denied, "bash -lc 'npm\\ntest'");
    assert.ok(respuesta(mensajes, 'srv-17').result.decision.denied, './tools/bash -lc npm test');
    // Un método desconocido nunca se acepta: se contesta con error.
    const desconocida = respuesta(mensajes, 'srv-18');
    assert.equal(desconocida.result, undefined);
    assert.equal(desconocida.error.code, -32603);

    const tipos = resultado.denegaciones.map((d) => d.tipo);
    assert.ok(tipos.includes('item/fileChange/requestApproval'));
    assert.ok(tipos.includes('applyPatchApproval'));
    assert.ok(tipos.includes('item/permissions/requestApproval'));
    assert.ok(resultado.denegaciones.some((d) => d.tipo === 'item/commandExecution/requestApproval' && d.detalle.includes('rm -rf x')));
    assert.equal(resultado.denegaciones.length, 14);
  } finally {
    await p.limpiar();
  }
});

test('sin ordenesPermitidas, npm test también se deniega', async () => {
  const p = preparar('revision');
  try {
    const conector = await p.conector;
    const resultado = await conector.ejecutar(encargo(p.dir, { ordenesPermitidas: [] }), new AbortController().signal);
    assert.equal(resultado.estado, 'ok', resultado.motivo);
    const mensajes = p.mensajes();
    assert.deepEqual(respuesta(mensajes, 'srv-4').result, { decision: 'decline' });
    assert.deepEqual(respuesta(mensajes, 'srv-7').result, { decision: 'decline' });
    assert.ok(respuesta(mensajes, 'srv-11').result.decision.denied);
    assert.equal(resultado.denegaciones.length, 17);
  } finally {
    await p.limpiar();
  }
});

test('ordenPermitida compara exacto: separadores, redirecciones y saltos de línea se deniegan', () => {
  const permitidas = ['npm test'];
  const bash = (guion) => ['bash', '-lc', guion];
  assert.equal(ordenPermitida(bash('npm test'), permitidas), true);
  assert.equal(ordenPermitida(bash('  npm test  '), permitidas), true, 'solo se quitan los espacios de los extremos');
  assert.equal(ordenPermitida(['npm', 'test'], permitidas), true);
  for (const guion of ['npm\ntest', 'npm\rtest', 'npm test\n', 'npm test; rm -rf x', 'npm test & rm -rf x', 'npm test && rm -rf x',
    'npm test | sh', 'npm test || x', 'npm `rm -rf x`', 'npm $(rm -rf x)', 'npm test > salida', 'npm test < entrada', 'npm  test', 'npm\ttest']) {
    assert.equal(ordenPermitida(bash(guion), permitidas), false, JSON.stringify(guion));
  }
  assert.equal(ordenPermitida(['npm', 'test;'], permitidas), false);
  assert.equal(ordenPermitida(['npm test'], permitidas), false);
  assert.equal(ordenPermitida(null, permitidas), false);
  assert.equal(ordenPermitida(bash('npm test'), []), false);
});

test('solo se reconoce un shell por su nombre o por su ruta en una carpeta del sistema', () => {
  assert.equal(esShellDelSistema('bash'), true);
  assert.equal(esShellDelSistema('/bin/zsh', 'darwin'), true);
  assert.equal(esShellDelSistema('/usr/bin/bash', 'linux'), true);
  assert.equal(esShellDelSistema('./tools/bash', 'linux'), false);
  assert.equal(esShellDelSistema('tools/bash', 'linux'), false);
  assert.equal(esShellDelSistema('/home/x/bin/bash', 'linux'), false);
  assert.equal(esShellDelSistema('/bin/../tmp/bash', 'linux'), false);
  assert.equal(esShellDelSistema('/bin/python', 'linux'), false);
  assert.equal(esShellDelSistema('C:\\Windows\\System32\\bash.exe', 'win32', 'C:\\Windows'), true);
  assert.equal(esShellDelSistema('c:\\windows\\system32\\BASH.EXE', 'win32', 'C:\\Windows'), true);
  assert.equal(esShellDelSistema('C:\\Users\\x\\bash.exe', 'win32', 'C:\\Windows'), false);
  assert.equal(esShellDelSistema('C:\\Windows\\System32\\bash.exe', 'win32', ''), false);
  assert.equal(esShellDelSistema('/bin/bash', 'win32', 'C:\\Windows'), false);
  assert.equal(ordenPermitida(['./tools/bash', '-lc', 'npm test'], ['npm test']), false);
});

test('una petición para un hilo ya cerrado se deniega', async () => {
  const p = preparar('hilo-cerrado');
  try {
    const conector = await p.conector;
    const primero = await conector.ejecutar(encargo(p.dir), AbortSignal.timeout(5000));
    assert.equal(primero.estado, 'ok', primero.motivo);
    const segundo = await conector.ejecutar(encargo(p.dir), AbortSignal.timeout(5000));
    assert.equal(segundo.estado, 'ok', segundo.motivo);
    const mensajes = p.mensajes();
    assert.deepEqual(respuesta(mensajes, 'srv-cerrado').result, { decision: 'decline' }, 'npm test permitida, pero de un hilo cerrado');
    assert.deepEqual(respuesta(mensajes, 'srv-cerrado-2').result, { decision: 'decline' });
    assert.equal(mensajes.filter((m) => m.method === 'initialize').length, 1, 'un solo proceso e initialize para los dos encargos');
  } finally {
    await p.limpiar();
  }
});

test('si el hilo conserva un MCP activo o con herramientas, no empieza el turno', async () => {
  const p = preparar('mcp-activo');
  try {
    const resultado = await (await p.conector).ejecutar(encargo(p.dir), AbortSignal.timeout(5000));
    assert.equal(resultado.estado, 'fallida');
    assert.equal(resultado.motivo, 'Codex mantiene activos servidores MCP que podrían escribir: plugin-raro');
    const mensajes = p.mensajes();
    assert.deepEqual(mensajes.filter((m) => m.method === 'mcpServerStatus/list').map((m) => m.params.cursor ?? null), [null, 'p2']);
    assert.equal(mensajes.some((m) => m.method === 'turn/start'), false);
  } finally {
    await p.limpiar();
  }
});

test('si no se puede comprobar el aislamiento de MCP, no empieza el turno', async () => {
  const guion = JSON.parse(readFileSync(join(GUIONES, 'codex-cancelar.json'), 'utf8'));
  delete guion.metodos['mcpServerStatus/list'];
  const p = preparar('cancelar', { metodos: guion.metodos });
  try {
    const resultado = await (await p.conector).ejecutar(encargo(p.dir), AbortSignal.timeout(5000));
    assert.equal(resultado.estado, 'fallida');
    assert.match(resultado.motivo, /No se pudo comprobar que los servidores MCP de Codex estén desactivados/);
    assert.equal(p.mensajes().some((m) => m.method === 'turn/start'), false);
  } finally {
    await p.limpiar();
  }
});

test('un mensaje final que no cumple el esquema da fallida', async () => {
  const p = preparar('invalido');
  try {
    const resultado = await (await p.conector).ejecutar(encargo(p.dir), new AbortController().signal);
    assert.equal(resultado.estado, 'fallida');
    assert.equal(resultado.motivo, 'El revisor no devolvió hallazgos válidos');
    assert.equal(resultado.crudo, '{"hallazgos": "no es una lista"}');
    assert.equal(resultado.informe, undefined);
  } finally {
    await p.limpiar();
  }
});

test('un turno fallido da fallida con el error de Codex', async () => {
  const p = preparar('fallido');
  try {
    const resultado = await (await p.conector).ejecutar(encargo(p.dir, { esfuerzo: null }), new AbortController().signal);
    assert.equal(resultado.estado, 'fallida');
    assert.match(resultado.motivo, /Límite de uso alcanzado/);
    assert.equal('effort' in p.mensajes().find((m) => m.method === 'turn/start').params, false, 'sin esfuerzo no se envía effort');
  } finally {
    await p.limpiar();
  }
});

test('abortar la señal envía turn/interrupt y da cancelada', async () => {
  const p = preparar('cancelar');
  try {
    const conector = await p.conector;
    const control = new AbortController();
    const promesa = conector.ejecutar(encargo(p.dir), control.signal);
    await esperarMensaje(p.mensajes, 'turn/start');
    control.abort();
    const resultado = await promesa;
    assert.equal(resultado.estado, 'cancelada');
    await esperarMensaje(p.mensajes, 'turn/interrupt');
    const interrupcion = p.mensajes().find((m) => m.method === 'turn/interrupt').params;
    assert.deepEqual(interrupcion, { threadId: 'hilo-1', turnId: 'turno-1' });
  } finally {
    await p.limpiar();
  }
});

test('una señal ya abortada no abre ningún hilo', async () => {
  const p = preparar('cancelar');
  try {
    const control = new AbortController();
    control.abort();
    const resultado = await (await p.conector).ejecutar(encargo(p.dir), control.signal);
    assert.equal(resultado.estado, 'cancelada');
    assert.equal(p.mensajes().some((m) => m.method === 'thread/start'), false);
  } finally {
    await p.limpiar();
  }
});

test('si el proceso de Codex muere a mitad del turno, da fallida', async () => {
  const p = preparar('cancelar', {
    metodos: {
      ...JSON.parse(readFileSync(join(GUIONES, 'codex-cancelar.json'), 'utf8')).metodos,
      'turn/start': { resultado: { turn: { id: 'turno-1' } }, salir: 3 },
    },
  });
  try {
    const resultado = await (await p.conector).ejecutar(encargo(p.dir), new AbortController().signal);
    assert.equal(resultado.estado, 'fallida');
    assert.match(resultado.motivo, /Codex terminó/);
  } finally {
    await p.limpiar();
  }
});

test('si la orden no existe: fallida con «Codex no está instalado»', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexakit-codex-'));
  const conector = await crearConectorCodex({ orden: join(dir, 'no-existe', 'codex') });
  try {
    const resultado = await conector.ejecutar(encargo(dir), new AbortController().signal);
    assert.equal(resultado.estado, 'fallida');
    assert.equal(resultado.motivo, 'Codex no está instalado');
    await assert.rejects(conector.catalogo(), /Codex no está instalado/);
  } finally {
    await conector.cerrar();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sin codex en el PATH, el conector por defecto da «Codex no está instalado»', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexakit-codex-'));
  const antes = process.env.PATH;
  process.env.PATH = dir;
  try {
    const conector = await crearConectorCodex();
    const resultado = await conector.ejecutar(encargo(dir), new AbortController().signal);
    assert.equal(resultado.estado, 'fallida');
    assert.equal(resultado.motivo, 'Codex no está instalado');
    await conector.cerrar();
  } finally {
    process.env.PATH = antes;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('versionTiposCodex() avisa si la versión instalada no es la de los tipos, y catalogo() sigue funcionando', async () => {
  const p = preparar('catalogo');
  try {
    const opciones = { orden: process.execPath, argsPrefijo: [SERVIDOR, p.rutaGuion] };
    const version = await versionTiposCodex(opciones);
    assert.equal(version.tipos, VERSION_TIPOS);
    assert.equal(version.instalada, 'codex-cli 0.0.1');
    assert.equal(version.aviso, `Los tipos de Codex se generaron con ${VERSION_TIPOS}; regenera con npm run tipos:codex`);
    assert.equal((await (await p.conector).catalogo()).length, 2);
  } finally {
    await p.limpiar();
  }
});

test('versionTiposCodex() no avisa si la versión coincide', async () => {
  const p = preparar('catalogo', { version: VERSION_TIPOS });
  try {
    const version = await versionTiposCodex({ orden: process.execPath, argsPrefijo: [SERVIDOR, p.rutaGuion] });
    assert.equal(version.instalada, VERSION_TIPOS);
    assert.equal(version.aviso, null);
  } finally {
    await p.limpiar();
  }
});

// Contrato: lo que el conector envía cumple el JSON Schema que publica el `codex` instalado.
let invocacionCodex = null;
try {
  invocacionCodex = await resolveCliInvocation({ name: 'codex' });
} catch {
  invocacionCodex = null;
}

test(
  'los mensajes enviados cumplen el JSON Schema de codex app-server',
  { skip: invocacionCodex ? false : 'Codex no está instalado: se omite la prueba de contrato con su JSON Schema' },
  async () => {
    const dirEsquemas = mkdtempSync(join(tmpdir(), 'nexakit-esquemas-codex-'));
    try {
      // HOME temporal: la prueba no escribe en el HOME real.
      execFileSync(invocacionCodex.executable, [...invocacionCodex.argsPrefix, 'app-server', 'generate-json-schema', '--out', join(dirEsquemas, 'esquemas')], {
        env: { ...process.env, HOME: dirEsquemas, USERPROFILE: dirEsquemas, CODEX_HOME: dirEsquemas },
        stdio: 'ignore',
      });
      const ajv = new Ajv({ strict: false, validateFormats: false, allErrors: true });
      const validar = (relativo, datos) => {
        const esquema = JSON.parse(readFileSync(join(dirEsquemas, 'esquemas', relativo), 'utf8'));
        const valido = ajv.compile(esquema)(datos);
        assert.ok(valido, `${relativo}: ${JSON.stringify(ajv.errors)}`);
      };

      const revision = preparar('revision');
      const cancelar = preparar('cancelar');
      const catalogo = preparar('catalogo');
      try {
        await (await revision.conector).ejecutar(encargo(revision.dir, { imagenes: [join(revision.dir, 'captura.png')] }), new AbortController().signal);
        const control = new AbortController();
        const promesa = (await cancelar.conector).ejecutar(encargo(cancelar.dir, { esfuerzo: null }), control.signal);
        await esperarMensaje(cancelar.mensajes, 'turn/start');
        control.abort();
        await promesa;
        await (await catalogo.conector).catalogo();

        const enviados = [...revision.mensajes(), ...cancelar.mensajes(), ...catalogo.mensajes()];
        const porMetodo = {
          initialize: 'v1/InitializeParams.json',
          'model/list': 'v2/ModelListParams.json',
          'thread/start': 'v2/ThreadStartParams.json',
          'turn/start': 'v2/TurnStartParams.json',
          'turn/interrupt': 'v2/TurnInterruptParams.json',
          'config/read': 'v2/ConfigReadParams.json',
          'mcpServerStatus/list': 'v2/ListMcpServerStatusParams.json',
        };
        for (const m of enviados.filter((x) => x.method && x.id !== undefined)) {
          assert.ok(porMetodo[m.method], `método sin esquema conocido: ${m.method}`);
          validar(porMetodo[m.method], m.params);
        }
        const respuestas = {
          'srv-1': 'FileChangeRequestApprovalResponse.json',
          'srv-2': 'ApplyPatchApprovalResponse.json',
          'srv-3': 'PermissionsRequestApprovalResponse.json',
          'srv-13': 'ToolRequestUserInputResponse.json',
          'srv-14': 'McpServerElicitationRequestResponse.json',
          'srv-11': 'ExecCommandApprovalResponse.json',
          'srv-12': 'ExecCommandApprovalResponse.json',
          'srv-16': 'ExecCommandApprovalResponse.json',
          'srv-17': 'ExecCommandApprovalResponse.json',
          'srv-15': 'CommandExecutionRequestApprovalResponse.json',
        };
        for (let i = 4; i <= 10; i++) respuestas[`srv-${i}`] = 'CommandExecutionRequestApprovalResponse.json';
        const deRevision = revision.mensajes();
        for (const [id, esquema] of Object.entries(respuestas)) validar(esquema, respuesta(deRevision, id).result);
      } finally {
        await Promise.all([revision.limpiar(), cancelar.limpiar(), catalogo.limpiar()]);
      }
    } finally {
      rmSync(dirEsquemas, { recursive: true, force: true });
    }
  },
);
