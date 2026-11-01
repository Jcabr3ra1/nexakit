import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createFakeClis } from '../test-support/fake-clis.js';
import { applySetup } from '../src/setup-apply.js';
import { buildConfirmation, suggestedAnswers } from '../src/setup-plan.js';
import { gatherSetupState } from '../src/setup-state.js';

const TOOLKIT_ROOT = fileURLToPath(new URL('../', import.meta.url));
const exists = file => fs.lstat(file).then(() => true, () => false);

async function world(t, fakeOptions) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'setup-apply-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const home = path.join(base, 'home'), repo = path.join(base, 'Punto_Motos'), bin = path.join(base, 'bin');
  await fs.mkdir(home);
  await fs.mkdir(path.join(repo, 'frontend'), { recursive: true });
  await fs.writeFile(path.join(repo, 'frontend', 'README.md'), 'Interfaz en React.\n');
  execFileSync('git', ['init', '-q', repo]);
  const clis = createFakeClis(home, fakeOptions);
  clis.installBin(bin);
  const options = { start: repo, homeDirectory: home, environment: { PATH: bin, HOME: home }, toolkitRoot: TOOLKIT_ROOT, runCommand: clis.runCommand };
  return { base, home, repo, clis, options };
}

test('applies the blocks in the fixed order, reports progress, and a second run has nothing to do', async t => {
  const w = await world(t);
  const state = await gatherSetupState(w.options);
  const answers = suggestedAnswers(state);
  const progress = [];
  const result = await applySetup(w.options, answers, { onProgress: (id, phase) => progress.push(`${id}:${phase}`) });
  assert.equal(result.ok, true, JSON.stringify(result.failed));
  assert.deepEqual(result.done, ['stable-command', 'project-skills', 'global-skills:claude', 'global-skills:codex', 'global-skills:antigravity',
    'memory-init', 'memory-connect:claude', 'memory-connect:codex', 'memory-connect:antigravity', 'answers', 'final-check']);
  assert.deepEqual(progress.slice(0, 2), ['stable-command:start', 'stable-command:done']);
  assert.equal(result.finalCheck.ok, true, result.finalCheck.message);

  const vault = path.join(w.home, 'nexakit-memorias', 'punto-motos');
  assert.equal(await exists(path.join(vault, 'project-memory.json')), true);
  assert.equal(await exists(path.join(w.repo, '.claude/skills/frontend-design/SKILL.md')), true);
  assert.equal(await exists(path.join(w.repo, '.agents/skills/frontend-design/SKILL.md')), true);
  assert.equal(await exists(path.join(w.home, '.gemini/antigravity-cli/skills/punto-motos/SKILL.md')), true, 'the memory skill for Antigravity');
  assert.equal(await exists(path.join(w.home, '.nexakit', process.platform === 'win32' ? 'nexakit.cmd' : 'nexakit')), true);
  const agy = JSON.parse(await fs.readFile(w.clis.files.agyFile, 'utf8')).mcpServers['punto-motos-memory'];
  assert.deepEqual(agy.args, [path.join(TOOLKIT_ROOT, 'bin', 'project-memory-mcp.js'), '--manifest', path.join(vault, 'project-memory.json')]);

  const again = await gatherSetupState(w.options);
  assert.equal(buildConfirmation(again, suggestedAnswers(again)).allReady, true, 'a second run has nothing pending');
});

test('stops at the first failing block, keeps what was applied, and a second run only does what is missing', async t => {
  const w = await world(t, { fail: { 'agy add': true } });
  const answers = suggestedAnswers(await gatherSetupState(w.options));
  const result = await applySetup(w.options, answers);
  assert.equal(result.ok, false);
  assert.equal(result.failed.id, 'memory-connect:antigravity');
  assert.match(result.failed.message, /Antigravity/u);
  assert.match(result.failed.message, /Vuelve a ejecutar `npx nexakit`/u);
  assert.ok(result.done.includes('memory-connect:codex'));
  assert.ok(!result.done.includes('answers'), 'nothing runs after the failure');

  const healed = createFakeClis(w.home);
  const options = { ...w.options, runCommand: healed.runCommand };
  const state = await gatherSetupState(options);
  const confirmation = buildConfirmation(state, answers);
  assert.deepEqual(confirmation.blocks.map(block => block.id), ['memory-connect:antigravity', 'answers', 'final-check']);
  const second = await applySetup(options, answers);
  assert.equal(second.ok, true, JSON.stringify(second.failed));
  assert.equal(healed.calls.filter(call => call[2] === 'add').length, 1, 'only Antigravity is registered again');
});

test('never registers agent-toolkit-workflow nor writes level agents or the Codex sandbox', async t => {
  const w = await world(t);
  await applySetup(w.options, suggestedAnswers(await gatherSetupState(w.options)));
  assert.ok(!w.clis.calls.some(call => call.includes('agent-toolkit-workflow')));
  assert.equal(await exists(path.join(w.home, '.codex', 'agents')), false);
  const codex = await fs.readFile(w.clis.files.codexFile, 'utf8');
  assert.doesNotMatch(codex, /sandbox|nivel_/u);
});

test('an existing memory without Antigravity gets it declared before connecting', async t => {
  const w = await world(t);
  const claudeOnly = { ...suggestedAnswers(await gatherSetupState(w.options)), agents: ['claude'] };
  assert.equal((await applySetup(w.options, claudeOnly)).ok, true);
  const vault = path.join(w.home, 'nexakit-memorias', 'punto-motos');
  const manifest = () => fs.readFile(path.join(vault, 'project-memory.json'), 'utf8').then(JSON.parse);
  assert.deepEqual((await manifest()).agents.map(agent => agent.id), ['claude']);

  const all = { ...claudeOnly, agents: ['claude', 'codex', 'antigravity'] };
  const result = await applySetup(w.options, all);
  assert.equal(result.ok, true, JSON.stringify(result.failed));
  assert.deepEqual((await manifest()).agents.map(agent => agent.id), ['claude', 'codex', 'antigravity']);
});

test('memory "later" and unchecked skills are respected', async t => {
  const w = await world(t);
  const answers = { version: 1, skills: { chosen: [], discarded: ['frontend-design'] }, agents: ['claude'], memory: { decision: 'later' } };
  const result = await applySetup(w.options, answers);
  assert.equal(result.ok, true, JSON.stringify(result.failed));
  assert.ok(!result.done.some(id => id.startsWith('memory-')));
  assert.equal(await exists(path.join(w.repo, '.claude/skills/frontend-design')), false);
  assert.equal(await exists(path.join(w.home, 'nexakit-memorias')), false);
  const saved = JSON.parse(await fs.readFile(path.join(w.repo, '.agent-toolkit/manifest.json'), 'utf8')).answers;
  assert.deepEqual(saved, answers);
});
