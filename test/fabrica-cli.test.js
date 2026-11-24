import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { gitConfigGlobalVacio } from '../test-support/git-aislado.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ejecutarCli, lineasInforme, tablaRecorrido } from '../dist/fabrica/cli.js';
import { calcularHuella } from '../dist/fabrica/enrutador.js';
import { actualizar, evidenciaVacia, guardar } from '../dist/fabrica/evidencia.js';
import { nombreRepo } from '../dist/fabrica/rastro.js';
import { runToolkitCli } from '../src/toolkit-cli.js';

process.env.GIT_CONFIG_GLOBAL = gitConfigGlobalVacio;
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
  // Los guiones de esta suite representan turnos de estaciones concretas.
  mkdirSync(path.join(home, '.nexakit', 'fabrica'), { recursive: true });
  writeFileSync(path.join(home, '.nexakit', 'fabrica', 'preferencias.json'), '{"revisionCruzada":false}');
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

test('proponer --json incluye la explicación y la calidad de cada estación', async () => {
  const e = escenario({ config: CONFIG_AGY });
  const r = JSON.parse((await cli(['proponer', '--base', 'main', '--json'], e)).out);
  for (const x of r.estaciones) {
    assert.equal(typeof x.explicacion, 'string', x.estacion);
    assert.ok(x.calidad === null || typeof x.calidad === 'number', x.estacion);
  }
  assert.match(porNombre(r, 'pruebas').explicacion, /sin datos medidos/u);
  assert.equal(porNombre(r, 'codigo').explicacion, 'la ejecuta la sesión de Claude');
  assert.ok(Array.isArray(r.avisos));
  assert.ok(r.avisos.some((a) => /^pruebas: sin datos medidos: ejecuta el banco/u.test(a)), r.avisos.join('\n'));
});

test('proponer en texto muestra la explicación de cada estación en una línea aparte y los avisos de evidencia', async () => {
  const e = escenario({ config: CONFIG_AGY });
  const { codigo, out } = await cli(['proponer', '--base', 'main'], e);
  assert.equal(codigo, 0);
  assert.match(out, /^Por qué cada modelo:$/mu);
  assert.match(out, /^ {2}pruebas: gpt-6\.1-terra medium: sin datos medidos, se usa la tabla manual/mu);
  assert.match(out, /^ {2}codigo: la ejecuta la sesión de Claude$/mu);
  assert.doesNotMatch(out, /^ {2}documentacion:/mu, 'las estaciones omitidas no llevan explicación');
  assert.match(out, /^Aviso: pruebas: sin datos medidos: ejecuta el banco/mu);
  // La explicación va fuera de la tabla, que sigue siendo una tabla válida.
  const tabla = out.split('\n').filter((l) => l.startsWith('|'));
  assert.equal(tabla.length, 2 + 7);
});

test('con evidencia en el HOME la CLI explica la elección medida', async () => {
  const e = escenario({ config: CONFIG_AGY });
  const ahora = new Date();
  let ev = evidenciaVacia(ahora);
  ev = actualizar(ev, { ia: 'codex', modelo: 'gpt-6.1-terra', esfuerzo: 'medium', estacion: 'pruebas' }, { aciertos: 100, fallos: 2, tokens: 4000, segundos: 10, fuente: 'banco', ahora });
  await guardar(e.home, ev, ahora);
  const { codigo, out } = await cli(['proponer', '--base', 'main'], e);
  assert.equal(codigo, 0);
  assert.match(out, /^ {2}pruebas: gpt-6\.1-terra medium: calidad ≥ 0,9\d \(102 obs\.\), ~4,0k tokens; criterio barato$/mu);
  assert.doesNotMatch(out, /^Aviso: pruebas:/mu);
});

test('la explicación se recorta a 160 columnas con la sangría incluida', async () => {
  // Los nombres más largos que admite un catálogo: 80 caracteres cada uno.
  const modelo = 'm'.repeat(80);
  const esfuerzo = 'e'.repeat(80);
  const catalogo = { resultado: { data: [modeloCodex(modelo, [esfuerzo]), modeloCodex('gpt-6.1-sol', ['high'])], nextCursor: null } };
  const codex = guionCodexOk();
  codex.metodos['model/list'] = catalogo;
  const e = escenario({ config: CONFIG_AGY, codex });
  const ahora = new Date();
  const ev = actualizar(evidenciaVacia(ahora), { ia: 'codex', modelo, esfuerzo, estacion: 'pruebas' }, { aciertos: 100, fallos: 2, tokens: 4000, segundos: 10, fuente: 'banco', ahora });
  await guardar(e.home, ev, ahora);
  const { out } = await cli(['proponer', '--base', 'main'], e);
  const linea = out.split('\n').find((l) => l.startsWith('  pruebas: '));
  assert.ok(linea, out);
  assert.equal([...linea].length, 160);
  assert.ok(linea.endsWith('…'));
});

test('un nombre con saltos de línea o tabuladores no parte la explicación, un aviso ni una celda', async () => {
  const e = escenario({ config: CONFIG_AGY });
  const r = JSON.parse((await cli(['proponer', '--base', 'main', '--json'], e)).out);
  const pruebas = porNombre(r, 'pruebas');
  pruebas.explicacion = 'gpt\nAviso: falso\t\u2028| seguridad | codex | x |: calidad';
  pruebas.descartes = ['m\n| codigo | codex | falso |\r\n\u2029fin'];
  r.avisos = ['pruebas: sin datos\nAviso: otra línea\ty más'];
  const lineas = tablaRecorrido(r).join('\n').split('\n');
  assert.ok(lineas.includes('  pruebas: gpt Aviso: falso | seguridad | codex | x |: calidad'), lineas.join('\n'));
  assert.ok(lineas.includes('Aviso: pruebas: sin datos Aviso: otra línea y más'), lineas.join('\n'));
  assert.equal(lineas.filter((l) => l.startsWith('Aviso:')).length, 1, 'ningún aviso falso');
  assert.equal(lineas.filter((l) => l.startsWith('|')).length, 2 + 7, 'ninguna fila falsa');
  assert.ok(lineas.some((l) => l.startsWith('| pruebas |') && l.includes('descartes: m \\| codigo')), lineas.join('\n'));
  assert.ok(!/[\t\u2028\u2029\r]/u.test(lineas.join('\n')));
});

test('una propuesta guardada con el formato anterior se rechaza y pide volver a proponer', async () => {
  const e = escenario({ config: CONFIG_AGY });
  const r = JSON.parse((await cli(['proponer', '--base', 'main', '--json'], e)).out);
  // Formato anterior: sin explicacion, calidad ni avisos; su huella era la de entonces.
  const vieja = structuredClone(r);
  for (const x of vieja.estaciones) {
    delete x.explicacion;
    delete x.calidad;
  }
  delete vieja.avisos;
  vieja.huella = calcularHuella(vieja);
  assert.notEqual(vieja.huella, r.huella);
  const propuesta = path.join(e.home, '.nexakit', 'fabrica', await nombreRepo(e.dir), 'propuesta.json');
  writeFileSync(propuesta, JSON.stringify(vieja, null, 2));
  const { codigo, err, out } = await cli(['lanzar', '--huella', vieja.huella], e);
  assert.equal(codigo, 1);
  assert.match(err, /No hay una propuesta con esa huella; vuelve a proponer/u);
  assert.equal(out, '');
});

test('lanzar con revisión cruzada muestra una sola vez el estado de cada ejecución de código', async () => {
  // Con pruebas desactivada, la única estación con IA externa es código y cada IA la revisa una vez.
  const e = escenario({ config: { estaciones: { pruebas: { activa: false } } } });
  rmSync(path.join(e.dir, 'src'), { recursive: true });
  writeFileSync(path.join(e.dir, 'notas.txt'), 'cambio\n');
  writeFileSync(path.join(e.home, '.nexakit', 'fabrica', 'preferencias.json'), '{"revisionCruzada":true}');
  const propuesta = JSON.parse((await cli(['proponer', '--base', 'main', '--json'], e)).out);
  const iasCodigo = propuesta.estaciones.filter((x) => x.estacion === 'codigo').map((x) => x.ia);
  assert.deepEqual(iasCodigo, ['claude', 'codex', 'antigravity']);
  const { codigo, out, err } = await cli(['lanzar', '--huella', propuesta.huella], e);
  assert.equal(codigo, 0, err);
  const lineas = out.split('\n');
  assert.equal(lineas.filter((l) => /^\[codigo\] claude:/u.test(l)).length, 1);
  for (const extra of ['codigo-codex', 'codigo-antigravity']) {
    assert.equal(lineas.filter((l) => l.startsWith(`[${extra}] en-curso`)).length, 1, extra);
    assert.equal(lineas.filter((l) => /^\[codigo-(codex|antigravity)\] (ok|fallida)/u.test(l) && l.startsWith(`[${extra}]`)).length, 1, extra);
  }
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

// ---------------------------------------------------------------------------------------------
// Banco

const rutaPlanBanco = (home) => path.join(home, '.nexakit', 'fabrica', 'banco-plan.json');

test('banco planificar muestra el plan con su coste y la orden exacta, y lo guarda en privado', async () => {
  const e = escenario();
  const { codigo, out, err } = await cli(['banco', 'planificar', '--estacion', 'seguridad'], e);
  assert.equal(codigo, 0, err);
  assert.match(out, /Banco de pruebas, fase 1: \d+ llamadas? a modelos externos/u);
  assert.match(out, /seguridad\/inyeccion-orden: codex gpt-6\.1-terra low/u);
  const ruta = rutaPlanBanco(e.home);
  const plan = JSON.parse(readFileSync(ruta, 'utf8'));
  assert.equal(plan.fase, 1);
  assert.ok(out.includes(`nexakit fabrica banco ejecutar --huella ${plan.huella}`));
  if (process.platform !== 'win32') assert.equal(statSync(ruta).mode & 0o777, 0o600);
});

test('banco planificar --json imprime solo JSON y la fase 2 sin evidencia pide antes la fase 1', async () => {
  const e = escenario();
  const r = await cli(['banco', 'planificar', '--json'], e);
  assert.equal(r.codigo, 0, r.err);
  assert.equal(JSON.parse(r.out).fase, 1);

  const sin = await cli(['banco', 'planificar', '--fase', '2'], e);
  assert.equal(sin.codigo, 1);
  assert.match(sin.err, /fase 2 necesita medidas del banco: planifica y ejecuta antes la fase 1/u);

  assert.equal((await cli(['banco', 'planificar', '--fase', '3'], e)).codigo, 2);
  assert.equal((await cli(['banco', 'planificar', '--estacion', 'inventada'], e)).codigo, 1);
  // Sin subcomando o con --help, `banco` muestra su ayuda en vez de «Orden desconocida».
  const sinOrden = await cli(['banco'], e);
  assert.equal(sinOrden.codigo, 2);
  assert.doesNotMatch(sinOrden.err, /Orden desconocida/u);
  assert.match(sinOrden.err, /nexakit fabrica banco planificar/u);
  for (const bandera of ['--help', '-h']) {
    const ayuda = await cli(['banco', bandera], e);
    assert.equal(ayuda.codigo, 0, bandera);
    assert.equal(ayuda.err, '');
    assert.match(ayuda.out, /nexakit fabrica banco ejecutar --huella/u);
  }
});

test('banco ejecutar: Ctrl+C aborta la ejecución en curso y no deja repos temporales', async () => {
  const e = escenario({ codex: guionCodexLento() });
  const plan = JSON.parse((await cli(['banco', 'planificar', '--estacion', 'seguridad', '--json'], e)).out);
  // Los repos temporales del banco se crean con `os.tmpdir()`: una carpeta propia permite contarlos.
  const tmp = temporal('fabrica-cli-tmp-');
  const previo = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
  Object.assign(process.env, { TMPDIR: tmp, TMP: tmp, TEMP: tmp });
  const antes = process.listenerCount('SIGINT');
  let out = '';
  try {
    const ejecucion = ejecutarCli(
      ['banco', 'ejecutar', '--huella', plan.huella],
      { out: (t) => { out += t; }, err: () => {} },
      { homeDirectory: e.home, cwd: e.dir, environment: e.env, sondeoMs: 20 },
    );
    for (let i = 0; i < 500 && readdirSync(tmp).length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(readdirSync(tmp).length > 0, 'debía haber un repo temporal en curso');
    assert.ok(process.emit('SIGINT'), 'el manejador de SIGINT debe estar instalado mientras se ejecuta');
    const codigo = await ejecucion;
    assert.equal(codigo, 1);
    assert.match(out, /Interrumpido por Ctrl\+C/u);
    assert.deepEqual(readdirSync(tmp), [], 'el repo temporal en curso se borra');
    assert.equal(process.listenerCount('SIGINT'), antes, 'el manejador de SIGINT se retira al terminar');
  } finally {
    for (const [k, v] of Object.entries(previo)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('banco ejecutar sin plan, con otra huella o con el plan alterado falla sin crear conectores', async () => {
  const e = escenario();
  // «[» es un JSON inválido: crear el conector lanzaría un error de entorno distinto (código 2).
  e.env.NEXAKIT_FABRICA_CODEX = '[';
  const falsa = 'a'.repeat(64);
  const sinPlan = await cli(['banco', 'ejecutar', '--huella', falsa], e);
  assert.equal(sinPlan.codigo, 1);
  assert.match(sinPlan.err, /No hay un plan del banco guardado/u);

  const ok = escenario();
  await cli(['banco', 'planificar', '--estacion', 'seguridad'], ok);
  const guardado = JSON.parse(readFileSync(rutaPlanBanco(ok.home), 'utf8'));
  const roto = { ...ok, env: { ...ok.env, NEXAKIT_FABRICA_CODEX: '[' } };
  const otra = await cli(['banco', 'ejecutar', '--huella', falsa], roto);
  assert.equal(otra.codigo, 1);
  assert.match(otra.err, /no es el que aprobaste/u);

  await cli(['banco', 'planificar', '--estacion', 'seguridad'], ok);
  const alterado = JSON.parse(readFileSync(rutaPlanBanco(ok.home), 'utf8'));
  alterado.ejecuciones[0].modelo = 'otro-modelo';
  writeFileSync(rutaPlanBanco(ok.home), JSON.stringify(alterado));
  const r = await cli(['banco', 'ejecutar', '--huella', guardado.huella], roto);
  assert.equal(r.codigo, 1);
  assert.match(r.err, /no es el que aprobaste/u);
  assert.ok(!existsSync(rutaPlanBanco(ok.home)), 'un plan rechazado también se consume');
});

test('una aprobación vale para una sola ejecución: un segundo banco ejecutar falla sin crear conectores', async () => {
  const e = escenario();
  const plan = JSON.parse((await cli(['banco', 'planificar', '--estacion', 'seguridad', '--json'], e)).out);
  const primera = await cli(['banco', 'ejecutar', '--huella', plan.huella], e);
  assert.equal(primera.codigo, 0, primera.err);
  const segunda = await cli(['banco', 'ejecutar', '--huella', plan.huella], { ...e, env: { ...e.env, NEXAKIT_FABRICA_CODEX: '[' } });
  assert.equal(segunda.codigo, 1);
  assert.match(segunda.err, /No hay un plan del banco guardado/u);
});

test('banco ejecutar consume el plan aunque se lance dos veces a la vez: solo una corre', async () => {
  const e = escenario();
  const plan = JSON.parse((await cli(['banco', 'planificar', '--estacion', 'seguridad', '--json'], e)).out);
  const [x, y] = await Promise.all([
    cli(['banco', 'ejecutar', '--huella', plan.huella], e),
    cli(['banco', 'ejecutar', '--huella', plan.huella], e),
  ]);
  assert.deepEqual([x.codigo, y.codigo].sort(), [0, 1]);
});

test('banco ejecutar corre el plan guardado, muestra el progreso y el resumen por estación, y consume el plan', async () => {
  const e = escenario();
  const plan = JSON.parse((await cli(['banco', 'planificar', '--estacion', 'seguridad', '--json'], e)).out);
  const { codigo, out, err } = await cli(['banco', 'ejecutar', '--huella', plan.huella], e);
  assert.equal(codigo, 0, err);
  assert.match(out, new RegExp(`\\[1/${plan.coste.llamadas}\\] seguridad/inyeccion-orden:`, 'u'));
  assert.match(out, /Resumen del banco, fase 1:/u);
  assert.match(out, /seguridad: \d+ aciertos, \d+ fallos, \d+ inválidas, \d+ tokens/u);
  assert.match(out, /La evidencia quedó actualizada con \d+ ejecuci(ón válida|ones válidas)/u);
  assert.ok(!existsSync(rutaPlanBanco(e.home)), 'el plan ejecutado se consume');
  const otra = await cli(['banco', 'ejecutar', '--huella', plan.huella], e);
  assert.equal(otra.codigo, 1);
  assert.match(otra.err, /No hay un plan del banco guardado/u);
});

test('banco ejecutar no dice que la evidencia quedó actualizada si ninguna ejecución fue válida', async () => {
  // Sin «turn/start» ni «session/prompt» en los guiones, todas las estaciones fallan.
  const codex = guionCodexOk();
  delete codex.metodos['turn/start'];
  const agy = guionAgyOk();
  delete agy.metodos['session/prompt'];
  const e = escenario({ codex, agy });
  const plan = JSON.parse((await cli(['banco', 'planificar', '--estacion', 'seguridad', '--json'], e)).out);
  assert.ok(plan.coste.llamadas > 0);
  const { codigo, out } = await cli(['banco', 'ejecutar', '--huella', plan.huella], e);
  assert.equal(codigo, 1);
  assert.match(out, /Ninguna ejecución fue válida: la evidencia no cambió/u);
  assert.doesNotMatch(out, /quedó actualizada/u);
});

test('banco ejecutar --json imprime solo JSON con el resumen', async () => {
  const e = escenario();
  const plan = JSON.parse((await cli(['banco', 'planificar', '--estacion', 'seguridad', '--json'], e)).out);
  const { out } = await cli(['banco', 'ejecutar', '--huella', plan.huella, '--json'], e);
  const resultado = JSON.parse(out);
  assert.equal(resultado.huella, plan.huella);
  assert.equal(resultado.ejecuciones.length, plan.coste.llamadas);
  assert.equal(resultado.resumen[0].estacion, 'seguridad');
});

// ---------------------------------------------------------------------------------------------
// encargar

const TOKENS_ENC = { entrada: 100, salida: 50, total: 150 };
const okEnc = () => ({
  estado: 'ok',
  informe: { hallazgos: [], resumen: 'Hecho: cambié README.txt.' },
  crudo: 'Hecho.',
  modeloInformado: 'x',
  tokens: TOKENS_ENC,
  denegaciones: [],
});

/** Conector falso de encargos: `ejecutar(encargo, señal)` hace de la IA; `registro` guarda lo que recibió. */
function codexFalso(ejecutar) {
  const registro = { creaciones: [], encargos: [] };
  const crear = async (escritura) => {
    registro.creaciones.push(escritura);
    return {
      ia: 'codex',
      catalogo: async () => [{ modelo: 'gpt-6-sol', esfuerzos: ['medium', 'high'] }],
      ejecutar: async (encargo, señal) => {
        registro.encargos.push(encargo);
        return ejecutar(encargo, señal);
      },
      cerrar: async () => {},
    };
  };
  return { crear, registro };
}

const recomendarEnc = async () => ({ modelo: 'gpt-6-sol', esfuerzo: 'medium' });
const datosEnc = (codex) => ({ encargo: { conectores: { codex: codex.crear }, recomendar: recomendarEnc } });

/** Escribe `encargo.md` (y `ordenes.json` si hay) en una carpeta temporal y devuelve sus rutas. */
function archivosEnc({ texto = 'Cambia README.txt.', ordenes } = {}) {
  const dir = temporal('fabrica-cli-enc-');
  const md = path.join(dir, 'encargo.md');
  writeFileSync(md, texto);
  let json;
  if (ordenes !== undefined) {
    json = path.join(dir, 'ordenes.json');
    writeFileSync(json, typeof ordenes === 'string' ? ordenes : JSON.stringify(ordenes));
  }
  return { md, json };
}

const worktreesEnc = (e) => git(e.dir, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length;
const escribirEnWorktree = (encargo, relativa, texto) => {
  mkdirSync(path.dirname(path.join(encargo.raiz, relativa)), { recursive: true });
  writeFileSync(path.join(encargo.raiz, relativa), texto);
};

test('encargar muestra el progreso, la ruta del diff, el resumen y sale con 0; el diff se aplica con git apply', async () => {
  const e = escenario();
  const f = archivosEnc();
  const codex = codexFalso(async (encargo) => {
    writeFileSync(path.join(encargo.raiz, 'README.txt'), 'base\ncambiado\n');
    escribirEnWorktree(encargo, 'nuevo.txt', 'hola\n');
    return okEnc();
  });
  const { codigo, out, err } = await cli(['encargar', '--ia', 'codex', '--encargo', f.md], e, datosEnc(codex));
  assert.equal(codigo, 0, err);
  assert.match(out, /preparando la copia aislada/u);
  // El aviso de inicio da la ruta real, absoluta, de la copia.
  const copia = /la IA trabaja en (.+)$/mu.exec(out)?.[1];
  assert.ok(copia !== undefined && path.isAbsolute(copia), out);
  assert.equal(path.dirname(path.dirname(copia)), path.join(e.home, '.nexakit', 'encargos'));
  assert.equal(path.basename(copia), 'repo');
  assert.match(out, /Encargo [^\n]+: listo \(diff para revisar\)/u);
  assert.match(out, /IA: codex · modelo: gpt-6-sol · esfuerzo: medium/u);
  assert.match(out, /Resumen de la IA:\nHecho: cambié README\.txt\./u);
  const diff = /^Diff: (.+)$/mu.exec(out)?.[1];
  assert.ok(diff !== undefined && existsSync(diff), out);
  assert.ok(out.includes(`Para aplicarlo tras revisarlo (desde la raíz de tu repo): git apply "${diff}"`), out);
  assert.match(out, / - README\.txt\n {2}- nuevo\.txt/u);
  // El encargo no tocó el repo real: el orquestador aplica el diff.
  assert.equal(git(e.dir, 'status', '--porcelain').includes('nuevo.txt'), false);
  git(e.dir, 'stash', '--include-untracked', '-q');
  git(e.dir, 'apply', '--check', diff);
  assert.equal(worktreesEnc(e), 1, 'la copia aislada se borra');
  assert.equal(codex.registro.creaciones[0].ordenesPermitidas.length, 0, 'sin package.json en el repo no hay órdenes por defecto');
});

test('encargar --json imprime solo el informe y sin cambios sale con 0', async () => {
  const e = escenario();
  const f = archivosEnc();
  const codex = codexFalso(async () => okEnc());
  const { codigo, out, err } = await cli(['encargar', '--ia', 'codex', '--encargo', f.md, '--json'], e, datosEnc(codex));
  assert.equal(codigo, 0, err);
  const informe = JSON.parse(out);
  assert.equal(informe.estado, 'sin-cambios');
  assert.equal(informe.ia, 'codex');
  assert.equal(informe.rutaDiff, null);
  assert.ok(existsSync(informe.rutaInforme));
});

test('encargar con un encargo invalido sale con 1 y enseña las rutas vetadas', async () => {
  const e = escenario();
  const f = archivosEnc();
  const codex = codexFalso(async (encargo) => {
    escribirEnWorktree(encargo, '.claude/settings.json', '{}');
    return okEnc();
  });
  const { codigo, out } = await cli(['encargar', '--ia', 'codex', '--encargo', f.md], e, datosEnc(codex));
  assert.equal(codigo, 1);
  assert.match(out, /Encargo [^\n]+: inválido \(sin diff\)/u);
  assert.match(out, /Rutas vetadas \(no se guarda ningún diff\):\n {2}- \.claude\/settings\.json \(cambia «\.claude»\)/u);
  assert.doesNotMatch(out, /^Diff:/mu);
});

test('encargar --help y -h muestran la ayuda con código 0', async () => {
  const e = escenario();
  for (const bandera of ['--help', '-h']) {
    const r = await cli(['encargar', bandera], e);
    assert.equal(r.codigo, 0, bandera);
    assert.equal(r.err, '');
    assert.match(r.out, /nexakit encargar --ia/u);
  }
});

test('un encargo invalido por escrituras fuera de la copia avisa de no editar el repo', () => {
  const base = { id: 'x', estado: 'invalido', ia: null, modelo: null, esfuerzo: null, segundos: 1, tokens: null, ordenesPorDefecto: [], ordenesExtra: [], rutaDiff: null, archivos: [], rutasVetadas: [], escriturasFuera: ['/tmp/a'], denegaciones: [], avisos: [], resumen: '', rutaInforme: '/tmp/i' };
  const aviso = 'No edites el repo mientras corre un encargo: cualquier cambio fuera de la copia lo invalida.';
  assert.ok(lineasInforme(base).includes(aviso));
  assert.ok(!lineasInforme({ ...base, escriturasFuera: [] }).includes(aviso));
});

test('el informe en texto destaca las alertas, da una etiqueta legible al estado y tolera informes sin alertas', () => {
  const base = { id: 'x', estado: 'ok', ia: 'codex', modelo: 'm', esfuerzo: null, segundos: 1, tokens: null, ordenesPorDefecto: [], ordenesExtra: [], rutaDiff: '/tmp/a b/cambios.diff', archivos: ['CLAUDE.md'], rutasVetadas: [], escriturasFuera: [], denegaciones: [], avisos: [], resumen: '', rutaInforme: '/tmp/i' };
  const lineas = lineasInforme({ ...base, alertas: ['CLAUDE.md (requiere revisión explícita: instrucciones o configuración que se cargan solas)'] });
  assert.equal(lineas[0], 'Encargo x: listo (diff para revisar)');
  assert.ok(lineas.includes('Para aplicarlo tras revisarlo (desde la raíz de tu repo): git apply "/tmp/a b/cambios.diff"'));
  const i = lineas.indexOf('ATENCIÓN: revisa a mano estos cambios antes de aplicar el diff:');
  assert.ok(i > 0, lineas.join('\n'));
  assert.match(lineas[i + 1], /^ {2}! CLAUDE\.md \(requiere revisión explícita/u);
  // Un informe antiguo, sin el campo, no rompe la salida.
  assert.ok(!lineasInforme(base).some((l) => l.startsWith('ATENCIÓN')));
  assert.equal(lineasInforme({ ...base, estado: 'sin-cambios', rutaDiff: null })[0], 'Encargo x: sin cambios');
});

test('encargar con una IA que falla sale con 1 y con --ia auto cae a la siguiente', async () => {
  const e = escenario();
  const f = archivosEnc();
  const sinIa = await cli(['encargar', '--ia', 'antigravity', '--encargo', f.md], e, { encargo: { conectores: {}, recomendar: recomendarEnc } });
  assert.equal(sinIa.codigo, 1);
  assert.match(sinIa.out, /: fallido/u);
  assert.match(sinIa.out, /antigravity no está disponible/u);
  const codex = codexFalso(async () => okEnc());
  const auto = await cli(['encargar', '--ia', 'auto', '--encargo', f.md, '--json'], e, datosEnc(codex));
  assert.equal(auto.codigo, 0, auto.err);
  assert.equal(JSON.parse(auto.out).ia, 'codex');
  // Sin --ia, el valor por defecto es auto.
  const sinBandera = await cli(['encargar', '--encargo', f.md, '--json'], e, datosEnc(codex));
  assert.equal(JSON.parse(sinBandera.out).ia, 'codex');
});

test('encargar pasa --modelo, --esfuerzo y --ordenes al encargo; las órdenes se suman a las del repo', async () => {
  const e = escenario();
  writeFileSync(path.join(e.dir, 'package.json'), JSON.stringify({ scripts: { test: 'x', typecheck: 'y' } }));
  git(e.dir, 'add', '-A');
  git(e.dir, 'commit', '-q', '-m', 'paquete');
  const f = archivosEnc({ ordenes: ['npm run lint', 'node --version'] });
  const codex = codexFalso(async () => okEnc());
  const { codigo, err, out } = await cli(
    ['encargar', '--ia', 'codex', '--modelo', 'gpt-6-sol', '--esfuerzo', 'high', '--encargo', f.md, '--ordenes', f.json, '--json'],
    e,
    datosEnc(codex),
  );
  assert.equal(codigo, 0, err);
  const informe = JSON.parse(out);
  assert.equal(informe.modelo, 'gpt-6-sol');
  assert.equal(informe.esfuerzo, 'high');
  assert.deepEqual(codex.registro.encargos[0].ordenesPermitidas, ['npm test', 'npm run typecheck', 'npm run lint', 'node --version']);
  assert.match(codex.registro.encargos[0].instrucciones, /Cambia README\.txt\./u);
});

test('encargar valida los argumentos con un mensaje claro, sale con 2 y no crea ninguna copia', async () => {
  const e = escenario();
  const f = archivosEnc();
  const vacio = archivosEnc({ texto: '  \n' });
  const casos = [
    [['encargar', '--ia', 'claude', '--encargo', f.md], /--ia debe ser codex, antigravity o auto/u],
    [['encargar', '--ia', 'codex'], /Falta --encargo/u],
    [['encargar', '--ia', 'codex', '--encargo', path.join(f.md, 'no-existe')], /No se pudo leer el archivo del encargo/u],
    [['encargar', '--ia', 'codex', '--encargo', vacio.md], /El archivo del encargo está vacío/u],
    ...['0', '121', 'abc', '1.5', '-3', ''].map((t) => [['encargar', '--ia', 'codex', '--encargo', f.md, '--tiempo', t], /--tiempo debe ser un entero de 1 a 120|Argumentos no válidos|Falta/u]),
    [['encargar', '--ia', 'codex', '--encargo', f.md, '--ordenes', path.join(f.md, 'no')], /No se pudo leer el archivo de órdenes/u],
    [['encargar', '--ia', 'codex', '--encargo', f.md, '--rapido'], /Argumentos no válidos/u],
  ];
  for (const ordenes of ['no es json', '{"a":1}', '[1,2]', '[""]', '"npm test"']) {
    const g = archivosEnc({ ordenes });
    casos.push([['encargar', '--ia', 'codex', '--encargo', f.md, '--ordenes', g.json], /El archivo de órdenes no es (un JSON )?válido/u]);
  }
  for (const [argv, patron] of casos) {
    let creado = false;
    const codex = codexFalso(async () => okEnc());
    const datos = datosEnc(codex);
    const { codigo, err } = await cli(argv, e, datos);
    creado = codex.registro.creaciones.length > 0;
    assert.equal(codigo, 2, `${argv.join(' ')} -> ${err}`);
    assert.match(err, patron, argv.join(' '));
    assert.equal(creado, false);
  }
  assert.equal(worktreesEnc(e), 1);
  assert.equal(existsSync(path.join(e.home, '.nexakit', 'encargos')), false, 'nada se creó');
});

test('encargar: Ctrl+C y SIGTERM cancelan, esperan el cierre, borran la copia y retiran los manejadores', async () => {
  for (const señal of ['SIGINT', 'SIGTERM']) {
    const e = escenario();
    const f = archivosEnc();
    let enMarcha;
    const arrancado = new Promise((resolver) => { enMarcha = resolver; });
    const codex = codexFalso(
      (encargo, s) =>
        new Promise((resolver) => {
          enMarcha();
          s.addEventListener('abort', () => resolver({ ...okEnc(), estado: 'cancelada', motivo: 'cancelado' }), { once: true });
        }),
    );
    const antes = { SIGINT: process.listenerCount('SIGINT'), SIGTERM: process.listenerCount('SIGTERM') };
    let out = '';
    const ejecucion = ejecutarCli(
      ['encargar', '--ia', 'codex', '--encargo', f.md, '--json'],
      { out: (t) => { out += t; }, err: () => {} },
      { homeDirectory: e.home, cwd: e.dir, environment: e.env, ...datosEnc(codex) },
    );
    await arrancado;
    assert.equal(process.listenerCount(señal), antes[señal] + 1, 'el manejador está instalado mientras corre');
    assert.ok(process.emit(señal));
    const codigo = await ejecucion;
    assert.equal(codigo, 1);
    assert.equal(JSON.parse(out).estado, 'cancelado');
    assert.equal(process.listenerCount('SIGINT'), antes.SIGINT);
    assert.equal(process.listenerCount('SIGTERM'), antes.SIGTERM);
    assert.equal(worktreesEnc(e), 1, 'la copia se borra');
  }
});

test('encargar: un segundo Ctrl+C termina el proceso con 130', async () => {
  const e = escenario();
  const f = archivosEnc();
  let enMarcha;
  const arrancado = new Promise((resolver) => { enMarcha = resolver; });
  let soltar;
  const codex = codexFalso(
    (encargo, s) =>
      new Promise((resolver) => {
        enMarcha();
        soltar = () => resolver({ ...okEnc(), estado: 'cancelada', motivo: 'cancelado' });
        s.addEventListener('abort', () => {}, { once: true });
      }),
  );
  const codigos = [];
  const ejecucion = ejecutarCli(
    ['encargar', '--ia', 'codex', '--encargo', f.md, '--json'],
    { out: () => {}, err: () => {} },
    { homeDirectory: e.home, cwd: e.dir, environment: e.env, salir: (c) => codigos.push(c), ...datosEnc(codex) },
  );
  await arrancado;
  process.emit('SIGINT');
  process.emit('SIGINT');
  assert.deepEqual(codigos, [130]);
  soltar();
  await ejecucion;
});

test('encargar respeta el candado de un recorrido a la vez: otro proceso vivo en activo.json lo rechaza; uno muerto no', async () => {
  const e = escenario();
  const f = archivosEnc();
  const codex = codexFalso(async () => okEnc());
  const activo = (pid) => ({ pid, id: 'fab-20260101-0000-abcd', repo: 'demo', actualizado: new Date().toISOString(), estaciones: [] });
  mkdirSync(path.join(e.home, '.nexakit', 'fabrica'), { recursive: true, mode: 0o700 });
  const archivo = path.join(e.home, '.nexakit', 'fabrica', 'activo.json');
  writeFileSync(archivo, JSON.stringify(activo(process.ppid)));
  const ocupado = await cli(['encargar', '--ia', 'codex', '--encargo', f.md], e, datosEnc(codex));
  assert.equal(ocupado.codigo, 1);
  assert.match(ocupado.err, /Ya hay un recorrido o encargo en curso/u);
  assert.equal(existsSync(path.join(e.home, '.nexakit', 'encargos', '.candado')), false, 'el candado se libera tras el rechazo');
  assert.equal(codex.registro.creaciones.length, 0);
  assert.equal(worktreesEnc(e), 1);
  // Un proceso que ya no existe no ocupa nada.
  const muerto = Number(execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }));
  writeFileSync(archivo, JSON.stringify(activo(muerto)));
  const libre = await cli(['encargar', '--ia', 'codex', '--encargo', f.md, '--json'], e, datosEnc(codex));
  assert.equal(libre.codigo, 0, libre.err);
});

test('nexakit encargar es una orden de primer nivel y la ayuda la documenta', async () => {
  const e = escenario();
  const f = archivosEnc();
  const codex = codexFalso(async (encargo) => {
    escribirEnWorktree(encargo, 'nuevo.txt', 'hola\n');
    return okEnc();
  });
  let out = '';
  let err = '';
  const codigo = await runToolkitCli(['encargar', '--ia', 'codex', '--encargo', f.md, '--json'], {
    out: (t) => { out += t; },
    err: (t) => { err += t; },
    options: { homeDirectory: e.home, cwd: e.dir, environment: e.env, ...datosEnc(codex) },
  });
  assert.equal(codigo, 0, err);
  assert.equal(JSON.parse(out).estado, 'ok');
  let ayuda = '';
  await runToolkitCli(['--help'], { out: (t) => { ayuda += t; }, err: () => {} });
  assert.match(ayuda, /nexakit encargar --ia codex\|antigravity\|auto --encargo <archivo\.md>/u);
  const ayudaFabrica = await cli(['--help'], e);
  assert.match(ayudaFabrica.out, /nexakit encargar --ia codex\|antigravity\|auto --encargo/u);
  assert.match(ayudaFabrica.out, /Ctrl\+C cancela y borra la copia/u);
});

test('fabrica lanzar y encargar respetan el candado global de encargos: con un encargo vivo no lanzan nada', async () => {
  const e = escenario();
  const f = archivosEnc();
  mkdirSync(path.join(e.home, '.nexakit', 'encargos'), { recursive: true, mode: 0o700 });
  const archivo = path.join(e.home, '.nexakit', 'encargos', '.candado');
  writeFileSync(archivo, JSON.stringify({ pid: process.ppid, id: 'otro-abcdef', fecha: new Date().toISOString() }));
  const propuesta = JSON.parse((await cli(['proponer', '--base', 'main', '--json'], e)).out);
  const lanzar = await cli(['lanzar', '--huella', propuesta.huella], e);
  assert.equal(lanzar.codigo, 1);
  assert.match(lanzar.err, /Ya hay un encargo en curso \(otro-abcdef/u);
  assert.equal(existsSync(path.join(e.home, '.nexakit', 'fabrica', 'activo.json')), false, 'no se lanzó ningún recorrido');
  const codex = codexFalso(async () => okEnc());
  const encargar = await cli(['encargar', '--ia', 'codex', '--encargo', f.md], e, datosEnc(codex));
  assert.equal(encargar.codigo, 1);
  assert.match(encargar.err, /Ya hay un encargo en curso/u);
  assert.equal(codex.registro.creaciones.length, 0);
  assert.equal(JSON.parse(readFileSync(archivo, 'utf8')).id, 'otro-abcdef', 'el candado ajeno sigue');
});

test('encargar muestra las órdenes por defecto y las extra por separado', async () => {
  const e = escenario();
  writeFileSync(path.join(e.dir, 'package.json'), JSON.stringify({ scripts: { test: 'x' } }));
  git(e.dir, 'add', '-A');
  git(e.dir, 'commit', '-q', '-m', 'paquete');
  const f = archivosEnc({ ordenes: ['npm run lint'] });
  const codex = codexFalso(async () => okEnc());
  const { out, err } = await cli(['encargar', '--ia', 'codex', '--encargo', f.md, '--ordenes', f.json], e, datosEnc(codex));
  assert.match(out, /Órdenes por defecto: «npm test»\n/u, err);
  assert.match(out, /Órdenes extra \(en Codex son una guía, su frontera es el sandbox; Antigravity no ejecuta órdenes\): «npm run lint»\n/u);
});
