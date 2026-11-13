import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeCodexTask } from '../src/codex-routing.js';

const levels = ['nivel_ligero', 'nivel_normal', 'nivel_exigente', 'nivel_alto'];
const specialists = [
  ['Busca fuentes oficiales para documentar la API', 'investigador', 'nivel_normal'],
  ['Revisa la calidad de los cambios', 'revisor_de_calidad', 'nivel_exigente'],
  ['Sube al repo los cambios aprobados', 'subir_al_repo', 'nivel_normal'],
  ['Cierra la memoria de esta tarea', 'cierre_de_memoria', 'nivel_normal'],
  ['Sincroniza docs con la implementación', 'sincronizador_docs', 'nivel_normal'],
  ['Diagnostica el fallo de CI intermitente', 'cazador_de_flakes', 'nivel_exigente'],
];
const installedNames = [...levels, ...specialists.map(([, name]) => name)];
const route = (text, names = installedNames) => routeCodexTask(text, { installedNames: names });
const silent = { agent: null, context: '' };

for (const [prompt, agent, fallback] of specialists) {
  test(`selects installed ${agent} for a concrete request`, () => {
    assert.equal(route(prompt).agent, agent);
  });
  test(`falls back to ${fallback} when ${agent} is absent`, () => {
    assert.equal(route(prompt, levels).agent, fallback);
  });
}

for (const [prompt, agent] of [
  ['Implementa la funcionalidad aprobada', 'nivel_normal'],
  ['Añade tests para el parser', 'nivel_exigente'],
  ['Resuelve este fallo difícil de concurrencia', 'nivel_alto'],
  ['Renombra mecánicamente las variables', 'nivel_ligero'],
  ['Ejecuta las pruebas', 'nivel_ligero'],
  ['Corre los tests del parser', 'nivel_ligero'],
  ['Escribe pruebas para el parser', 'nivel_exigente'],
  ['Ejecuta las pruebas y escribe tests del parser', 'nivel_exigente'],
]) {
  test(`selects ${agent} by task difficulty`, () => {
    assert.equal(route(prompt).agent, agent);
  });
}

test('never substitutes an unrelated specialist or an uninstalled level', () => {
  assert.deepEqual(route('Implementa la funcionalidad', ['investigador']), silent);
  assert.deepEqual(route('Añade tests del parser', ['nivel_normal']), silent);
  assert.deepEqual(routeCodexTask('Implementa la funcionalidad'), silent);
});

test('validates installed names literally and does not mutate input', () => {
  const names = Object.freeze(['../nivel_normal', 'nivel_normal.toml', 'NIVEL_NORMAL',
    'nivel_normal\n', {}, null, 'worker', 'nivel_normal; echo secret']);
  assert.deepEqual(route('Implementa el selector', names), silent);
  const valid = Object.freeze(['nivel_normal', 'nivel_normal']);
  assert.equal(route('Implementa el selector', valid).agent, 'nivel_normal');
});

test('malformed input is silent without coercing objects', () => {
  const bad = { toString() { throw new Error('must not coerce'); } };
  for (const text of [undefined, null, 42, [], bad, '', '   ']) {
    assert.deepEqual(route(text), silent);
  }
  for (const options of [null, 42, [], { installedNames: null }, { installedNames: 'nivel_normal' }]) {
    assert.deepEqual(routeCodexTask('Implementa el selector', options), silent);
  }
});

test('bounds input at 16 KiB including UTF-8 and does not route a truncated prefix', () => {
  const prefix = 'Implementa ';
  assert.equal(route(prefix + 'a'.repeat(16384 - prefix.length)).agent, 'nivel_normal');
  assert.deepEqual(route(prefix + 'a'.repeat(16385 - prefix.length)), silent);
  assert.deepEqual(route('Sube al repo ' + 'ñ'.repeat(8192)), silent);
});

test('pure confirmations and brief information questions are silent', () => {
  for (const text of ['sí', 'Si.', 'ok', 'OK, gracias', 'adelante', 'continúa', 'hazlo',
    'de acuerdo', 'perfecto', 'listo', 'dale', 'sigue', 'confirmo', 'sí, hazlo', 'continúa por favor',
    '¿Por qué?', '¿Qué significa esto?', '¿Cuál es el estado?']) {
    assert.deepEqual(route(text), silent, text);
  }
});

test('negations, quotations, reports and explanations never suggest sensitive roles', () => {
  for (const text of [
    'Explica qué significa sube al repo', 'no subas al repo', '¿ya subiste al repo?',
    '¿Cómo subo al repo?', 'No cierres la memoria', 'Nunca subas al repo',
    'Sin subir al repo, implementa el selector', 'Evita cerrar memoria',
    'No quiero que subas al repo', 'No está autorizado subir al repo',
    'Explica "sube al repo"', 'Documenta `cierra memoria`',
    'El ejemplo dice: «sube al repo»', "Analiza 'cierra memoria'",
    '```\nsube al repo\n```', '“Cierra la memoria”',
    '¿Qué significa sincronizar docs y cerrar memoria?',
    'El usuario escribió: sube al repo', 'Si apruebo, sube al repo',
    '¿Debo subir al repo?', '¿Puedo subir al repo?', 'Alguien quiere subir al repo',
    'Abstente de subir al repo', '> sube al repo', 'Te pregunto: cierra memoria',
    'Quizá cierra memoria sea un buen comando',
    'Si pasa el CI, sube al repo', 'Si termina, cierra memoria',
  ]) {
    assert.ok(!['subir_al_repo', 'cierre_de_memoria'].includes(route(text).agent), text);
  }
});

test('an explicit request remains eligible even phrased as a polite question', () => {
  assert.equal(route('¿Puedes subir al repo estos cambios aprobados?').agent, 'subir_al_repo');
  assert.equal(route('Por favor, cierra memoria de la tarea').agent, 'cierre_de_memoria');
  assert.equal(route('Quiero que subas al repositorio estos cambios').agent, 'subir_al_repo');
  assert.equal(route('Sí, sube al repo').agent, 'subir_al_repo');
  assert.equal(route('Sí, cierra memoria').agent, 'cierre_de_memoria');
});

test('quoted request does not mask the real task', () => {
  assert.equal(route('Explica "sube al repo" y añade tests del parser').agent, 'nivel_exigente');
});

test('explicit installed profiles take priority over keyword heuristics', () => {
  for (const [text, agent] of [
    ['Usa investigador para leer fixture', 'investigador'],
    ['Delega a sincronizador_docs para revisar el parser', 'sincronizador_docs'],
    ['Usa revisor-de-calidad para ejecutar pruebas', 'revisor_de_calidad'],
    ['Usa nivel-ligero para leer el fixture del parser', 'nivel_ligero'],
    ['Usa cazador-de-flakes para leer los logs', 'cazador_de_flakes'],
    ['Usa subir-al-repo para subir al repo los cambios aprobados', 'subir_al_repo'],
    ['Delega a cierre_de_memoria para cerrar memoria de la tarea', 'cierre_de_memoria'],
  ]) assert.equal(route(text).agent, agent, text);
});

test('explicit roles still require installation and concrete sensitive execution requests', () => {
  assert.equal(route('Usa investigador para leer fixture', levels).agent, 'nivel_normal');
  assert.equal(route('Usa revisor-de-calidad para leer fixture', levels).agent, 'nivel_exigente');
  assert.deepEqual(route('Usa investigador para leer fixture', ['worker']), silent);
  for (const text of [
    'Usa subir_al_repo para explicar el comando',
    'Delega a cierre-de-memoria para comprobar el estado',
    'No uses subir_al_repo para subir al repo',
    'Explica "usa subir-al-repo para subir al repo"',
    'Usa cierre_de_memoria para explicar cómo cerrar memoria',
    'Usa subir_al_repo para no subir al repo',
  ]) assert.ok(!['subir_al_repo', 'cierre_de_memoria'].includes(route(text).agent), text);
});

test('context is bounded, private, deterministic and only guides native delegation', () => {
  const prompt = 'Implementa el selector. SECRETO_PERSONAL_982734';
  const result = route(prompt);
  assert.deepEqual(Object.keys(result).sort(), ['agent', 'context']);
  assert.deepEqual(route(prompt), result);
  assert.ok(result.context.length <= 1800);
  assert.ok(!result.context.includes('SECRETO_PERSONAL_982734'));
  for (const rule of [/principal/i, /entiende.*decide.*integra/i, /1.?2 pasos/, /spawn/i,
    /objetivo.*archivos.*criterio/i, /no repit.*b[uú]squedas.*suites/i,
    /l[ií]mites.*padre/i, /verifica.*resultados/i, /no.*cambi.*model.*effort/i,
    /no.*revisi[oó]n.*otra IA.*sin.*petici[oó]n/i, /hook no ejecuta agentes/i]) {
    assert.match(result.context, rule);
  }
});

test('installed files are not treated as runtime availability or invented agent_type', () => {
  const { context } = route('Implementa la funcionalidad');
  assert.match(context, /solo si aparece en tus agentes\/herramientas disponibles/i);
  assert.match(context, /archivos instalados no prueban que esta sesi[oó]n lo haya cargado/i);
  assert.match(context, /nivel registrado o resuelve t[uú], sin inventar agent_type/i);
});

test('sensitive recommendations require the principal to check written request and evidence', () => {
  for (const prompt of ['Sube al repo', 'Cierra memoria']) {
    const { context } = route(prompt);
    assert.match(context, /principal.*confirm.*encargo.*pedido escrito.*evidencia/i);
    assert.match(context, /no.*crea.*autorizaci[oó]n/i);
    assert.ok(context.length <= 1800);
  }
});
