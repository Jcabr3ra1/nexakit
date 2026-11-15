import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { inspectModels, validateReviewChoice, runModelCommand } from '../src/model-command.js';
test('catalog uses real efforts, profile values and Antigravity ids without guessing', async (t) => {
  const homeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'models-'));
  t.after(() => fs.rm(homeDirectory, { recursive: true, force: true }));
  await fs.mkdir(path.join(homeDirectory, '.codex'));
  await fs.writeFile(
    path.join(homeDirectory, '.codex', 'models_cache.json'),
    JSON.stringify({
      models: [
        { slug: 'current', default_reasoning_level: 'low', supported_reasoning_levels: [{ effort: 'low' }] },
      ],
    }),
  );
  await fs.writeFile(
    path.join(homeDirectory, '.codex', 'config.toml'),
    'model="base"\nprofile="work"\n[profiles.work]\nmodel="current"\nmodel_reasoning_effort="low"\n',
  );
  const options = {
    homeDirectory,
    environment: {},
    runCommand: async () => ({ status: 0, stdout: 'gemini-flash-low\tFlash\n' }),
  };
  const result = await inspectModels(options);
  assert.equal(result.stored.codex.model, 'current');
  assert.equal(result.catalogs.codex[0].defaultEffort, 'low');
  assert.equal(result.catalogs.antigravity[0].model, 'gemini-flash-low');
  assert.equal(result.stored.antigravity, null);
  await validateReviewChoice({ ...options, client: 'codex', model: 'current', effort: 'low' });
  await assert.rejects(
    validateReviewChoice({ ...options, client: 'codex', model: 'current', effort: 'high' }),
  );
  let output = '';
  assert.equal(
    await runModelCommand(
      [],
      {
        out: (s) => {
          output += s;
        },
        err: () => {},
      },
      options,
    ),
    0,
  );
  assert.match(output, /guardado.*sesión/is);
});

test('Antigravity recommends a model and effort actually offered for the requested level', async () => {
  const models = [
    'gemini-4-argon-high\tGemini 4 Argon (High)',
    'gemini-4-carbon-medium\tGemini 4 Carbon (Medium)',
    'gemini-4-hydrogen-xhigh\tGemini 4 Hydrogen (XHigh)',
    'gemini-4-hydrogen-high\tGemini 4 Hydrogen (High)',
    'gemini-4-hydrogen-medium\tGemini 4 Hydrogen (Medium)',
    'gemini-4-hydrogen-low\tGemini 4 Hydrogen (Low)',
    'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)',
  ];
  const recommend = async (level, catalog = models) => {
    let output = '';
    const code = await runModelCommand(['--ia', 'antigravity', '--nivel', level], {
      out: (line) => { output += line; }, err: () => {},
    }, { environment: {}, runCommand: async () => ({ status: 0, stdout: catalog.join('\n') }) });
    assert.equal(code, 0);
    return output;
  };
  assert.match(await recommend('ligero'), /recomendado gemini-3\.8-flash-low · low/u);
  assert.match(await recommend('normal'), /recomendado gemini-4-hydrogen-medium · medium/u);
  assert.match(await recommend('exigente'), /recomendado gemini-4-hydrogen-high · high/u);
  assert.match(await recommend('alto'), /recomendado gemini-4-argon-high · high/u);
  const withCarbon = await recommend('alto', [...models, 'gemini-4-carbon-high\tGemini 4 Carbon (High)']);
  assert.match(withCarbon, /recomendado gemini-4-carbon-high · high/u);
  assert.match(withCarbon, /^  gemini-4-argon-high · high$/mu);
  assert.match(withCarbon, /^  gemini-4-hydrogen-xhigh · xhigh$/mu);
  assert.match(await recommend('alto', []), /sin recomendación disponible/u);
});

test('models are listed without depending on the retired revision process', async () => {
  const source = await fs.readFile(new URL('../src/model-command.js', import.meta.url), 'utf8');
  assert.match(source, /from '\.\/antigravity-models\.js'/u);
  assert.doesNotMatch(source, /revision|peer-review|task-prepare/u);
  const models = await fs.readFile(new URL('../src/antigravity-models.js', import.meta.url), 'utf8');
  assert.doesNotMatch(models, /revision|peer-review|task-prepare/u);
});

test('antigravity-models parses `agy models` and reports failures in Spanish', async () => {
  const { listAntigravityModels, parseAntigravityModels } = await import('../src/antigravity-models.js');
  assert.deepEqual(parseAntigravityModels('gemini-3.8-flash-low\tFlash (Low)\nsin-esfuerzo\tX\n\nmalformada'),
    [{ model: 'gemini-3.8-flash-low', description: 'Flash (Low)', efforts: ['low'], defaultEffort: 'low' }]);
  const ok = await listAntigravityModels({ runCommand: async (name, args) => { assert.deepEqual([name, args], ['agy', ['models']]); return { status: 0, stdout: 'gemini-4-argon-high\tArgon (High)\n' }; } });
  assert.deepEqual([ok.models.length, ok.error], [1, null]);
  for (const result of [{ status: 1, stdout: '' }, { status: 0, stdout: '', timedOut: true }]) {
    const failed = await listAntigravityModels({ runCommand: async () => result });
    assert.deepEqual([failed.models, failed.error], [[], 'No se pudo consultar agy models.']);
  }
  const thrown = await listAntigravityModels({ runCommand: async () => { throw new Error('agy no está disponible'); } });
  assert.equal(thrown.error, 'agy no está disponible');
});

test('antigravity-models runs a real agy found on PATH once, with no shell', { skip: process.platform === 'win32' }, async () => {
  const { listAntigravityModels } = await import('../src/antigravity-models.js');
  const bin = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-models-'));
  try {
    await fs.writeFile(path.join(bin, 'agy'), '#!/bin/sh\nif [ "$1" = "models" ]; then printf "gemini-4-argon-high\\tArgon (High)\\n"; else exit 3; fi\n', { mode: 0o755 });
    const found = await listAntigravityModels({ environment: { PATH: bin } });
    assert.equal(found.error, null);
    assert.deepEqual(found.models.map((m) => m.model), ['gemini-4-argon-high']);
    await fs.writeFile(path.join(bin, 'agy'), '#!/bin/sh\nexit 4\n', { mode: 0o755 });
    assert.equal((await listAntigravityModels({ environment: { PATH: bin } })).error, 'No se pudo consultar agy models.');
    assert.ok((await listAntigravityModels({ environment: { PATH: path.join(bin, 'nada') } })).error);
  } finally { await fs.rm(bin, { recursive: true, force: true }); }
});

test('antigravity-models corta un agy que no responde y no deja pasar una salida enorme', { skip: process.platform === 'win32' }, async () => {
  const { listAntigravityModels } = await import('../src/antigravity-models.js');
  const bin = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-tope-'));
  try {
    await fs.writeFile(path.join(bin, 'agy'), '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
    const inicio = Date.now();
    const colgado = await listAntigravityModels({ environment: { PATH: `${bin}:/bin:/usr/bin` }, timeoutMs: 300 });
    assert.deepEqual([colgado.models, colgado.error], [[], 'No se pudo consultar agy models.']);
    assert.ok(Date.now() - inicio < 10000, 'el tope de tiempo mata al proceso');
    await fs.writeFile(path.join(bin, 'agy'), '#!/bin/sh\nhead -c 5000000 /dev/zero | tr "\\0" "x"\n', { mode: 0o755 });
    const enorme = await listAntigravityModels({ environment: { PATH: `${bin}:/bin:/usr/bin` } });
    assert.deepEqual([enorme.models, enorme.error], [[], 'La salida de agy models supera el límite.']);
  } finally { await fs.rm(bin, { recursive: true, force: true }); }
});
