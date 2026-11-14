import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const recUrl = new URL('../src/antigravity-recommendation.js', import.meta.url);
const sessUrl = new URL('../src/antigravity-session.js', import.meta.url);

const parseModel = async (...args) => (await import(recUrl)).parseAntigravityModel(...args);
const recommend = async (...args) => (await import(recUrl)).recommendAntigravityTask(...args);
const writeSession = async (...args) => (await import(sessUrl)).writeAntigravitySessionRecommendation(...args);
const readSession = async (...args) => (await import(sessUrl)).readAntigravitySessionRecommendation(...args);

test('parseAntigravityModel extracts clean name, family, and effort from object and string forms', async () => {
  assert.deepEqual(await parseModel(null), { name: 'modelo ?', family: null, effort: null });
  assert.deepEqual(
    await parseModel({ id: 'Gemini 4 Hydrogen (High)', display_name: 'Gemini 4 Hydrogen (High)', effort: 'high' }),
    { name: 'Gemini 4 Hydrogen', family: 'hydrogen', effort: 'high' },
  );
  assert.deepEqual(
    await parseModel({ id: 'gemini-4-carbon-medium' }),
    { name: 'gemini-4-carbon', family: 'carbon', effort: 'medium' },
  );
  assert.deepEqual(
    await parseModel('Gemini 3.7 Flash (Low)'),
    { name: 'Gemini 3.7 Flash', family: 'flash', effort: 'low' },
  );
  assert.deepEqual(
    await parseModel({ id: 'auto', display_name: 'Auto' }),
    { name: 'Auto', family: null, effort: null },
  );
});

test('recommendAntigravityTask silences empty inputs and pure confirmations', async () => {
  for (const text of ['', '  ', 'sí', 'ok', 'listo', 'dale', '¡Sí, perfecto!']) {
    const res = await recommend(text);
    assert.equal(res.silent, true);
    assert.equal(res.recommendation, null);
    assert.equal(res.message, '');
  }
  assert.equal((await recommend('ok, depura este fallo')).silent, false);
});

test('recommendAntigravityTask maps tasks to Antigravity levels and families without leaking prompts', async () => {
  const catalog = [
    { model: 'gemini-4-flash-low', efforts: ['low'] },
    { model: 'gemini-4-hydrogen-low', efforts: ['low'] },
    { model: 'gemini-4-hydrogen-medium', efforts: ['medium'] },
    { model: 'gemini-4-hydrogen-high', efforts: ['high'] },
    { model: 'gemini-4-carbon-high', efforts: ['high'] },
  ];

  const cases = [
    ['Ejecuta las pruebas unitarias', 'Ligero', 'flash', 'gemini-4-flash-low', 'low', 'nivel-ligero', 'delegate'],
    ['Implementa el formulario de registro', 'Normal', 'hydrogen', 'gemini-4-hydrogen-medium', 'medium', null, 'model'],
    ['Corrige el bug al guardar', 'Exigente', 'hydrogen', 'gemini-4-hydrogen-high', 'high', null, 'model'],
    ['Diseña la arquitectura de colas', 'Alto', 'carbon', 'gemini-4-carbon-high', 'high', null, 'model'],
    ['Investiga un fallo intermitente de seguridad', 'Alto', 'carbon', 'gemini-4-carbon-high', 'high', 'nivel-alto', 'delegate'],
  ];

  for (const [text, level, family, model, effort, delegate, action] of cases) {
    const res = await recommend(text, { catalog });
    assert.equal(res.available, true);
    assert.equal(res.silent, false);
    assert.equal(res.source, 'agy-models');
    assert.equal(res.automaticChange, false);
    assert.equal(res.recommendation.level, level);
    assert.equal(res.recommendation.family, family);
    assert.equal(res.recommendation.model, model);
    assert.equal(res.recommendation.effort, effort);
    assert.equal(res.delegate, delegate);
    assert.equal(res.action, action);
  }

  const secret = await recommend('Depura PRIVATE_TOKEN $(rm -rf /) `whoami`', { catalog });
  assert.doesNotMatch(JSON.stringify(secret), /PRIVATE_TOKEN|rm -rf|whoami/u);
});

test('recommendAntigravityTask compares against currentModel and respects high quota downgrade for design', async () => {
  const same = await recommend('Implementa el formulario', {
    currentModel: { id: 'Gemini 4 Hydrogen (Medium)', display_name: 'Gemini 4 Hydrogen (Medium)', effort: 'medium' },
  });
  assert.equal(same.action, 'keep');
  assert.equal(same.source, 'family-guide');

  const effortOnly = await recommend('Corrige el bug del botón', {
    currentModel: { id: 'Gemini 4 Hydrogen (Medium)', display_name: 'Gemini 4 Hydrogen (Medium)', effort: 'medium' },
  });
  assert.equal(effortOnly.action, 'effort');
  assert.equal(effortOnly.recommendation.effort, 'high');

  const quotaDesign = await recommend('Diseña la arquitectura del servicio', { quotaPercent: 85 });
  assert.equal(quotaDesign.recommendation.family, 'hydrogen');
  assert.equal(quotaDesign.recommendation.effort, 'high');
  assert.match(quotaDesign.reason, /cuota.*85/iu);

  const quotaSecurity = await recommend('Investiga una vulnerabilidad de seguridad sutil', { quotaPercent: 92 });
  assert.equal(quotaSecurity.recommendation.family, 'carbon');
});

test('recommendAntigravityTask rejects invalid or oversized inputs cleanly', async () => {
  for (const bad of [null, 42, {}, 'x'.repeat(16385), 'á'.repeat(8193)]) {
    const res = await recommend(bad);
    assert.equal(res.available, false);
    assert.equal(res.action, 'unavailable');
    assert.equal(res.recommendation, null);
  }
});

test('session recommendation storage isolates safe metadata, validates IDs, rejects symlinks, and respects TTL', async (t) => {
  const homeDirectory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agy-sess-')));
  t.after(() => fs.rm(homeDirectory, { recursive: true, force: true }));

  const now = 1_700_000_000_000;
  const ok = await writeSession('conv-123_abc', {
    level: 'Normal',
    family: 'hydrogen',
    model: 'gemini-4-hydrogen-medium',
    effort: 'medium',
    delegate: null,
    label: 'Hydrogen · medium',
    reason: 'trabajo habitual',
    lastUserInput: 'MUST_NOT_BE_SAVED',
    prompt: 'MUST_NOT_BE_SAVED',
  }, { homeDirectory, now });
  assert.equal(ok, true);

  const storedPath = path.join(homeDirectory, '.nexakit', 'antigravity', 'sessions', 'conv-123_abc.json');
  const raw = await fs.readFile(storedPath, 'utf8');
  assert.doesNotMatch(raw, /MUST_NOT_BE_SAVED|lastUserInput|prompt/u);

  const loaded = await readSession('conv-123_abc', { homeDirectory, now: now + 60_000 });
  assert.equal(loaded.family, 'hydrogen');
  assert.equal(loaded.effort, 'medium');

  const updated = await writeSession('conv-123_abc', {
    level: 'Alto',
    family: 'carbon',
    effort: 'high',
    label: 'Carbon · high',
  }, { homeDirectory, now });
  assert.equal(updated, true);
  assert.equal((await readSession('conv-123_abc', { homeDirectory, now })).family, 'carbon');

  assert.equal(await readSession('conv-123_abc', { homeDirectory, now: now + 7 * 3600 * 1000 }), null);

  for (const badId of ['', '../etc', 'a/b', 'bad id', '.hidden']) {
    assert.equal(await writeSession(badId, { family: 'hydrogen' }, { homeDirectory }), false);
    assert.equal(await readSession(badId, { homeDirectory }), null);
  }

  const symlinkPath = path.join(homeDirectory, '.nexakit', 'antigravity', 'sessions', 'sym-conv.json');
  try {
    await fs.symlink(storedPath, symlinkPath);
    assert.equal(await readSession('sym-conv', { homeDirectory }), null);
    assert.equal(await writeSession('sym-conv', { family: 'flash' }, { homeDirectory }), false);
  } catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') return;
    throw error;
  }
});
