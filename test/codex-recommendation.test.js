import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const moduleUrl = new URL('../src/codex-recommendation.js', import.meta.url);
const recommend = async (...args) => (await import(moduleUrl)).recommendCodexTask(...args);

function model(slug, description, defaultEffort = 'medium', efforts = ['low', 'medium', 'high'], priority = 1) {
  return { slug, description, priority, default_reasoning_level: defaultEffort,
    supported_reasoning_levels: efforts.map((effort) => ({ effort })) };
}
const catalog = () => [
  model('codex-9-spark', 'Fast and affordable', 'low'),
  model('codex-9-steady', 'Everyday workhorse', 'xhigh', ['low', 'medium', 'high', 'xhigh']),
  model('codex-9-peak', 'Frontier model', 'high'),
];
async function fixture(t, models = catalog(), config = 'model="codex-9-steady"\nmodel_reasoning_effort="medium"\n') {
  const homeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-recommend-'));
  t.after(() => fs.rm(homeDirectory, { recursive: true, force: true }));
  const codexHome = path.join(homeDirectory, '.codex');
  await fs.mkdir(codexHome);
  await fs.writeFile(path.join(codexHome, 'models_cache.json'), JSON.stringify({ models }));
  await fs.writeFile(path.join(codexHome, 'config.toml'), config);
  return { homeDirectory, environment: {}, runCommand: () => { throw new Error('No external commands'); } };
}

test('exports the async local recommender', async () => {
  const module = await import(moduleUrl).catch(() => ({}));
  assert.equal(typeof module.recommendCodexTask, 'function');
});

test('resolves routine default from the real catalog and labels saved settings', async (t) => {
  const result = await recommend('Implementa el formulario', await fixture(t));
  assert.deepEqual(result.recommendation, { model: 'codex-9-steady', effort: 'xhigh' });
  assert.deepEqual(result.stored, { model: 'codex-9-steady', effort: 'medium' });
  assert.equal(result.action, 'effort');
  assert.equal(result.command, '/model codex-9-steady --reasoning=xhigh');
  assert.equal(result.source, 'local-catalog');
  assert.equal(result.automaticChange, false);
  assert.equal(result.available, true);
  assert.equal(result.silent, false);
  assert.equal(result.delegate, null);
  assert.match(result.message, /^NexaKit recomienda/u);
  assert.match(result.message, /guardado/iu);
  assert.ok(result.message.length <= 500);
  assert.deepEqual(Object.keys(result).sort(), ['available', 'silent', 'recommendation', 'stored', 'action',
    'delegate', 'command', 'reason', 'message', 'source', 'automaticChange'].sort());
});

test('maps task roles without leaking classifier aliases or cache assumptions', async (t) => {
  const options = await fixture(t);
  for (const [text, expectedModel, effort, delegate] of [
    ['¿Qué significa esta función?', 'codex-9-steady', 'low', null],
    ['Corrige el bug de guardado', 'codex-9-steady', 'high', null],
    ['Escribe pruebas para el parser', 'codex-9-steady', 'high', null],
    ['Diseña la arquitectura', 'codex-9-peak', 'high', null],
    ['Ejecuta las pruebas', 'codex-9-spark', 'low', 'nivel_ligero'],
    ['Investiga este fallo intermitente de seguridad', 'codex-9-peak', 'high', 'nivel_alto'],
  ]) {
    const result = await recommend(text, options);
    assert.deepEqual(result.recommendation, { model: expectedModel, effort });
    assert.equal(result.delegate, delegate);
    assert.equal(result.action, delegate ? 'delegate' : expectedModel === 'codex-9-steady' ? 'effort' : 'model');
    assert.doesNotMatch(JSON.stringify(result), /haiku|sonnet|opus|claude|cach[eé]|cuota|contexto/iu);
    if (delegate) assert.match(result.message, /delega/iu);
  }
});

test('silences empty text and pure confirmations, but classifies substantive followups', async (t) => {
  const options = await fixture(t);
  for (const text of ['', '  ', 'sí', 'ok', 'listo', 'sigue', '¡Sí, listo!']) {
    const result = await recommend(text, options);
    assert.equal(result.silent, true);
    assert.equal(result.message, '');
    assert.equal(result.command, null);
    assert.equal(result.recommendation, null);
  }
  assert.equal((await recommend('ok, depura esto', options)).silent, false);
});

test('uses priority and excludes previous generation, hidden and unknown roles', async (t) => {
  const options = await fixture(t, [
    model('old', 'Previous everyday model', 'low', ['low'], -10),
    { ...model('hidden', 'Everyday workhorse', 'low', ['low'], -9), visibility: 'hide' },
    model('mystery', 'Unknown', 'low', ['low'], -8),
    model('codex-10-daily', 'Everyday workhorse', 'high', ['high'], 2),
    model('codex-11-daily', 'Everyday workhorse', 'low', ['low'], 1),
  ]);
  assert.deepEqual((await recommend('Implementa un formulario', options)).recommendation,
    { model: 'codex-11-daily', effort: 'low' });
});

test('falls back only to a supported catalog default with an explicit reason', async (t) => {
  const options = await fixture(t, [model('codex-10-daily', 'Everyday workhorse', 'medium', ['medium'])]);
  const result = await recommend('Corrige el bug', options);
  assert.deepEqual(result.recommendation, { model: 'codex-10-daily', effort: 'medium' });
  assert.match(result.reason, /high.*no.*disponible.*defecto/iu);
});

test('reports missing roles, efforts and malformed caches without inventing recommendations', async (t) => {
  for (const models of [[], [model('unknown', 'Unclassified')],
    [model('old', 'Previous everyday model')],
    [model('daily', 'Everyday workhorse', 'high', ['low'])],
    [model('daily', 'Everyday workhorse', null, [])],
    [model('daily;touch-secret', 'Everyday workhorse')],
    [model('sonnet', 'Everyday workhorse')]]) {
    const result = await recommend('Implementa un formulario', await fixture(t, models));
    assert.equal(result.available, false);
    assert.equal(result.action, 'unavailable');
    assert.equal(result.recommendation, null);
    assert.equal(result.command, null);
    assert.ok(result.message.length > 0 && result.message.length <= 500);
  }
  for (const content of ['not json', '{"models":null}', '{"models":[{"slug":"daily","supported_reasoning_levels":42}]}']) {
    const options = await fixture(t);
    await fs.writeFile(path.join(options.homeDirectory, '.codex/models_cache.json'), content);
    assert.equal((await recommend('Implementa un formulario', options)).available, false);
  }
});

test('invalid config cannot leak values or prevent recommendations; saved choices are literal', async (t) => {
  const options = await fixture(t, catalog(), 'model = [ malformed PRIVATE_CONFIG');
  const result = await recommend('Implementa un formulario', options);
  assert.equal(result.available, true);
  assert.equal(result.stored, null);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_CONFIG/u);
  const literal = await fixture(t, catalog(), 'model="$UNKNOWN"\nmodel_reasoning_effort="${UNKNOWN}"\n');
  assert.equal((await recommend('Implementa un formulario', literal)).stored, null);
});

test('keeps matching saved choices while making no claim about the active session', async (t) => {
  const options = await fixture(t, catalog(), 'model="codex-9-steady"\nmodel_reasoning_effort="xhigh"\n');
  assert.equal((await recommend('Implementa un formulario', options)).action, 'keep');
});

test('does not echo private prompts, execute literal shell strings or write local state', async (t) => {
  const options = await fixture(t);
  const root = path.join(options.homeDirectory, '.codex');
  const before = await Promise.all((await fs.readdir(root)).map(async (name) => [name, await fs.readFile(path.join(root, name), 'utf8')]));
  const result = await recommend('Implementa PRIVATE_PROMPT $(touch secret) ${HOME} `echo hi`', options);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_PROMPT|touch secret|HOME|echo hi/u);
  const after = await Promise.all((await fs.readdir(root)).map(async (name) => [name, await fs.readFile(path.join(root, name), 'utf8')]));
  assert.deepEqual(after, before);
  assert.deepEqual(await fs.readdir(options.homeDirectory), ['.codex']);
});

test('limits text to 16 KiB in bytes without converting arbitrary inputs', async (t) => {
  const options = await fixture(t);
  assert.equal((await recommend('a'.repeat(16384), options)).available, true);
  for (const text of ['a'.repeat(16385), 'á'.repeat(8193), null, {}, 42,
    { toString() { throw new Error('must not convert'); } }]) {
    const result = await recommend(text, options);
    assert.equal(result.available, false);
    assert.equal(result.command, null);
  }
});

test('keeps the saved label and complete command visible even with long valid identifiers', async (t) => {
  const name = 'codex-' + 'x'.repeat(74);
  const options = await fixture(t, [model(name, 'Frontier model', 'medium', ['medium'])],
    `model="${'saved-' + 'y'.repeat(74)}"\nmodel_reasoning_effort="${'z'.repeat(24)}"\n`);
  const result = await recommend('Corrige el fallo intermitente', options);
  assert.equal(result.available, true);
  assert.match(result.message, /Guardado:/u);
  assert.ok(result.message.includes(result.command));
  assert.ok(result.message.length <= 500);
});

test('uses supported medium for design without a default, and explains the fallback', async (t) => {
  const options = await fixture(t, [model('codex-10-peak', 'Frontier model', null, ['medium'])]);
  const result = await recommend('Diseña la arquitectura', options);
  assert.deepEqual(result.recommendation, { model: 'codex-10-peak', effort: 'medium' });
  assert.match(result.reason, /defecto.*no.*disponible.*medium.*soportado/iu);
});

test('does not consult external tools even when explicitly enabled by the caller', async (t) => {
  const options = await fixture(t);
  let calls = 0;
  const result = await recommend('Implementa el formulario', {
    ...options, includeAntigravity: true,
    runCommand: async () => { calls++; return { status: 0, stdout: '' }; },
  });
  assert.equal(result.available, true);
  assert.equal(calls, 0);
});

test('handles an absent cache and invalid effort tokens without emitting executable strings', async (t) => {
  const missing = await fixture(t);
  await fs.unlink(path.join(missing.homeDirectory, '.codex/models_cache.json'));
  assert.equal((await recommend('Implementa el formulario', missing)).available, false);
  const unsafe = await fixture(t, [model('daily', 'Everyday workhorse', 'medium;bad', ['medium;bad'])]);
  const result = await recommend('Implementa el formulario', unsafe);
  assert.equal(result.command, null);
  assert.equal(result.available, false);
});
