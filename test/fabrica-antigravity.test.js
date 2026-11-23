import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { borrarCarpetaAislada, crearConectorAntigravity, modoAnunciado, personalizacionesPeligrosas } from '../dist/fabrica/conectores/antigravity.js';
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
  guion.registroCwd = join(dir, 'cwd.txt');
  const rutaGuion = join(dir, 'guion.json');
  writeFileSync(rutaGuion, JSON.stringify(guion));
  const conector = crearConectorAntigravity({ orden: process.execPath, argsPrefijo: [SERVIDOR, rutaGuion] });
  return {
    dir,
    raiz,
    conector,
    mensajes: () => (existsSync(guion.registro) ? readFileSync(guion.registro, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
    args: () => JSON.parse(readFileSync(guion.registroArgs, 'utf8')),
    cwd: () => readFileSync(guion.registroCwd, 'utf8'),
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

test('catalogo() descarta los modelos con nombres no seguros', async () => {
  const base = guionBase('catalogo');
  const nuevo = JSON.parse(JSON.stringify(base.metodos['session/new']));
  nuevo.resultado.models.availableModels = [
    'gemini-4-argon-high',
    'gemini-4\n| fila | falsa |-low',
    'con espacio-low',
    'con/barra-high',
    '-guion-medium',
    `${'m'.repeat(76)}-low`,
    `${'m'.repeat(77)}-low`,
    'gemini-3.8-flash-medium',
  ].map((modelId) => ({ modelId, name: modelId }));
  const p = preparar('catalogo', { metodos: { ...base.metodos, 'session/new': nuevo } });
  try {
    assert.deepEqual(await (await p.conector).catalogo(), [
      { modelo: 'gemini-4-argon-high', esfuerzos: ['high'] },
      { modelo: `${'m'.repeat(76)}-low`, esfuerzos: ['low'] },
      { modelo: 'gemini-3.8-flash-medium', esfuerzos: ['medium'] },
    ]);
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
    if (process.platform !== 'win32') assert.equal(statSync(carpeta).mode & 0o777, 0o700);
    assert.equal(p.cwd(), realpathSync(carpeta), 'el proceso arranca en la carpeta aislada, no en el directorio de trabajo');
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

/** Prepara en el repo de prueba una personalización: carpeta, archivo o enlace simbólico. */
function crearEn(raiz, ruta, tipo) {
  const destino = join(raiz, ruta);
  mkdirSync(join(destino, '..'), { recursive: true });
  if (tipo === 'carpeta') mkdirSync(destino, { recursive: true });
  else if (tipo === 'archivo') writeFileSync(destino, '{}');
  else {
    const objetivo = join(raiz, 'objetivo-enlace');
    mkdirSync(join(objetivo, 'skills'), { recursive: true });
    symlinkSync(objetivo, destino);
  }
  return destino;
}

test('lista blanca: .gemini/, entradas desconocidas o enlaces en .agents impiden abrir la sesión', async () => {
  const casos = [
    ['.gemini/settings.json', 'archivo', '.gemini'],
    ['.agents/hooks.json', 'archivo', '.agents/hooks.json'],
    ['.agents/plugins', 'carpeta', '.agents/plugins'],
    ['.agents/otra-cosa', 'carpeta', '.agents/otra-cosa'],
    ['_agent/mcp_config.json', 'archivo', '_agent/mcp_config.json'],
    ['.agent/skills', 'enlace', '.agent/skills'],
    ['.agents', 'enlace', '.agents'],
  ];
  for (const [ruta, tipo, esperada] of casos) {
    const p = preparar('revision');
    try {
      crearEn(p.raiz, ruta, tipo);
      const resultado = await (await p.conector).ejecutar(encargo(p.raiz), AbortSignal.timeout(10_000));
      assert.equal(resultado.estado, 'fallida', ruta);
      assert.match(resultado.motivo, /personalizaciones de Antigravity que la fábrica no admite/, ruta);
      assert.ok(resultado.motivo.includes(join(p.raiz, esperada)), `${ruta}: ${resultado.motivo}`);
      assert.equal(p.mensajes().some((m) => m.method === 'session/new'), false, ruta);
    } finally {
      await p.limpiar();
    }
  }
});

test('lista blanca: .gemini/ en un ancestro hasta la raíz git también impide abrir la sesión', async () => {
  const p = preparar('revision');
  try {
    const sub = join(p.raiz, 'paquete');
    mkdirSync(sub, { recursive: true });
    crearEn(p.raiz, '.gemini/settings.json', 'archivo');
    const resultado = await (await p.conector).ejecutar(encargo(sub), AbortSignal.timeout(10_000));
    assert.equal(resultado.estado, 'fallida');
    assert.ok(resultado.motivo.includes(join(p.raiz, '.gemini')), resultado.motivo);
    assert.equal(p.mensajes().some((m) => m.method === 'session/new'), false);
  } finally {
    await p.limpiar();
  }
});

test('lista blanca: skills, rules y workflows en .agents se admiten', async () => {
  const p = preparar('revision');
  try {
    for (const nombre of ['skills/x', 'rules', 'workflows']) crearEn(p.raiz, `.agents/${nombre}`, 'carpeta');
    // Dentro de skills puede haber enlaces (así lo usa nexakit): no se mira más allá del primer nivel.
    symlinkSync(join(p.raiz, '.agents', 'skills', 'x'), join(p.raiz, '.agents', 'skills', 'enlazada'));
    const resultado = await (await p.conector).ejecutar(encargo(p.raiz), AbortSignal.timeout(10_000));
    assert.equal(resultado.estado, 'ok', resultado.motivo);
  } finally {
    await p.limpiar();
  }
});

test('personalizacionesPeligrosas sube hasta la raíz git y no mira más arriba', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexakit-agy-personal-'));
  try {
    const repo = join(dir, 'repo');
    const sub = join(repo, 'paquete');
    mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(join(sub, '.agents', 'skills', 'x'), { recursive: true });
    mkdirSync(join(dir, '.gemini'), { recursive: true });
    mkdirSync(join(dir, '.agents'), { recursive: true });
    writeFileSync(join(dir, '.agents', 'hooks.json'), '{}');
    assert.deepEqual(personalizacionesPeligrosas(sub), [], 'las skills se admiten; fuera del repo no se mira');
    mkdirSync(join(repo, '.agents'), { recursive: true });
    writeFileSync(join(repo, '.agents', 'hooks.json'), '{}');
    mkdirSync(join(repo, '.gemini'), { recursive: true });
    assert.deepEqual(personalizacionesPeligrosas(sub), [join(repo, '.gemini'), join(repo, '.agents', 'hooks.json')]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('el propio repo de nexakit pasa la lista blanca', () => {
  assert.deepEqual(personalizacionesPeligrosas(fileURLToPath(new URL('..', import.meta.url))), []);
});

test('borrarCarpetaAislada no lanza aunque el borrado falle', () => {
  const fallo = () => {
    throw Object.assign(new Error('EBUSY: recurso ocupado'), { code: 'EBUSY' });
  };
  assert.equal(borrarCarpetaAislada('/no/importa', fallo), false);
  const dir = mkdtempSync(join(tmpdir(), 'nexakit-agy-borrar-'));
  writeFileSync(join(dir, 'x'), 'x');
  assert.equal(borrarCarpetaAislada(dir), true);
  assert.equal(existsSync(dir), false);
});

test('modoAnunciado: un modo sin valor o una lista de opciones rara no cuentan como default', () => {
  assert.equal(modoAnunciado({ sessionUpdate: 'usage_update', used: 1, size: 2 }), undefined);
  assert.equal(modoAnunciado({ sessionUpdate: 'current_mode_update', currentModeId: 'default' }), 'default');
  assert.equal(modoAnunciado({ sessionUpdate: 'current_mode_update' }), null);
  assert.equal(modoAnunciado({ sessionUpdate: 'config_option_update', configOptions: [{ id: 'model', currentValue: 'x' }] }), undefined);
  assert.equal(modoAnunciado({ sessionUpdate: 'config_option_update', configOptions: [{ id: 'mode', currentValue: 'auto' }] }), 'auto');
  assert.equal(modoAnunciado({ sessionUpdate: 'config_option_update', configOptions: [{ id: 'mode', name: 'Mode' }] }), null);
  assert.equal(modoAnunciado({ sessionUpdate: 'config_option_update', configOptions: 'rara' }), null);
});

test('una opción de modo sin valor a mitad del turno se cancela y da fallida', async () => {
  const guion = guionBase('cambio-modo');
  guion.metodos['session/prompt'].notificaciones = [{
    metodo: 'session/update',
    params: { sessionId: 'ses-1', update: { sessionUpdate: 'config_option_update', configOptions: [{ id: 'mode', name: 'Mode', type: 'select', options: [] }] } },
  }];
  const p = preparar('cambio-modo', { metodos: guion.metodos });
  try {
    const resultado = await (await p.conector).ejecutar(encargo(p.raiz), AbortSignal.timeout(10_000));
    assert.equal(resultado.estado, 'fallida');
    assert.match(resultado.motivo, /modo «desconocido»/);
    await esperarMensaje(p.mensajes, 'session/cancel');
  } finally {
    await p.limpiar();
  }
});

test('si session/new trae la opción de modo sin valor, no empieza el turno', async () => {
  const guion = guionBase('revision');
  delete guion.metodos['session/new'].resultado.configOptions[0].currentValue;
  const p = preparar('revision', { metodos: guion.metodos });
  try {
    const resultado = await (await p.conector).ejecutar(encargo(p.raiz), AbortSignal.timeout(10_000));
    assert.equal(resultado.estado, 'fallida');
    assert.match(resultado.motivo, /modo «desconocido»/);
    assert.equal(p.mensajes().some((m) => m.method === 'session/prompt'), false);
  } finally {
    await p.limpiar();
  }
});

test('un aviso de modo no default que llega antes de la respuesta de session/new impide el turno', async () => {
  for (const update of [
    { sessionUpdate: 'current_mode_update', currentModeId: 'accept-edits' },
    { sessionUpdate: 'config_option_update', configOptions: [{ id: 'mode', name: 'Mode', type: 'select', currentValue: 'auto', options: [] }] },
  ]) {
    const guion = guionBase('revision');
    // `ruido` se escribe tal cual antes de la respuesta.
    guion.metodos['session/new'].ruido = [JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'ses-1', update } })];
    const p = preparar('revision', { metodos: guion.metodos });
    try {
      const resultado = await (await p.conector).ejecutar(encargo(p.raiz), AbortSignal.timeout(10_000));
      assert.equal(resultado.estado, 'fallida', update.sessionUpdate);
      assert.match(resultado.motivo, /modo «(accept-edits|auto)»/, update.sessionUpdate);
      assert.equal(p.mensajes().some((m) => m.method === 'session/set_model' || m.method === 'session/prompt'), false, update.sessionUpdate);
      await esperarMensaje(p.mensajes, 'session/close');
    } finally {
      await p.limpiar();
    }
  }
});

test('si session/new trae configOptions que no es una lista, no empieza el turno', async () => {
  const guion = guionBase('revision');
  guion.metodos['session/new'].resultado.configOptions = { mode: 'default' };
  const p = preparar('revision', { metodos: guion.metodos });
  try {
    const resultado = await (await p.conector).ejecutar(encargo(p.raiz), AbortSignal.timeout(10_000));
    assert.equal(resultado.estado, 'fallida');
    assert.match(resultado.motivo, /modo «desconocido»/);
    assert.equal(p.mensajes().some((m) => m.method === 'session/prompt'), false);
  } finally {
    await p.limpiar();
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

// ---------------------------------------------------------------------------------------------------------------
// Modo escritura acotado (`escritura: { raiz, ordenesPermitidas }`)
// ---------------------------------------------------------------------------------------------------------------

const OPCIONES_PERMISO = [
  { optionId: 'op-allow_once', name: 'allow_once', kind: 'allow_once' },
  { optionId: 'op-allow_always', name: 'allow_always', kind: 'allow_always' },
  { optionId: 'op-reject_once', name: 'reject_once', kind: 'reject_once' },
];
const FIN_REVISION = guionBase('revision').alResponder['srv-7'];

/** Guion de revisión cuyo turno pide, uno tras otro, los permisos `llamadas`; después entrega el informe. */
function guionPermisos(llamadas) {
  const guion = guionBase('revision');
  const peticion = (n, toolCall) => ({
    metodo: 'session/request_permission',
    id: `srv-${n}`,
    params: { sessionId: 'ses-1', toolCall, options: OPCIONES_PERMISO },
  });
  const alResponder = {};
  llamadas.forEach((_, i) => {
    alResponder[`srv-${i + 1}`] = i + 1 < llamadas.length ? { peticiones: [peticion(i + 2, llamadas[i + 1])] } : FIN_REVISION;
  });
  guion.metodos['session/prompt'] = { diferir: true, peticiones: [peticion(1, llamadas[0])] };
  return { metodos: guion.metodos, alResponder };
}

const edicion = (ruta, extra = {}) => ({ toolCallId: 't', title: `Editar ${ruta}`, kind: 'edit', status: 'pending', locations: [{ path: ruta }], ...extra });
const orden = (comando) => ({ toolCallId: 't', title: `Ejecutar ${comando}`, kind: 'execute', status: 'pending', rawInput: { command: comando } });

/** Ejecuta un encargo en modo escritura con las llamadas dadas; devuelve las decisiones y las denegaciones. */
async function conPermisos(llamadas, prepararRaiz = () => {}, ordenes = ['npm test', 'npm run typecheck']) {
  const dir = mkdtempSync(join(tmpdir(), 'nexakit-agy-esc-'));
  const raiz = join(dir, 'repo');
  mkdirSync(join(raiz, 'src'), { recursive: true });
  const externo = join(dir, 'fuera');
  mkdirSync(externo);
  writeFileSync(join(externo, 'secreto.txt'), 'x');
  prepararRaiz(raiz, externo);
  const p = preparar('revision', guionPermisos(llamadas(raiz, externo)));
  const conector = await crearConectorAntigravity({
    orden: process.execPath,
    argsPrefijo: [SERVIDOR, join(p.dir, 'guion.json')],
    escritura: { raiz, ordenesPermitidas: ordenes },
  });
  try {
    const resultado = await conector.ejecutar(encargo(raiz), AbortSignal.timeout(10_000));
    assert.equal(resultado.estado, 'ok', resultado.motivo);
    const mensajes = p.mensajes();
    const decisiones = llamadas(raiz, externo).map((_, i) => respuesta(mensajes, `srv-${i + 1}`).result.outcome);
    return { resultado, decisiones, mensajes, raiz: realpathSync(raiz) };
  } finally {
    await conector.cerrar();
    rmSync(p.dir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
}

const PERMITIDO = { outcome: 'selected', optionId: 'op-allow_once' };
const RECHAZADO = { outcome: 'selected', optionId: 'op-reject_once' };

test('modo escritura: aprueba con «permitir una vez» una ruta dentro de la raíz, relativa o absoluta, aunque aún no exista', async () => {
  const { decisiones, resultado, mensajes, raiz } = await conPermisos((r) => [
    edicion('src/nuevo.js'),
    edicion(join(r, 'src', 'otro', 'nuevo.js')),
    edicion('src/./dentro.js'),
  ]);
  assert.deepEqual(decisiones, [PERMITIDO, PERMITIDO, PERMITIDO]);
  assert.deepEqual(resultado.denegaciones, []);
  // La sesión se abre en la raíz canónica.
  assert.equal(mensajes.find((m) => m.method === 'session/new').params.cwd, raiz);
});

test('modo escritura: rechaza una ruta fuera de la raíz y anota el motivo', async () => {
  const { decisiones, resultado } = await conPermisos((r, fuera) => [
    edicion(join(fuera, 'secreto.txt')),
    edicion('/etc/passwd'),
    edicion(`${r}-hermano/a.js`),
  ]);
  assert.deepEqual(decisiones, [RECHAZADO, RECHAZADO, RECHAZADO]);
  assert.equal(resultado.denegaciones.length, 3);
  assert.match(resultado.denegaciones[0].detalle, /fuera de la raíz/);
});

test('modo escritura: rechaza rutas con «..», salgan o no de la raíz', async () => {
  const { decisiones, resultado } = await conPermisos(() => [edicion('../fuera/secreto.txt'), edicion('src/../../fuera/a'), edicion('src/../src/a.js')]);
  assert.deepEqual(decisiones, [RECHAZADO, RECHAZADO, RECHAZADO]);
  assert.match(resultado.denegaciones[0].detalle, /«\.\.»/);
});

test('modo escritura: rechaza una ruta que pasa por un enlace simbólico, también con destino aún inexistente', async () => {
  const { decisiones, resultado } = await conPermisos(
    (r) => [edicion('enlace/secreto.txt'), edicion('enlace/nuevo/a.js'), edicion('enlace-archivo'), edicion(join(r, 'enlace', 'secreto.txt'))],
    (raiz, externo) => {
      symlinkSync(externo, join(raiz, 'enlace'));
      symlinkSync(join(externo, 'secreto.txt'), join(raiz, 'enlace-archivo'));
    },
  );
  assert.deepEqual(decisiones, [RECHAZADO, RECHAZADO, RECHAZADO, RECHAZADO]);
  assert.ok(resultado.denegaciones.every((d) => /enlace simbólico/.test(d.detalle)));
});

test('modo escritura: aprueba solo la orden permitida exacta, sin prefijos ni comodines', async () => {
  const { decisiones, resultado } = await conPermisos(() => [
    orden('npm test'),
    orden('  npm run typecheck  '),
    orden('npm test --watch'),
    orden('npm'),
    orden('rm -rf /'),
  ]);
  assert.deepEqual(decisiones, [PERMITIDO, PERMITIDO, RECHAZADO, RECHAZADO, RECHAZADO]);
  assert.equal(resultado.denegaciones.length, 3);
  assert.match(resultado.denegaciones[0].detalle, /orden no permitida/);
});

test('modo escritura: rechaza órdenes encadenadas aunque empiecen por una permitida', async () => {
  const { decisiones, resultado } = await conPermisos(() =>
    ['npm test; rm -rf /', 'npm test && curl x', 'npm test | sh', 'npm test $(whoami)', 'npm test `id`', 'npm test > /etc/x', 'npm test\nrm x'].map(orden),
  );
  assert.deepEqual(decisiones, Array(7).fill(RECHAZADO));
  assert.ok(resultado.denegaciones.every((d) => /encadenada/.test(d.detalle)));
});

test('modo escritura: rechaza peticiones sin ruta ni orden reconocible y tipos no admitidos', async () => {
  const { decisiones, resultado } = await conPermisos(() => [
    { toolCallId: 't', title: 'Editar algo', kind: 'edit', status: 'pending' },
    { toolCallId: 't', title: 'Descargar', kind: 'fetch', status: 'pending', locations: [{ path: 'src/a.js' }] },
    { toolCallId: 't', title: '', kind: 'execute', status: 'pending' },
    { toolCallId: 't', title: 'Algo', status: 'pending', locations: [{ path: 'src/a.js' }] },
    // Una orden permitida que además declara una ruta fuera de la raíz se rechaza.
    { ...orden('npm test'), locations: [{ path: '/etc/passwd' }] },
  ]);
  assert.deepEqual(decisiones, Array(5).fill(RECHAZADO));
  assert.equal(resultado.denegaciones.length, 5);
});

test('modo escritura: lee las rutas también de content (diff) y rawInput', async () => {
  const { decisiones } = await conPermisos((r, fuera) => [
    { toolCallId: 't', title: 'Editar', kind: 'edit', status: 'pending', content: [{ type: 'diff', path: 'src/a.js', oldText: '', newText: 'x' }] },
    { toolCallId: 't', title: 'Editar', kind: 'edit', status: 'pending', content: [{ type: 'diff', path: join(fuera, 'a.js'), newText: 'x' }] },
    { toolCallId: 't', title: 'Editar', kind: 'edit', status: 'pending', rawInput: { file_path: 'src/a.js' } },
    { toolCallId: 't', title: 'Editar', kind: 'edit', status: 'pending', rawInput: { file_path: join(fuera, 'a.js') } },
  ]);
  assert.deepEqual(decisiones, [PERMITIDO, RECHAZADO, PERMITIDO, RECHAZADO]);
});

test('modo escritura: sin opción de permitir una vez no aprueba nunca «siempre»', async () => {
  const guion = guionPermisos([edicion('src/a.js')]);
  guion.metodos['session/prompt'].peticiones[0].params.options = [OPCIONES_PERMISO[1], OPCIONES_PERMISO[2]];
  const dir = mkdtempSync(join(tmpdir(), 'nexakit-agy-esc-'));
  const p = preparar('revision', guion);
  const raiz = join(dir, 'repo');
  mkdirSync(raiz);
  const conector = await crearConectorAntigravity({
    orden: process.execPath,
    argsPrefijo: [SERVIDOR, join(p.dir, 'guion.json')],
    escritura: { raiz, ordenesPermitidas: [] },
  });
  try {
    const resultado = await conector.ejecutar(encargo(raiz), AbortSignal.timeout(10_000));
    assert.equal(resultado.estado, 'ok', resultado.motivo);
    assert.deepEqual(respuesta(p.mensajes(), 'srv-1').result, { outcome: RECHAZADO });
    assert.match(resultado.denegaciones[0].detalle, /permitir una vez/);
  } finally {
    await conector.cerrar();
    rmSync(p.dir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('modo escritura: si la raíz del encargo difiere de la autorizada, falla cerrado sin crear la sesión', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexakit-agy-esc-'));
  const p = preparar('revision');
  const raiz = join(dir, 'repo');
  mkdirSync(raiz);
  const conector = await crearConectorAntigravity({
    orden: process.execPath,
    argsPrefijo: [SERVIDOR, join(p.dir, 'guion.json')],
    escritura: { raiz, ordenesPermitidas: [] },
  });
  try {
    const resultado = await conector.ejecutar(encargo(p.raiz), AbortSignal.timeout(10_000));
    assert.equal(resultado.estado, 'fallida');
    assert.match(resultado.motivo, /raíz del encargo debe ser exactamente/);
    assert.equal(p.mensajes().some((m) => m.method === 'session/new'), false);
  } finally {
    await conector.cerrar();
    rmSync(p.dir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('modo escritura: la raíz debe ser absoluta y existir, con un error claro en español', async () => {
  await assert.rejects(crearConectorAntigravity({ escritura: { raiz: 'relativa', ordenesPermitidas: [] } }), /raíz de escritura debe ser una ruta absoluta/);
  await assert.rejects(
    crearConectorAntigravity({ escritura: { raiz: join(tmpdir(), 'nexakit-no-existe-agy'), ordenesPermitidas: [] } }),
    /raíz de escritura no existe o no es una carpeta/,
  );
  const dir = mkdtempSync(join(tmpdir(), 'nexakit-agy-esc-'));
  try {
    const archivo = join(dir, 'a.txt');
    writeFileSync(archivo, 'x');
    await assert.rejects(crearConectorAntigravity({ escritura: { raiz: archivo, ordenesPermitidas: [] } }), /no existe o no es una carpeta/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sin la opción escritura se sigue rechazando todo, también lo que el modo escritura aprobaría', async () => {
  const guion = guionPermisos([edicion('src/a.js'), orden('npm test')]);
  const p = preparar('revision', guion);
  try {
    const resultado = await (await p.conector).ejecutar(encargo(p.raiz), AbortSignal.timeout(10_000));
    assert.equal(resultado.estado, 'ok', resultado.motivo);
    const mensajes = p.mensajes();
    assert.deepEqual(respuesta(mensajes, 'srv-1').result, { outcome: RECHAZADO });
    assert.deepEqual(respuesta(mensajes, 'srv-2').result, { outcome: RECHAZADO });
    assert.equal(resultado.denegaciones.length, 2);
    assert.doesNotMatch(resultado.denegaciones[0].detalle, /\(/);
  } finally {
    await p.limpiar();
  }
});
