import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, mkdtempSync, realpathSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv } from 'ajv';
import {
  configDePerfil, crearConectorCodex, crearHomeAislado, esShellDelSistema, ordenPermitida, perfilDeEncargo, PERFIL_ENCARGO,
  versionTiposCodex, vetosDeLectura,
} from '../dist/fabrica/conectores/codex.js';
import { hallazgosJsonSchema } from '../dist/fabrica/esquemas.js';
import { resolveCliInvocation } from '../src/cli-executable.js';

const SERVIDOR = fileURLToPath(new URL('../test-support/fabrica/servidor-falso.mjs', import.meta.url));
const GUIONES = fileURLToPath(new URL('../test-support/fabrica/', import.meta.url));
const VERSION_TIPOS = readFileSync(new URL('../src/fabrica/protocolos/codex/VERSION', import.meta.url), 'utf8').trim();

// El modo escritura crea un CODEX_HOME aislado que enlaza `auth.json` del real: en las pruebas, el «real» es una carpeta
// temporal con un auth.json falso, nunca el de la persona.
const CODEX_HOME_PREVIO = process.env.CODEX_HOME;
const CODEX_HOME_PRUEBAS = mkdtempSync(join(tmpdir(), 'nexakit-codex-home-pruebas-'));
writeFileSync(join(CODEX_HOME_PRUEBAS, 'auth.json'), '{}');
test.before(() => {
  process.env.CODEX_HOME = CODEX_HOME_PRUEBAS;
});
test.after(() => {
  if (CODEX_HOME_PREVIO === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = CODEX_HOME_PREVIO;
  rmSync(CODEX_HOME_PRUEBAS, { recursive: true, force: true });
});
const POSIX = process.platform !== 'win32';

/** Prepara un guion con registro de mensajes y una carpeta de trabajo que hace de raíz del repo. */
function preparar(nombre, cambios = {}, opcionesConector = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'nexakit-codex-'));
  const guion = { ...JSON.parse(readFileSync(join(GUIONES, `codex-${nombre}.json`), 'utf8')), ...cambios };
  guion.registro = join(dir, 'registro.ndjson');
  const rutaGuion = join(dir, 'guion.json');
  writeFileSync(rutaGuion, JSON.stringify(guion));
  // El modo escritura acota la lectura solo en macOS: estas pruebas fijan otra plataforma salvo que pidan darwin (con un
  // home falso), para no depender del sistema ni recorrer la carpeta personal de quien las ejecuta.
  const conector = crearConectorCodex({ orden: process.execPath, argsPrefijo: [SERVIDOR, rutaGuion], plataforma: 'linux', ...opcionesConector });
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

test('catalogo() descarta los modelos y esfuerzos con nombres no seguros', async () => {
  const modelo = (nombre, esfuerzos) => ({
    id: nombre,
    model: nombre,
    hidden: false,
    supportedReasoningEfforts: esfuerzos.map((reasoningEffort) => ({ reasoningEffort, description: '' })),
    defaultReasoningEffort: esfuerzos[0],
  });
  const base = JSON.parse(readFileSync(join(GUIONES, 'codex-catalogo.json'), 'utf8'));
  const data = [
    modelo('gpt-6.1-terra', ['medium', 'low\nAviso: falso', 'alto\talto', 'x'.repeat(81), 'a b', 'high']),
    modelo('gpt-9\n| fila | falsa |', ['high']),
    modelo('con espacio', ['high']),
    modelo('con/barra', ['high']),
    modelo('-empieza-con-guion', ['high']),
    modelo('m'.repeat(81), ['high']),
    modelo('m'.repeat(80), ['high']),
    modelo('gpt-6.1-sol:v2_x.1', ['xhigh']),
  ];
  const p = preparar('catalogo', { metodos: { ...base.metodos, 'model/list': [{ resultado: { data, nextCursor: null } }] } });
  try {
    assert.deepEqual(await (await p.conector).catalogo(), [
      { modelo: 'gpt-6.1-terra', esfuerzos: ['medium', 'high'] },
      { modelo: 'm'.repeat(80), esfuerzos: ['high'] },
      { modelo: 'gpt-6.1-sol:v2_x.1', esfuerzos: ['xhigh'] },
    ]);
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

test('sin la opción escritura, la petición sigue siendo de solo lectura, sin política de escritura', async () => {
  const p = preparar('revision');
  try {
    const resultado = await (await p.conector).ejecutar(encargo(p.dir), new AbortController().signal);
    assert.equal(resultado.estado, 'ok', resultado.motivo);
    const mensajes = p.mensajes();
    const hilo = mensajes.find((m) => m.method === 'thread/start').params;
    const turno = mensajes.find((m) => m.method === 'turn/start').params;
    assert.deepEqual(Object.keys(hilo).sort(), ['approvalPolicy', 'approvalsReviewer', 'config', 'cwd', 'ephemeral', 'model', 'sandbox']);
    assert.equal(hilo.sandbox, 'read-only');
    assert.equal(hilo.approvalPolicy, 'untrusted');
    assert.equal(JSON.stringify(turno.sandboxPolicy), '{"type":"readOnly","networkAccess":false}');
    assert.equal(turno.approvalPolicy, 'untrusted');
    assert.equal(JSON.stringify(turno).includes('workspaceWrite'), false);
  } finally {
    await p.limpiar();
  }
});

test('con escritura: { raiz } el hilo y el turno son workspace-write solo en esa raíz, sin red ni aprobaciones', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexakit-codex-raiz-'));
  const raiz = join(dir, 'worktree');
  mkdirSync(raiz);
  const p = preparar('revision', {}, { escritura: { raiz } });
  try {
    const resultado = await (await p.conector).ejecutar(encargo(raiz), new AbortController().signal);
    assert.equal(resultado.estado, 'ok', resultado.motivo);
    const mensajes = p.mensajes();
    const hilo = mensajes.find((m) => m.method === 'thread/start').params;
    const turno = mensajes.find((m) => m.method === 'turn/start').params;
    const canonica = realpathSync(raiz);
    assert.equal(hilo.sandbox, 'workspace-write');
    assert.equal(hilo.approvalPolicy, 'never');
    assert.equal(hilo.approvalsReviewer, 'user');
    assert.deepEqual(turno.sandboxPolicy, {
      type: 'workspaceWrite',
      writableRoots: [canonica],
      networkAccess: false,
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true,
    });
    assert.equal(turno.approvalPolicy, 'never');
    // Sigue sin MCP ni funciones con herramientas fuera del sandbox.
    assert.deepEqual(hilo.config.mcp_servers, { memoria: { enabled: false }, railway: { enabled: false } });
    assert.equal(hilo.config.features.apps, false);
    assert.deepEqual(hilo.config.sandbox_workspace_write, {
      writable_roots: [canonica], network_access: false, exclude_tmpdir_env_var: true, exclude_slash_tmp: true,
    });
    assert.equal(hilo.cwd, canonica);
    assert.equal(turno.cwd, canonica);
    assert.ok(mensajes.some((m) => m.method === 'mcpServerStatus/list'));
    // Si el servidor pidiera aprobaciones, se rechazan igual que en solo lectura.
    assert.deepEqual(respuesta(mensajes, 'srv-1').result, { decision: 'decline' });
    assert.equal(respuesta(mensajes, 'srv-2').result.decision.denied !== undefined, true);
    assert.deepEqual(respuesta(mensajes, 'srv-3').result, { permissions: {}, scope: 'turn' });
  } finally {
    await p.limpiar();
    rmSync(dir, { recursive: true, force: true });
  }
});

/** El guion `invalido` con otro texto como última respuesta del agente. */
function guionConRespuesta(texto) {
  const base = JSON.parse(readFileSync(join(GUIONES, 'codex-invalido.json'), 'utf8'));
  for (const n of base.metodos['turn/start'].notificaciones) if (n.metodo === 'item/completed') n.params.item.text = texto;
  return base.metodos;
}

test('en modo escritura el turno pide solo un resumen y lo toma de la respuesta; sin escritura sigue pidiendo hallazgos', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexakit-codex-raiz-'));
  const raiz = join(dir, 'worktree');
  mkdirSync(raiz);
  const esquemaResumen = { type: 'object', properties: { resumen: { type: 'string' } }, required: ['resumen'], additionalProperties: false };
  try {
    for (const [respuestaFinal, esperado] of [
      ['{"resumen":"Cambios hechos."}', 'Cambios hechos.'],
      ['Listo: cambié dos archivos.\n', 'Listo: cambié dos archivos.'],
      ['{"otra":1}', '{"otra":1}'],
    ]) {
      const p = preparar('invalido', { metodos: guionConRespuesta(respuestaFinal) }, { escritura: { raiz } });
      try {
        const resultado = await (await p.conector).ejecutar(encargo(raiz), new AbortController().signal);
        assert.equal(resultado.estado, 'ok', resultado.motivo);
        assert.deepEqual(resultado.informe, { hallazgos: [], resumen: esperado });
        assert.deepEqual(p.mensajes().find((m) => m.method === 'turn/start').params.outputSchema, esquemaResumen);
      } finally {
        await p.limpiar();
      }
    }
    // En solo lectura la misma respuesta de texto libre no vale: hacen falta hallazgos.
    const lectura = preparar('invalido', { metodos: guionConRespuesta('Listo.') });
    try {
      const resultado = await (await lectura.conector).ejecutar(encargo(lectura.dir), new AbortController().signal);
      assert.equal(resultado.estado, 'fallida');
      assert.match(resultado.motivo, /hallazgos válidos/);
      assert.deepEqual(lectura.mensajes().find((m) => m.method === 'turn/start').params.outputSchema, hallazgosJsonSchema());
    } finally {
      await lectura.limpiar();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('en modo escritura, un encargo con otra raíz falla cerrado sin enviar thread/start', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexakit-codex-raiz-'));
  const raiz = join(dir, 'worktree');
  const otra = join(dir, 'repo-de-la-persona');
  mkdirSync(raiz);
  mkdirSync(otra);
  const p = preparar('revision', {}, { escritura: { raiz } });
  try {
    const resultado = await (await p.conector).ejecutar(encargo(otra), new AbortController().signal);
    assert.equal(resultado.estado, 'fallida');
    assert.match(resultado.motivo, /raíz del encargo debe ser exactamente la carpeta escribible/);
    assert.equal(p.mensajes().some((m) => m.method === 'thread/start'), false);
  } finally {
    await p.limpiar();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('en modo escritura, el app-server arranca con un CODEX_HOME aislado sin rules/, que se borra al cerrar', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexakit-codex-raiz-'));
  const raiz = join(dir, 'worktree');
  mkdirSync(raiz);
  const p = preparar('revision', {}, { escritura: { raiz } });
  const registroEnv = join(dir, 'env.json');
  const guion = JSON.parse(readFileSync(p.rutaGuion, 'utf8'));
  writeFileSync(p.rutaGuion, JSON.stringify({ ...guion, registroEnv }));
  let home;
  try {
    const resultado = await (await p.conector).ejecutar(encargo(raiz), new AbortController().signal);
    assert.equal(resultado.estado, 'ok', resultado.motivo);
    const visto = JSON.parse(readFileSync(registroEnv, 'utf8'));
    home = visto.home;
    assert.ok(home && home !== join(process.env.HOME ?? '', '.codex') && home !== CODEX_HOME_PRUEBAS);
    if (POSIX) assert.equal(visto.modo, 0o700);
    assert.equal(visto.enlaceAuth, true, 'enlaza el auth.json del CODEX_HOME de las pruebas');
    // Sin carpeta temporal del encargo no se toca el TMPDIR heredado.
    assert.equal(visto.temporales.TMPDIR, process.env.TMPDIR ?? null);
    assert.equal(visto.archivos.includes('rules'), false);
    assert.deepEqual(visto.archivos.filter((a) => a !== 'auth.json'), ['config.toml']);
  } finally {
    await p.limpiar();
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(existsSync(home), false, 'el home aislado se borra al cerrar');
});

test('en modo lectura el app-server no cambia CODEX_HOME', async () => {
  const p = preparar('revision');
  const registroEnv = join(p.dir, 'env.json');
  const guion = JSON.parse(readFileSync(p.rutaGuion, 'utf8'));
  writeFileSync(p.rutaGuion, JSON.stringify({ ...guion, registroEnv }));
  try {
    const resultado = await (await p.conector).ejecutar(encargo(p.dir), new AbortController().signal);
    assert.equal(resultado.estado, 'ok', resultado.motivo);
    assert.equal(JSON.parse(readFileSync(registroEnv, 'utf8')).home, process.env.CODEX_HOME ?? null);
  } finally {
    await p.limpiar();
  }
});

test('crearHomeAislado enlaza solo auth.json del home real, con config mínima y sin rules/', async () => {
  const base = mkdtempSync(join(tmpdir(), 'nexakit-home-base-'));
  const real = join(base, 'real');
  mkdirSync(join(real, 'rules'), { recursive: true });
  writeFileSync(join(real, 'auth.json'), '{}');
  writeFileSync(join(real, 'rules', 'default.rules'), 'prefix_rule(pattern=["git","push"], decision="allow")');
  try {
    const h = await crearHomeAislado({ CODEX_HOME: real }, base);
    if (POSIX) assert.equal(lstatSync(h.ruta).mode & 0o777, 0o700);
    assert.deepEqual(readdirSync(h.ruta).sort(), ['auth.json', 'config.toml']);
    assert.equal(readlinkSync(join(h.ruta, 'auth.json')), join(real, 'auth.json'));
    await h.borrar();
    assert.equal(existsSync(h.ruta), false);
    assert.equal(existsSync(join(real, 'auth.json')), true, 'borrar no toca el home real');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('con escritura: { raiz, tmp } la carpeta temporal del encargo es la otra raíz escribible y el app-server la exporta como TMPDIR', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexakit-codex-raiz-'));
  const raiz = join(dir, 'repo');
  const tmp = join(dir, 'tmp');
  mkdirSync(raiz);
  mkdirSync(tmp);
  const p = preparar('revision', {}, { escritura: { raiz, tmp } });
  const registroEnv = join(dir, 'env.json');
  const guion = JSON.parse(readFileSync(p.rutaGuion, 'utf8'));
  writeFileSync(p.rutaGuion, JSON.stringify({ ...guion, registroEnv }));
  try {
    const resultado = await (await p.conector).ejecutar(encargo(raiz), new AbortController().signal);
    assert.equal(resultado.estado, 'ok', resultado.motivo);
    const mensajes = p.mensajes();
    const hilo = mensajes.find((m) => m.method === 'thread/start').params;
    const turno = mensajes.find((m) => m.method === 'turn/start').params;
    const [canonRaiz, canonTmp] = [realpathSync(raiz), realpathSync(tmp)];
    assert.deepEqual(turno.sandboxPolicy.writableRoots, [canonRaiz, canonTmp]);
    assert.equal(turno.sandboxPolicy.networkAccess, false);
    assert.equal(turno.sandboxPolicy.excludeTmpdirEnvVar, true);
    assert.equal(turno.sandboxPolicy.excludeSlashTmp, true);
    assert.deepEqual(hilo.config.sandbox_workspace_write.writable_roots, [canonRaiz, canonTmp]);
    assert.equal(hilo.cwd, canonRaiz, 'el cwd sigue siendo la copia, no la carpeta temporal');
    const visto = JSON.parse(readFileSync(registroEnv, 'utf8'));
    assert.deepEqual(visto.temporales, { TMPDIR: canonTmp, TMP: canonTmp, TEMP: canonTmp });
  } finally {
    await p.limpiar();
    rmSync(dir, { recursive: true, force: true });
  }
  await assert.rejects(crearConectorCodex({ escritura: { raiz: tmpdir(), tmp: 'relativa' } }), /carpeta temporal del encargo debe ser una ruta absoluta/);
});

/** Carpeta personal falsa con secretos, otro proyecto, otro encargo y la copia y la carpeta temporal de un encargo. */
function homeFalso() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'nexakit-home-falso-')));
  const crear = (ruta, contenido = 'secreto') => {
    mkdirSync(join(home, ruta, '..'), { recursive: true });
    writeFileSync(join(home, ruta), contenido);
  };
  crear('.ssh/id_ed25519');
  crear('.aws/credentials');
  crear('.npmrc');
  crear('.nexakit/fabrica/preferencias.json');
  crear('.nexakit/encargos/otro/cambios.diff');
  crear('proyectos/real/src/a.ts');
  crear('proyectos/real/secreto.env');
  crear('proyectos/real/node_modules/zod/index.js');
  crear('proyectos/real/.git/HEAD');
  crear('proyectos/otro/README.md');
  crear('.nexakit/encargos/e1/repo/package.json', '{}');
  mkdirSync(join(home, '.nexakit/encargos/e1/tmp'));
  return {
    home,
    raiz: join(home, '.nexakit/encargos/e1/repo'),
    tmp: join(home, '.nexakit/encargos/e1/tmp'),
    limpiar: () => rmSync(home, { recursive: true, force: true }),
  };
}

test('vetosDeLectura veta la carpeta personal entera salvo el camino hasta cada ruta permitida', () => {
  const h = homeFalso();
  try {
    const real = join(h.home, 'proyectos/real');
    const vetos = vetosDeLectura(h.home, [h.raiz, h.tmp, join(real, 'node_modules'), join(real, '.git')]).sort();
    assert.deepEqual(vetos, [
      '.aws', '.npmrc', '.nexakit/encargos/otro', '.nexakit/fabrica', '.ssh', 'proyectos/otro', 'proyectos/real/secreto.env',
      'proyectos/real/src',
    ].map((r) => join(h.home, r)).sort());
    // Sin nada permitido dentro, la carpeta entera.
    assert.deepEqual(vetosDeLectura(join(h.home, '.ssh'), [h.raiz]), [join(h.home, '.ssh')]);
    // Dentro de una ruta permitida no se veta nada.
    assert.deepEqual(vetosDeLectura(h.raiz, [h.raiz]), []);
  } finally {
    h.limpiar();
  }
});

test('vetosDeLectura falla cerrado con un nombre que Codex no sabe vetar', () => {
  const h = homeFalso();
  try {
    mkdirSync(join(h.home, 'fotos[2024]'));
    assert.throws(() => vetosDeLectura(h.home, [h.raiz]), /No se puede vetar la lectura de .*fotos\[2024\]/);
  } finally {
    h.limpiar();
  }
});

test('perfilDeEncargo: todo legible salvo el home vetado, las lecturas imprescindibles y las raíces escribibles', () => {
  const h = homeFalso();
  try {
    const nodeModules = join(h.home, 'proyectos/real/node_modules');
    const entradas = perfilDeEncargo({
      home: h.home,
      escribibles: [h.raiz, h.tmp],
      // `/` (un ejecutable en /bin) anularía el veto y se ignora; lo que ya es escribible o está dentro de otra lectura, también.
      legibles: [nodeModules, join(nodeModules, 'zod'), join(h.raiz, 'package.json'), join(h.home, '..', '..')],
    });
    assert.deepEqual(entradas[0], { ruta: ':root', acceso: 'read' });
    assert.deepEqual(entradas.filter((e) => e.acceso === 'read').map((e) => e.ruta), [':root', nodeModules]);
    assert.deepEqual(entradas.filter((e) => e.acceso === 'write').map((e) => e.ruta), [h.raiz, h.tmp]);
    const vetadas = entradas.filter((e) => e.acceso === 'none').map((e) => e.ruta);
    for (const r of ['.ssh', '.aws', '.npmrc', '.nexakit/encargos/otro', 'proyectos/real/src', 'proyectos/real/.git']) {
      assert.ok(vetadas.includes(join(h.home, r)), r);
    }
    assert.equal(vetadas.some((r) => h.raiz.startsWith(r) || nodeModules.startsWith(r)), false, 'ningún antecesor vetado');

    const toml = configDePerfil(entradas, h.tmp);
    assert.match(toml, new RegExp(`^default_permissions = "${PERFIL_ENCARGO}"$`, 'm'));
    assert.match(toml, /^\[permissions\.nexakit-encargo\.network\]\nenabled = false$/m);
    assert.ok(toml.includes(`${JSON.stringify(join(h.home, '.ssh'))} = "none"`));
    assert.ok(toml.includes(`[shell_environment_policy.set]\nHOME = ${JSON.stringify(h.tmp)}`));
    assert.equal(configDePerfil([{ ruta: '/a\u007fb', acceso: 'none' }]).includes('"/a\\u007Fb" = "none"'), true, 'DEL escapado');
  } finally {
    h.limpiar();
  }
});

/** El guion `revision` con el perfil activo que devuelve thread/start (o sin él). */
function guionConPerfil(perfil) {
  const base = JSON.parse(readFileSync(join(GUIONES, 'codex-revision.json'), 'utf8'));
  const hilo = base.metodos['thread/start'];
  return { ...base.metodos, 'thread/start': { ...hilo, resultado: { ...hilo.resultado, activePermissionProfile: perfil } } };
}

test('en macOS el modo escritura corre con el perfil que veta leer la carpeta personal, sin sandbox ni sandboxPolicy', async () => {
  const h = homeFalso();
  const p = preparar('revision', { metodos: guionConPerfil({ id: PERFIL_ENCARGO, extends: null }) }, {
    escritura: { raiz: h.raiz, tmp: h.tmp }, plataforma: 'darwin', home: h.home,
  });
  const registroEnv = join(p.dir, 'env.json');
  const guion = JSON.parse(readFileSync(p.rutaGuion, 'utf8'));
  writeFileSync(p.rutaGuion, JSON.stringify({ ...guion, registroEnv }));
  try {
    const resultado = await (await p.conector).ejecutar(encargo(h.raiz), new AbortController().signal);
    assert.equal(resultado.estado, 'ok', resultado.motivo);
    const mensajes = p.mensajes();
    const hilo = mensajes.find((m) => m.method === 'thread/start').params;
    const turno = mensajes.find((m) => m.method === 'turn/start').params;
    // `sandbox` o `sandboxPolicy` sustituirían el perfil por defecto (comprobado con codex-cli 0.171.0).
    assert.equal('sandbox' in hilo, false);
    assert.equal('sandboxPolicy' in turno, false);
    assert.equal(hilo.config.sandbox_workspace_write, undefined);
    assert.equal(hilo.approvalPolicy, 'never');
    assert.equal(turno.approvalPolicy, 'never');
    assert.equal(hilo.cwd, h.raiz);
    assert.deepEqual(hilo.config.mcp_servers, { memoria: { enabled: false }, railway: { enabled: false } });

    const { config } = JSON.parse(readFileSync(registroEnv, 'utf8'));
    assert.match(config, new RegExp(`^default_permissions = "${PERFIL_ENCARGO}"$`, 'm'));
    assert.ok(config.includes('":root" = "read"'));
    for (const r of ['.ssh', '.aws', '.npmrc', 'proyectos', '.nexakit/encargos/otro', '.nexakit/fabrica']) {
      assert.ok(config.includes(`${JSON.stringify(join(h.home, r))} = "none"`), r);
    }
    assert.ok(config.includes(`${JSON.stringify(h.raiz)} = "write"`));
    assert.ok(config.includes(`${JSON.stringify(h.tmp)} = "write"`));
    assert.ok(config.includes(`HOME = ${JSON.stringify(h.tmp)}`));
    assert.match(config, /enabled = false/);
  } finally {
    await p.limpiar();
    h.limpiar();
  }
});

test('en macOS, si Codex no aplica el perfil de lectura acotada, el encargo falla cerrado antes del turno', async () => {
  const h = homeFalso();
  try {
    for (const perfil of [null, { id: ':workspace', extends: null }]) {
      const p = preparar('revision', { metodos: guionConPerfil(perfil) }, {
        escritura: { raiz: h.raiz, tmp: h.tmp }, plataforma: 'darwin', home: h.home,
      });
      try {
        const resultado = await (await p.conector).ejecutar(encargo(h.raiz), new AbortController().signal);
        assert.equal(resultado.estado, 'fallida');
        assert.match(resultado.motivo, /no aplicó el perfil de permisos nexakit-encargo/);
        assert.equal(p.mensajes().some((m) => m.method === 'turn/start'), false);
      } finally {
        await p.limpiar();
      }
    }
  } finally {
    h.limpiar();
  }
});

test('el modo lectura no usa el perfil aunque sea macOS', async () => {
  const p = preparar('revision', {}, { plataforma: 'darwin' });
  try {
    const resultado = await (await p.conector).ejecutar(encargo(p.dir), new AbortController().signal);
    assert.equal(resultado.estado, 'ok', resultado.motivo);
    const hilo = p.mensajes().find((m) => m.method === 'thread/start').params;
    assert.equal(hilo.sandbox, 'read-only');
  } finally {
    await p.limpiar();
  }
});

test('escritura.raiz debe ser absoluta y existir, con un error claro en español', async () => {
  await assert.rejects(crearConectorCodex({ escritura: { raiz: 'relativa/carpeta' } }), /raíz de escritura debe ser una ruta absoluta/);
  await assert.rejects(
    crearConectorCodex({ escritura: { raiz: join(tmpdir(), 'nexakit-no-existe-xyz') } }),
    /raíz de escritura no existe o no es una carpeta/,
  );
  const dir = mkdtempSync(join(tmpdir(), 'nexakit-codex-raiz-'));
  try {
    const archivo = join(dir, 'a.txt');
    writeFileSync(archivo, 'x');
    await assert.rejects(crearConectorCodex({ escritura: { raiz: archivo } }), /no existe o no es una carpeta/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
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
