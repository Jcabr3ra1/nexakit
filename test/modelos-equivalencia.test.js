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
  { slug: 'gemini-4-hydrogen', description: '' },
  { slug: 'gemini-4-carbon', description: '' },
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

const ejecutarSkill = async (t, evidencia) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'modelos-evidencia-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  await fs.mkdir(path.join(home, '.nexakit', 'fabrica'), { recursive: true });
  if (evidencia !== undefined) await fs.writeFile(path.join(home, '.nexakit', 'fabrica', 'evidencia.json'), evidencia);
  const system = Object.fromEntries(['SystemRoot', 'ComSpec', 'PATHEXT'].filter((n) => process.env[n]).map((n) => [n, process.env[n]]));
  const run = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', env: { ...system, PATH: path.join(root, 'bin'), HOME: home, USERPROFILE: home } });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout;
};

const fila = (estacion, modelo, alfa, beta, banco, real) => ({ ia: 'codex', modelo, esfuerzo: 'high', estacion, alfa, beta, tokensMedios: 0, segundosMedios: 0, banco, real });

test('modelos.mjs imprime el mejor par medido por estación cuando hay evidencia', async (t) => {
  const salida = await ejecutarSkill(t, JSON.stringify({
    version: 1,
    actualizada: '2026-11-01T00:00:00.000Z',
    catalogo: { codex: [], antigravity: [], claude: [] },
    filas: [fila('implementar', 'gpt-a', 9, 1, 8, 2), fila('implementar', 'gpt-b', 3, 3, 4, 0), fila('revisar', 'gpt-b', 5, 2, 3, 2)],
  }));
  assert.match(salida, /## Evidencia medida/u);
  assert.match(salida, /- implementar: codex · gpt-a · high · media 0\.90 · 10 observaciones/u);
  assert.match(salida, /- revisar: codex · gpt-b/u);
  assert.doesNotMatch(salida, /gpt-b · high · media 0\.50/u);
  assert.match(salida, /cuantil del 5 %/u);
});

test('modelos.mjs no imprime nada de evidencia si falta o es inválida', async (t) => {
  for (const contenido of [undefined, '{no es json', JSON.stringify({ version: 2, filas: [] }), JSON.stringify({ version: 1, filas: [{ estacion: 'x' }] })]) {
    assert.doesNotMatch(await ejecutarSkill(t, contenido), /Evidencia medida/u);
  }
});

test('modelos.mjs sanea los controles de la evidencia antes de imprimirla', async (t) => {
  const sucio = (x) => `${x}\u001b[31m\u009b2J\nfalso\u2028`;
  const f = { ...fila(sucio('est'), sucio('mod'), 9, 1, 1, 1), ia: sucio('ia'), esfuerzo: sucio('esf') };
  const salida = await ejecutarSkill(t, JSON.stringify({ version: 1, actualizada: '2026-11-01T00:00:00.000Z', catalogo: { codex: [], antigravity: [], claude: [] }, filas: [f] }));
  const seccion = salida.slice(salida.indexOf('## Evidencia medida'));
  assert.match(seccion, /^- est/mu);
  assert.doesNotMatch(seccion, /[\u001b\u009b\u2028\u2029]/u);
  assert.equal(seccion.split('\n').filter((l) => l.startsWith('- ')).length, 1);
});
