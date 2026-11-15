import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir, devNull } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ejecutarCli } from '../dist/fabrica/cli.js';
import { nombreRepo } from '../dist/fabrica/rastro.js';
import { runToolkitCli } from '../src/toolkit-cli.js';

process.env.GIT_CONFIG_GLOBAL = devNull;
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'Prueba';
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'prueba@example.com';

const SERVIDOR = fileURLToPath(new URL('../test-support/fabrica/servidor-falso.mjs', import.meta.url));
const GUIONES = fileURLToPath(new URL('../test-support/fabrica/', import.meta.url));
const leer = (nombre) => JSON.parse(readFileSync(path.join(GUIONES, nombre), 'utf8'));

const temporales = [];
test.after(() => {
  for (const dir of temporales) rmSync(dir, { recursive: true, force: true });
});

function temporal(prefijo) {
  const dir = mkdtempSync(path.join(tmpdir(), prefijo));
  temporales.push(dir);
  return dir;
}

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8' }).trim();
}

/** Repo con `main` y la rama `trabajo` con `src/a.js` sin confirmar; `config` activa Antigravity en arquitectura. */
function crearRepo({ config } = {}) {
  const dir = temporal('fabrica-cli-repo-');
  git(dir, 'init', '-q');
  git(dir, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  writeFileSync(path.join(dir, 'README.txt'), 'base\n');
  if (config !== undefined) {
    mkdirSync(path.join(dir, '.nexakit'));
    writeFileSync(path.join(dir, '.nexakit', 'fabrica.json'), JSON.stringify(config));
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  git(dir, 'checkout', '-q', '-b', 'trabajo');
  mkdirSync(path.join(dir, 'src'));
  writeFileSync(path.join(dir, 'src', 'a.js'), 'export const A = 1;\n');
  return dir;
}

const modeloCodex = (modelo, esfuerzos) => ({
  id: modelo,
  model: modelo,
  hidden: false,
  supportedReasoningEfforts: esfuerzos.map((reasoningEffort) => ({ reasoningEffort, description: '' })),
  defaultReasoningEffort: esfuerzos[0],
});
const catalogoCodex = {
  resultado: { data: [modeloCodex('gpt-6.1-terra', ['medium', 'low']), modeloCodex('gpt-6.1-sol', ['high'])], nextCursor: null },
};

/** Codex falso: catálogo y una revisión de «pruebas» que termina con un hallazgo. */
function guionCodexOk() {
  const revision = leer('codex-revision.json');
  const m = revision.metodos;
  return {
    version: 'codex-cli 0.0.1',
    metodos: {
      initialize: leer('codex-catalogo.json').metodos.initialize,
      'model/list': catalogoCodex,
      'config/read': m['config/read'],
      'mcpServerStatus/list': m['mcpServerStatus/list'],
      'thread/start': m['thread/start'],
      'turn/start': { resultado: m['turn/start'].resultado, notificaciones: revision.alResponder['srv-18'].notificaciones },
    },
  };
}

/** Codex falso que no termina el turno hasta recibir `turn/interrupt`. */
function guionCodexLento() {
  const cancelar = leer('codex-cancelar.json');
  return { ...cancelar, metodos: { ...cancelar.metodos, 'model/list': catalogoCodex } };
}

/** Antigravity falso: catálogo y una revisión de «arquitectura» sin hallazgos. */
function guionAgyOk() {
  const m = leer('acp-catalogo.json').metodos;
  const informe = JSON.stringify({ hallazgos: [], resumen: 'Sin hallazgos.' });
  return {
    metodos: {
      ...m,
      'session/prompt': {
        diferir: true,
        notificaciones: [
          { metodo: 'session/update', params: { sessionId: 'ses-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: informe } } } },
        ],
        responder: [{ metodo: 'session/prompt', resultado: { stopReason: 'end_turn' } }],
      },
    },
  };
}

/** Escenario: HOME temporal, repo y conectores que apuntan a servidores falsos. */
function escenario({ config, codex = guionCodexOk(), agy = guionAgyOk() } = {}) {
  const dir = crearRepo({ config });
  const home = temporal('fabrica-cli-home-');
  const guiones = temporal('fabrica-cli-guiones-');
  const invocacion = (nombre, guion) => {
    const ruta = path.join(guiones, `${nombre}.json`);
    writeFileSync(ruta, JSON.stringify(guion));
    return JSON.stringify([process.execPath, SERVIDOR, ruta]);
  };
  return {
    dir,
    home,
    env: { NEXAKIT_FABRICA_CODEX: invocacion('codex', codex), NEXAKIT_FABRICA_AGY: invocacion('agy', agy) },
  };
}

async function cli(argv, e, extra = {}) {
  let out = '';
  let err = '';
  const codigo = await ejecutarCli(
    argv,
    { out: (t) => { out += t; }, err: (t) => { err += t; } },
    { homeDirectory: e.home, cwd: e.dir, environment: e.env, sondeoMs: 20, ...extra },
  );
  return { codigo, out, err };
}

const CONFIG_AGY = { rutasCriticas: ['src/**'] };
const porNombre = (r, nombre) => r.estaciones.find((x) => x.estacion === nombre);

test('proponer --json devuelve un recorrido válido, con órdenes y huella, y lo guarda con permisos privados', async () => {
  const e = escenario({ config: CONFIG_AGY });
  const { codigo, out, err } = await cli(['proponer', '--base', 'main', '--json'], e);
  assert.equal(codigo, 0, err);
  assert.equal(err, '');
  const r = JSON.parse(out);
  assert.match(r.huella, /^[0-9a-f]{64}$/u);
  assert.equal(r.basePedida, 'main');
  assert.equal(r.estaciones.length, 7);
  assert.deepEqual(
    { ia: porNombre(r, 'pruebas').ia, modelo: porNombre(r, 'pruebas').modelo, ordenes: porNombre(r, 'pruebas').ordenesPermitidas },
    { ia: 'codex', modelo: 'gpt-6.1-terra', ordenes: ['npm test'] },
  );
  assert.equal(porNombre(r, 'arquitectura').ia, 'antigravity');
  assert.deepEqual(porNombre(r, 'arquitectura').ordenesPermitidas, []);
  assert.equal(porNombre(r, 'codigo').ia, 'claude');

  const propuesta = path.join(e.home, '.nexakit', 'fabrica', await nombreRepo(e.dir), 'propuesta.json');
  assert.deepEqual(JSON.parse(readFileSync(propuesta, 'utf8')), r);
  if (process.platform !== 'win32') assert.equal(statSync(propuesta).mode & 0o777, 0o600);
});

test('proponer en texto muestra la tabla con las órdenes permitidas, la nota de Claude y la orden para lanzar', async () => {
  const e = escenario({ config: { estaciones: { pruebas: { ordenesPermitidas: ['npm run lint'] } } } });
  const { codigo, out } = await cli(['proponer', '--base', 'main', '--foco', 'mira los tiempos'], e);
  assert.equal(codigo, 0);
  assert.match(out, /\| Estación \| IA \| Modelo \| Esfuerzo \| Estado \| Motivo \| Notas \|/u);
  assert.match(out, /«npm test», «npm run lint»/u);
  assert.match(out, /\| codigo \| claude \| revisor-de-calidad \|.*la ejecuta la sesión de Claude/u);
  assert.match(out, /Foco: mira los tiempos/u);
  assert.match(out, /Coste estimado: 1 llamadas externas y 1 subagentes de Claude\./u);
  const huella = out.match(/huella ([0-9a-f]{64})/u)[1];
  assert.ok(out.includes(`nexakit fabrica lanzar --huella ${huella}`));
});

test('proponer no aborta si una IA no está instalada: avisa y pasa al siguiente candidato', async () => {
  const e = escenario({ config: CONFIG_AGY });
  e.env.NEXAKIT_FABRICA_AGY = path.join(e.home, 'no-existe', 'agy');
  const { codigo, out, err } = await cli(['proponer', '--base', 'main', '--json'], e);
  assert.equal(codigo, 0, err);
  assert.match(err, /Aviso: antigravity no está disponible/u);
  const r = JSON.parse(out);
  // Arquitectura prefiere Antigravity; sin él, la tabla sigue con Codex.
  assert.equal(porNombre(r, 'arquitectura').ia, 'codex');
});

test('lanzar con la huella correcta termina con 0, muestra el progreso y crea consolidado.md', async () => {
  const e = escenario({ config: CONFIG_AGY });
  const propuesta = JSON.parse((await cli(['proponer', '--base', 'main', '--json'], e)).out);
  const { codigo, out, err } = await cli(['lanzar', '--huella', propuesta.huella], e);
  assert.equal(codigo, 0, err);
  assert.match(out, /«npm test»/u, 'las órdenes se ven antes de lanzar');
  assert.match(out, /\[pruebas\] en-curso/u);
  assert.match(out, /\[pruebas\] ok/u);
  assert.match(out, /\[arquitectura\] ok/u);
  assert.match(out, /\[codigo\] claude: la ejecuta la sesión de Claude/u);
  assert.match(out, /Las estaciones de Claude no se lanzaron aquí/u);
  const ruta = out.match(/^Consolidado: (.+)$/mu)[1];
  assert.ok(existsSync(ruta));
  const consolidado = readFileSync(ruta, 'utf8');
  assert.match(consolidado, /Falta una prueba/u);
  assert.match(consolidado, /Fase: terminado/u);
  // El recorrido del rastro conserva las órdenes aprobadas.
  const guardado = JSON.parse(readFileSync(path.join(path.dirname(ruta), 'recorrido.json'), 'utf8'));
  assert.deepEqual(porNombre(guardado, 'pruebas').ordenesPermitidas, ['npm test']);
});

test('lanzar --json imprime solo JSON, sin progreso', async () => {
  const e = escenario();
  const propuesta = JSON.parse((await cli(['proponer', '--base', 'main', '--json'], e)).out);
  const { codigo, out, err } = await cli(['lanzar', '--huella', propuesta.huella, '--json'], e);
  assert.equal(codigo, 0, err);
  const final = JSON.parse(out);
  assert.equal(final.fase, 'terminado');
  assert.equal(final.estaciones.find((x) => x.estacion === 'pruebas').estado, 'ok');
  assert.ok(existsSync(final.consolidado));
});

test('lanzar con una huella falsa o sin propuesta sale con 1 y el mensaje de la tarea 7', async () => {
  const e = escenario();
  const sinPropuesta = await cli(['lanzar', '--huella', 'f'.repeat(64)], e);
  assert.equal(sinPropuesta.codigo, 1);
  assert.equal(sinPropuesta.err, 'No hay una propuesta con esa huella; vuelve a proponer\n');
  assert.equal(sinPropuesta.out, '');

  await cli(['proponer', '--base', 'main', '--json'], e);
  const falsa = await cli(['lanzar', '--huella', 'f'.repeat(64)], e);
  assert.equal(falsa.codigo, 1);
  assert.equal(falsa.err, 'No hay una propuesta con esa huella; vuelve a proponer\n');
});

test('lanzar rechaza una propuesta alterada a mano o cuyo diff cambió', async () => {
  const e = escenario();
  const propuesta = JSON.parse((await cli(['proponer', '--base', 'main', '--json'], e)).out);
  // El diff cambia después de proponer.
  writeFileSync(path.join(e.dir, 'src', 'b.js'), 'export const B = 2;\n');
  const cambiado = await cli(['lanzar', '--huella', propuesta.huella], e);
  assert.equal(cambiado.codigo, 1);
  assert.match(cambiado.err, /ya no es el que aprobaste/u);

  // Una orden añadida a mano al archivo guardado no coincide con su huella.
  rmSync(path.join(e.dir, 'src', 'b.js'));
  const archivo = path.join(e.home, '.nexakit', 'fabrica', await nombreRepo(e.dir), 'propuesta.json');
  const alterada = JSON.parse(readFileSync(archivo, 'utf8'));
  porNombre(alterada, 'pruebas').ordenesPermitidas.push('rm -rf /');
  writeFileSync(archivo, JSON.stringify(alterada));
  const manipulada = await cli(['lanzar', '--huella', propuesta.huella], e);
  assert.equal(manipulada.codigo, 1);
  assert.equal(manipulada.err, 'No hay una propuesta con esa huella; vuelve a proponer\n');
});

test('lanzar --cambios no deja pasar una propuesta editada a mano, aunque el cambio no haga nada', async () => {
  const e = escenario();
  const propuesta = JSON.parse((await cli(['proponer', '--base', 'main', '--json'], e)).out);
  const archivo = path.join(e.home, '.nexakit', 'fabrica', await nombreRepo(e.dir), 'propuesta.json');
  const alterada = JSON.parse(readFileSync(archivo, 'utf8'));
  porNombre(alterada, 'pruebas').ordenesPermitidas.push('rm -rf /');
  writeFileSync(archivo, JSON.stringify(alterada));
  const cambios = path.join(e.home, 'cambios.json');
  writeFileSync(cambios, JSON.stringify([{ estacion: 'pruebas' }]));
  const { codigo, out, err } = await cli(['lanzar', '--huella', propuesta.huella, '--cambios', cambios], e);
  assert.equal(codigo, 1);
  assert.equal(err, 'No hay una propuesta con esa huella; vuelve a proponer\n');
  assert.equal(out, '');
});

test('lanzar --cambios no da órdenes nuevas al pasar una estación de Antigravity a Codex', async () => {
  const e = escenario({ config: CONFIG_AGY });
  const propuesta = JSON.parse((await cli(['proponer', '--base', 'main', '--json'], e)).out);
  const cambios = path.join(e.home, 'cambios.json');
  // Solo arquitectura corre en Codex: el servidor falso no atiende dos hilos a la vez.
  writeFileSync(cambios, JSON.stringify([
    { estacion: 'arquitectura', ia: 'codex', modelo: 'gpt-6.1-sol', esfuerzo: 'high' },
    { estacion: 'pruebas', quitar: true },
  ]));
  const { codigo, out, err } = await cli(['lanzar', '--huella', propuesta.huella, '--cambios', cambios, '--json'], e);
  assert.equal(codigo, 0, err);
  const final = JSON.parse(out);
  const guardado = JSON.parse(readFileSync(path.join(final.dir, 'recorrido.json'), 'utf8'));
  assert.equal(porNombre(guardado, 'arquitectura').ia, 'codex');
  assert.deepEqual(porNombre(guardado, 'arquitectura').ordenesPermitidas, []);
  assert.equal(porNombre(propuesta, 'pruebas').ordenesPermitidas[0], 'npm test');
});

test('lanzar --cambios aplica los cambios y lanza con la huella de lo aplicado', async () => {
  const e = escenario({ config: CONFIG_AGY });
  const propuesta = JSON.parse((await cli(['proponer', '--base', 'main', '--json'], e)).out);
  const cambios = path.join(e.home, 'cambios.json');
  writeFileSync(cambios, JSON.stringify([{ estacion: 'arquitectura', quitar: true }]));
  const { codigo, out, err } = await cli(['lanzar', '--huella', propuesta.huella, '--cambios', cambios, '--json'], e);
  assert.equal(codigo, 0, err);
  const final = JSON.parse(out);
  assert.equal(final.estaciones.find((x) => x.estacion === 'arquitectura').estado, 'omitida');
  const guardado = JSON.parse(readFileSync(path.join(final.dir, 'recorrido.json'), 'utf8'));
  assert.notEqual(guardado.huella, propuesta.huella);
  assert.equal(porNombre(guardado, 'arquitectura').estado, 'omitida');
  assert.deepEqual(porNombre(guardado, 'arquitectura').ordenesPermitidas, []);

  // Un cambio inválido es un argumento inválido (2); uno que el catálogo no admite, un fallo (1).
  writeFileSync(cambios, JSON.stringify([{ estacion: 'pruebas', modelos: 'x' }]));
  const mal = await cli(['lanzar', '--huella', propuesta.huella, '--cambios', cambios], e);
  assert.equal(mal.codigo, 2);
  assert.match(mal.err, /El archivo de cambios no es válido/u);
  writeFileSync(cambios, JSON.stringify([{ estacion: 'pruebas', modelo: 'no-existe' }]));
  const noAdmitido = await cli(['lanzar', '--huella', propuesta.huella, '--cambios', cambios], e);
  assert.equal(noAdmitido.codigo, 1);
  assert.match(noAdmitido.err, /no está en el catálogo/u);
  const inexistente = await cli(['lanzar', '--huella', propuesta.huella, '--cambios', path.join(e.home, 'nada.json')], e);
  assert.equal(inexistente.codigo, 2);
});

test('una estación que falla deja el código en 1 y consolidado.md lo cuenta', async () => {
  const roto = guionCodexOk();
  roto.metodos['turn/start'] = { resultado: roto.metodos['turn/start'].resultado, notificaciones: [] };
  roto.metodos['thread/start'] = { error: { code: -32000, message: 'sin cuota' } };
  const e = escenario({ codex: roto });
  const propuesta = JSON.parse((await cli(['proponer', '--base', 'main', '--json'], e)).out);
  const { codigo, out } = await cli(['lanzar', '--huella', propuesta.huella], e);
  assert.equal(codigo, 1);
  assert.match(out, /\[pruebas\] fallida/u);
  assert.match(readFileSync(out.match(/^Consolidado: (.+)$/mu)[1], 'utf8'), /pruebas \(fallida\)/u);
});

test('Ctrl+C cancela el recorrido, espera el cierre y sale con 1', async () => {
  const e = escenario({ codex: guionCodexLento() });
  const propuesta = JSON.parse((await cli(['proponer', '--base', 'main', '--json'], e)).out);
  let out = '';
  const antes = process.listenerCount('SIGINT');
  const ejecucion = ejecutarCli(
    ['lanzar', '--huella', propuesta.huella],
    { out: (t) => { out += t; }, err: () => {} },
    { homeDirectory: e.home, cwd: e.dir, environment: e.env, sondeoMs: 20 },
  );
  for (let i = 0; i < 500 && !out.includes('[pruebas] en-curso'); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(out.includes('[pruebas] en-curso'), out);
  assert.ok(process.emit('SIGINT'), 'el manejador de SIGINT debe estar instalado mientras se ejecuta');
  const codigo = await ejecucion;
  assert.equal(codigo, 1);
  assert.match(out, /Cancelando el recorrido/u);
  assert.match(out, /\[pruebas\] cancelada/u);
  assert.match(out, /^Consolidado: /mu);
  assert.equal(process.listenerCount('SIGINT'), antes, 'el manejador de SIGINT se retira al terminar');
});

test('un segundo Ctrl+C termina el proceso con 130 sin esperar al cierre ordenado', async () => {
  const e = escenario({ codex: guionCodexLento() });
  const propuesta = JSON.parse((await cli(['proponer', '--base', 'main', '--json'], e)).out);
  let out = '';
  const salidas = [];
  const ejecucion = ejecutarCli(
    ['lanzar', '--huella', propuesta.huella],
    { out: (t) => { out += t; }, err: () => {} },
    { homeDirectory: e.home, cwd: e.dir, environment: e.env, sondeoMs: 20, salir: (c) => salidas.push(c) },
  );
  for (let i = 0; i < 500 && !out.includes('[pruebas] en-curso'); i++) await new Promise((r) => setTimeout(r, 20));
  process.emit('SIGINT');
  assert.deepEqual(salidas, [], 'el primero solo cancela');
  process.emit('SIGINT');
  assert.deepEqual(salidas, [130]);
  await ejecucion;
});

test('estado, resultado y cancelar consultan un recorrido por su id', async () => {
  const e = escenario();
  const propuesta = JSON.parse((await cli(['proponer', '--base', 'main', '--json'], e)).out);
  const lanzado = JSON.parse((await cli(['lanzar', '--huella', propuesta.huella, '--json'], e)).out);

  const estado = await cli(['estado', '--id', lanzado.id], e);
  assert.equal(estado.codigo, 0);
  assert.match(estado.out, new RegExp(`Recorrido ${lanzado.id}: terminado`, 'u'));
  assert.match(estado.out, /- codigo: claude \(la ejecuta la sesión de Claude\)/u);
  assert.equal(JSON.parse((await cli(['estado', '--id', lanzado.id, '--json'], e)).out).fase, 'terminado');

  const texto = await cli(['resultado', '--id', lanzado.id], e);
  assert.equal(texto.codigo, 0);
  assert.match(texto.out, /# Consolidado del recorrido/u);
  assert.match(texto.out, /Falta una prueba/u);
  const json = JSON.parse((await cli(['resultado', '--id', lanzado.id, '--json'], e)).out);
  assert.equal(json.hallazgos.length, 1);
  assert.deepEqual(json.hallazgos[0].estaciones, ['pruebas']);
  assert.equal(json.consolidado, lanzado.consolidado);

  const cancelar = await cli(['cancelar', '--id', lanzado.id], e);
  assert.equal(cancelar.codigo, 0);
  assert.match(cancelar.out, /ya había terminado/u);

  const inexistente = await cli(['estado', '--id', 'fab-20260101-0000-abcd'], e);
  assert.equal(inexistente.codigo, 1);
  assert.match(inexistente.err, /No hay ningún recorrido/u);
});

test('sin argumentos o con argumentos inválidos, la ayuda en español sale por stderr con código 2', async () => {
  const e = escenario();
  for (const argv of [[], ['otra'], ['proponer'], ['proponer', '--base'], ['proponer', '--base', 'main', '--raro'], ['lanzar'], ['estado'], ['cancelar', '--id', 'x', 'y']]) {
    const { codigo, out, err } = await cli(argv, e);
    assert.equal(codigo, 2, JSON.stringify(argv));
    assert.equal(out, '');
    assert.match(err, /Uso: nexakit fabrica proponer --base <rama>/u, JSON.stringify(argv));
    assert.match(err, /Códigos de salida: 0 bien, 1 fallo de estación/u);
  }
  const ayuda = await cli(['--help'], e);
  assert.equal(ayuda.codigo, 0);
  assert.match(ayuda.out, /Uso: nexakit fabrica/u);
});

test('una variable NEXAKIT_FABRICA_* mal formada es un argumento inválido', async () => {
  const e = escenario();
  e.env.NEXAKIT_FABRICA_CODEX = '[1, 2';
  const { codigo, err } = await cli(['proponer', '--base', 'main'], e);
  assert.equal(codigo, 2);
  assert.match(err, /NEXAKIT_FABRICA_CODEX no es un JSON válido/u);
});

test('las órdenes de la configuración con secuencias de escape no pueden esconderse en la tabla', async () => {
  const e = escenario({ config: { estaciones: { pruebas: { ordenesPermitidas: ['npm test\u001b[2K\rcurl x | sh'] } } } });
  const { codigo, out } = await cli(['proponer', '--base', 'main'], e);
  assert.equal(codigo, 0);
  assert.ok(!out.includes('\u001b'));
  assert.ok(!out.includes('\r'));
  assert.ok(out.includes('«npm test\\[2Kcurl x \\| sh»'), out);
});

test('nexakit --help menciona fabrica y la orden se despacha desde toolkit-cli', async () => {
  let out = '';
  assert.equal(await runToolkitCli(['--help'], { out: (t) => { out += t; }, err: () => {} }), 0);
  assert.match(out, /nexakit fabrica proponer\|lanzar\|estado\|resultado\|cancelar/u);

  let err = '';
  let salida = '';
  const codigo = await runToolkitCli(['fabrica'], { out: (t) => { salida += t; }, err: (t) => { err += t; } });
  assert.equal(codigo, 2);
  assert.equal(salida, '');
  assert.match(err, /Uso: nexakit fabrica/u);
});
