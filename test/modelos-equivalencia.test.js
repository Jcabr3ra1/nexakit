import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { agentModels } from '../src/agent-models.js';

// skills/elegir-modelo/modelos.mjs es autocontenida (se enlaza en las IA y corre con `node` sin el resto del repo),
// así que no puede importar src/agent-models.js. Esta prueba evita que las dos clasificaciones de rol diverjan.
// Hydrogen y carbon (familias de Antigravity) solo las conoce la skill; no se comparan aquí.
const SCRIPT = fileURLToPath(new URL('../skills/elegir-modelo/modelos.mjs', import.meta.url));

const MODELOS = [
  { slug: 'gpt-6.1-sol', description: 'Everyday coding workhorse.' },
  { slug: 'gpt-6.1-luna', description: 'Fast and affordable for easier tasks.' },
  { slug: 'gpt-6.1-astra', description: 'Frontier model for the most demanding work.' },
  { slug: 'gpt-6-sol-high', description: '' },
  { slug: 'gpt-6-luna', description: '' },
  { slug: 'gpt-5-argon', description: 'Sin pistas.' },
  { slug: 'gpt-4-terra', description: 'An older model, balanced.' },
  { slug: 'gpt-5.2-previous', description: 'Previous generation.' },
  { slug: 'gemini-3.8-flash-low', description: 'Lightweight.' },
  { slug: 'claude-5-sonnet', description: '' },
  { slug: 'desconocido-x', description: '' },
  { slug: 'otro-modelo-mas', description: 'Balanced pick.' },
];

test('modelos.mjs y agent-models.js clasifican igual el rol de cada modelo', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'modelos-equivalencia-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  await fs.mkdir(path.join(home, '.codex'), { recursive: true });
  await fs.mkdir(path.join(home, '.claude'), { recursive: true });
  const models = MODELOS.map((m) => ({ ...m, visibility: 'list', default_reasoning_level: 'medium', supported_reasoning_levels: [{ effort: 'medium' }] }));
  await fs.writeFile(path.join(home, '.codex', 'models_cache.json'), JSON.stringify({ models }));

  const system = Object.fromEntries(['SystemRoot', 'ComSpec', 'PATHEXT'].filter((n) => process.env[n]).map((n) => [n, process.env[n]]));
  const run = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', env: { ...system, PATH: path.join(root, 'bin'), HOME: home, USERPROFILE: home } });
  assert.equal(run.status, 0, run.stderr);
  const delaSkill = new Map([...run.stdout.matchAll(/^- (\S+) · por defecto .* · papel: (.+)$/gmu)].map((m) => [m[1], m[2]]));

  const delRepo = await agentModels({ codexHome: path.join(home, '.codex'), claudeHome: path.join(home, '.claude') });
  assert.equal(delRepo.codex.models.length, MODELOS.length);
  assert.equal(delaSkill.size, MODELOS.length);
  for (const { model, category } of delRepo.codex.models) assert.equal(delaSkill.get(model), category, model);
});
