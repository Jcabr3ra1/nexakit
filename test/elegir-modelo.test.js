import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const SCRIPT = fileURLToPath(new URL('../skills/elegir-modelo/modelos.mjs', import.meta.url));
const SKILL = fileURLToPath(new URL('../skills/elegir-modelo/SKILL.md', import.meta.url));

async function fixture(t, { claude, codexConfig, codexCache, agy, agyFails } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'elegir-modelo-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'), bin = path.join(root, 'bin');
  await fs.mkdir(path.join(home, '.claude'), { recursive: true });
  await fs.mkdir(path.join(home, '.codex'), { recursive: true });
  await fs.mkdir(bin);
  if (claude) await fs.writeFile(path.join(home, '.claude/settings.json'), JSON.stringify(claude));
  if (codexConfig) await fs.writeFile(path.join(home, '.codex/config.toml'), codexConfig);
  if (codexCache) await fs.writeFile(path.join(home, '.codex/models_cache.json'), JSON.stringify({ models: codexCache }));
  if (agy || agyFails) {
    // A Node script behind a launcher for each platform, like the real npm shims.
    await fs.writeFile(path.join(bin, 'agy.mjs'), agyFails
      ? `process.stderr.write(${JSON.stringify(agyFails)}); process.exit(3);\n`
      : `process.stdout.write(${JSON.stringify(agy)});\n`);
    if (process.platform === 'win32') await fs.writeFile(path.join(bin, 'agy.cmd'), `@"${process.execPath}" "%~dp0agy.mjs" %*\r\n`);
    else await fs.writeFile(path.join(bin, 'agy'), `#!/bin/sh\nexec "${process.execPath}" "${path.join(bin, 'agy.mjs')}" "$@"\n`, { mode: 0o755 });
  }
  const system = Object.fromEntries(['SystemRoot', 'ComSpec', 'PATHEXT'].filter(name => process.env[name]).map(name => [name, process.env[name]]));
  return (env = {}) => {
    const result = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', env: { ...system, PATH: bin, HOME: home, USERPROFILE: home, ...env } });
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
  assert.match(out, /^- gpt-6\.1-sol · por defecto low · low, medium, high, xhigh, max, ultra · Descripción de gpt-6\.1-sol\. · papel: uso diario$/mu);
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
  const withAgy = await fixture(t, { agy: 'Fetching available models...\ngemini-4-argon-high\tGemini 4 Argon (High)\ngemini-3.8-flash-low\tGemini 3.8 Flash (Low)\n' });
  const { out } = withAgy();
  assert.match(out, /^- gemini-4-argon-high · Gemini 4 Argon \(High\) · papel: el más capaz$/mu);
  assert.match(out, /^- gemini-3\.8-flash-low · Gemini 3\.8 Flash \(Low\) · papel: ligero$/mu);
  assert.doesNotMatch(out, /Fetching/u);
  assert.match(out, /No guarda en archivos el modelo elegido/u);
  assert.match((await fixture(t))().out, /^agy no está instalado\.$/mu);
  const failing = (await fixture(t, { agyFails: 'Not signed in.\nRun agy login.\n' }))().out;
  assert.match(failing, /^agy models falló: Not signed in\.$/mu, 'installed but failing is not reported as missing');
  assert.doesNotMatch(failing, /no está instalado/u);
});

test('new models without useful description inherit the role of their family or are marked sin clasificar', async t => {
  const run = await fixture(t, {
    codexCache: [
      model('gpt-9-terra', 'low', ['low', 'medium', 'high'], { description: 'GPT-9 Terra Codex model.' }),
      model('gpt-5.6-terra', 'medium', ['low', 'medium', 'high'], { description: 'Older balanced model for straightforward work.' }),
      model('gpt-9-luna', 'low', ['low', 'medium'], { description: 'GPT-9 Luna model.' }),
      model('gpt-9-cometa', 'low', ['low', 'high'], { description: 'GPT-9 Cometa model.' }),
      model('gpt-8-cometa', 'low', ['low', 'high'], { description: 'Previous generation frontier intelligence for the most demanding work.' }),
      model('gpt-9-quasar', 'low', ['low', 'medium'], { description: 'GPT-9 Quasar model.' })
    ],
    agy: 'gemini-5-argon-high\tGemini 5 Argon (High)\ngpt-oss-120b-medium\tGPT-OSS 120B (Medium)\n'
  });
  const { status, out } = run();
  assert.equal(status, 0);
  assert.match(out, /^- gpt-9-terra · .* · papel: uso diario$/mu);
  assert.match(out, /^- gpt-5\.6-terra · .* · papel: anterior$/mu);
  assert.match(out, /^- gpt-9-luna · .* · papel: ligero$/mu);
  assert.match(out, /^- gpt-9-cometa · .* · papel: el más capaz$/mu);
  assert.match(out, /^- gpt-9-quasar · .* · papel: sin clasificar$/mu);
  assert.match(out, /^- gemini-5-argon-high · Gemini 5 Argon \(High\) · papel: el más capaz$/mu);
  assert.match(out, /^- gpt-oss-120b-medium · GPT-OSS 120B \(Medium\) · papel: sin clasificar$/mu);
});

test('SKILL.md defines the three roles, family fallback, sin clasificar rule, and limit warning rule without depending on concrete model names', async () => {
  const text = await fs.readFile(SKILL, 'utf8');
  assert.match(text, /\bligero\b[^\n]*solo comandos y cambios mecánicos/iu);
  assert.match(text, /\buso diario\b[^\n]*implementar/iu);
  assert.match(text, /\bel más capaz\b[^\n]*diseño, bugs sutiles y ambigüedad/iu);
  assert.match(text, /familia/iu);
  assert.match(text, /sin clasificar[^\n]*pregunta al usuario/iu);
  assert.match(text, /aviso de límite o de cuota nunca baja el modelo sin decírselo al usuario/iu);
  assert.match(text, /a 2026-11:/u);
  assert.doesNotMatch(text, /\bJuan\b/u);
});

test('missing files are reported, never a crash', async t => {
  const { status, out } = (await fixture(t))();
  assert.equal(status, 0);
  assert.match(out, /^Guardado: model=\(por defecto\) · effortLevel=\(por defecto\)$/mu);
  assert.match(out, /No encontré ~[\\/]\.codex[\\/]models_cache\.json: abre Codex una vez\./u);
});
