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
