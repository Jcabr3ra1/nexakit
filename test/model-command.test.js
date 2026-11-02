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
