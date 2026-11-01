import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const SCRIPT = fileURLToPath(new URL('../skills/elegir-modelo/modelos.mjs', import.meta.url));

async function fixture(t, { claude, codexConfig, codexCache, agy } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'elegir-modelo-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'), bin = path.join(root, 'bin');
  await fs.mkdir(path.join(home, '.claude'), { recursive: true });
  await fs.mkdir(path.join(home, '.codex'), { recursive: true });
  await fs.mkdir(bin);
  if (claude) await fs.writeFile(path.join(home, '.claude/settings.json'), JSON.stringify(claude));
  if (codexConfig) await fs.writeFile(path.join(home, '.codex/config.toml'), codexConfig);
  if (codexCache) await fs.writeFile(path.join(home, '.codex/models_cache.json'), JSON.stringify({ models: codexCache }));
  if (agy) await fs.writeFile(path.join(bin, 'agy'), `#!/bin/sh\nprintf '${agy}'\n`, { mode: 0o755 });
  return (env = {}) => {
    const result = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', env: { PATH: bin, HOME: home, ...env } });
    return { status: result.status, out: result.stdout, err: result.stderr };
  };
}
const model = (slug, def, levels, extra = {}) => ({ slug, description: `Descripción de ${slug}.`, default_reasoning_level: def, supported_reasoning_levels: levels.map(effort => ({ effort })), visibility: 'list', ...extra });

test('lists the real Codex models with their own default effort, and leaves out hidden ones', async t => {
  const run = await fixture(t, {
    codexCache: [model('gpt-6.1-sol', 'low', ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']), model('codex-auto-review', 'medium', ['low'], { visibility: 'hide' })],
    codexConfig: 'model = "gpt-6.1-sol"\nmodel_reasoning_effort = "medium"\n\n[profiles.otro]\nmodel = "gpt-6-luna"\n'
  });
  const { status, out } = run();
  assert.equal(status, 0);
  assert.match(out, /^- gpt-6\.1-sol · por defecto low · low, medium, high, xhigh, max, ultra · Descripción de gpt-6\.1-sol\.$/mu);
  assert.doesNotMatch(out, /codex-auto-review/u);
  assert.match(out, /^Guardado: model=gpt-6\.1-sol · model_reasoning_effort=medium$/mu, 'only the top-level keys, not the profile ones');
});

test('reports what Claude has stored and warns when an environment variable overrides it', async t => {
  const run = await fixture(t, { claude: { model: 'opus', effortLevel: 'high', modelSettings: { sonnet: { effortLevel: 'low' } } } });
  const { out } = run({ CLAUDE_CODE_EFFORT_LEVEL: 'low' });
  assert.match(out, /^Guardado: model=opus · effortLevel=high · modelSettings=\{"sonnet":\{"effortLevel":"low"\}\}$/mu);
  assert.match(out, /^! CLAUDE_CODE_EFFORT_LEVEL=low manda sobre cualquier otro ajuste de esfuerzo\.$/mu);
  assert.match(out, /\/effort status/u);
  assert.doesNotMatch(run().out, /CLAUDE_CODE_EFFORT_LEVEL=/u, 'no warning when it is not set');
});

test('lists the Antigravity ids when agy is installed, and says so when it is not', async t => {
  const withAgy = await fixture(t, { agy: 'Fetching available models...\\ngemini-4-argon-high\\tGemini 4 Argon (High)\\ngemini-3.8-flash-low\\tGemini 3.8 Flash (Low)\\n' });
  const { out } = withAgy();
  assert.match(out, /^- gemini-4-argon-high · Gemini 4 Argon \(High\)$/mu);
  assert.match(out, /^- gemini-3\.8-flash-low · Gemini 3\.8 Flash \(Low\)$/mu);
  assert.doesNotMatch(out, /Fetching/u);
  assert.match(out, /No guarda en archivos el modelo elegido/u);
  assert.match((await fixture(t))().out, /^agy no está instalado\.$/mu);
});

test('missing files are reported, never a crash', async t => {
  const { status, out } = (await fixture(t))();
  assert.equal(status, 0);
  assert.match(out, /^Guardado: model=\(por defecto\) · effortLevel=\(por defecto\)$/mu);
  assert.match(out, /No encontré ~\/\.codex\/models_cache\.json: abre Codex una vez\./u);
});
