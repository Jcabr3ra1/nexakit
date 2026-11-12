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
  assert.deepEqual(result.done, ['answers', 'stable-command', 'project-skills', 'global-skills:claude', 'global-skills:codex', 'global-skills:antigravity',
    'superpowers:claude', 'superpowers:codex', 'superpowers:antigravity', 'mod:niveles', 'mod:nexakit-modelo', 'mod:nexakit-ahorro', 'mod:nexakit-lecciones', 'mod:nexakit-sesion',
    'memory-init', 'memory-connect:claude', 'memory-connect:codex', 'memory-connect:antigravity', 'memory-allow-dir', 'review-instructions', 'final-check']);
  assert.deepEqual(progress.slice(0, 2), ['answers:start', 'answers:done']);
  assert.equal(result.finalCheck.ok, true, result.finalCheck.message);
  assert.deepEqual(w.clis.plugins, { claude: 'activo', codex: 'activo', agy: 'activo' }, 'Superpowers installed in every agent');
  assert.ok(Object.values(w.clis.mods).every(state => state === 'activo'), 'every mod installed in Claude Code');

  const vault = path.join(w.home, 'nexakit-memorias', 'punto-motos');
  assert.equal(await exists(path.join(vault, 'project-memory.json')), true);
  const local = JSON.parse(await fs.readFile(path.join(w.repo, '.claude/settings.local.json'), 'utf8'));
  assert.deepEqual(local.permissions.additionalDirectories, [vault], 'la memoria queda como carpeta permitida de Claude Code');
  assert.equal(await exists(path.join(w.repo, '.claude/skills/frontend-design/SKILL.md')), true);
  assert.equal(await exists(path.join(w.repo, '.agents/skills/frontend-design/SKILL.md')), true);
  assert.equal(await exists(path.join(w.home, '.gemini/antigravity-cli/skills/punto-motos/SKILL.md')), true, 'the memory skill for Antigravity');
  assert.equal(await exists(path.join(w.home, '.nexakit', process.platform === 'win32' ? 'nexakit.cmd' : 'nexakit')), true);
  const agy = JSON.parse(await fs.readFile(w.clis.files.agyFile, 'utf8')).mcpServers['punto-motos-memory'];
  assert.deepEqual(agy.args, [path.join(TOOLKIT_ROOT, 'bin', 'project-memory-mcp.js'), '--manifest', path.join(vault, 'project-memory.json')]);

  const again = await gatherSetupState(w.options);
  assert.equal(buildConfirmation(again, suggestedAnswers(again)).allReady, true, 'a second run has nothing pending');
});

test('stops at the first failing block, keeps what was applied and the answers, and a retry recomputes them like the CLI', async t => {
  const w = await world(t);
  const first = { ...suggestedAnswers(await gatherSetupState(w.options)), agents: ['claude', 'codex'] };
  assert.equal((await applySetup(w.options, first)).ok, true);
  assert.equal(await exists(path.join(w.repo, '.claude/skills/frontend-design')), true);

  // Now the person unchecks frontend-design and adds Antigravity, whose registration fails.
  const failing = createFakeClis(w.home, { fail: { 'agy add': true } });
  const failingOptions = { ...w.options, runCommand: failing.runCommand };
  const changed = { ...first, agents: ['claude', 'codex', 'antigravity'],
    skills: { chosen: first.skills.chosen.filter(name => name !== 'frontend-design'), discarded: ['frontend-design'] } };
  const result = await applySetup(failingOptions, changed);
  assert.equal(result.ok, false);
  assert.equal(result.failed.id, 'memory-connect:antigravity');
  assert.match(result.failed.message, /Antigravity/u);
  assert.match(result.failed.message, /Vuelve a ejecutar `npx nexakit`/u);
  assert.ok(result.done.includes('answers'), 'the answers were saved before the block that failed');
  assert.ok(!result.done.includes('final-check'), 'nothing runs after the failure');
  assert.equal(await exists(path.join(w.repo, '.claude/skills/frontend-design')), false);

  // The retry, as `npx nexakit --si` does it: answers recomputed from the saved ones.
  const healed = createFakeClis(w.home);
  const options = { ...w.options, runCommand: healed.runCommand };
  const state = await gatherSetupState(options);
  const retry = suggestedAnswers(state);
  assert.deepEqual(retry.skills.discarded, ['frontend-design']);
  assert.deepEqual(buildConfirmation(state, retry).blocks.map(block => block.id), ['memory-connect:antigravity', 'review-instructions', 'final-check']);
  const second = await applySetup(options, retry);
  assert.equal(second.ok, true, JSON.stringify(second.failed ?? second.finalCheck));
  assert.equal(await exists(path.join(w.repo, '.claude/skills/frontend-design')), false, 'the unchecked skill is not reinstalled');
  assert.equal(healed.calls.filter(call => call[2] === 'add').length, 1, 'only Antigravity is registered');
});

test('a failed Superpowers install is reported but does not stop the memory, the rules or the other agents', async t => {
  const w = await world(t, { fail: { 'claude plugin install': true } });
  const answers = suggestedAnswers(await gatherSetupState(w.options));
  const progress = [];
  const result = await applySetup(w.options, answers, { onProgress: (id, phase, message) => progress.push([id, phase, message]) });
  assert.equal(result.ok, false, 'the person must not read «Listo»');
  assert.equal(result.failed, undefined, 'it did not stop');
  assert.deepEqual(result.skipped.map(item => item.id), ['superpowers:claude']);
  assert.match(result.skipped[0].message, /Superpowers en Claude Code.*Vuelve a ejecutar `npx nexakit`/u);
  assert.ok(progress.some(([id, phase, message]) => id === 'superpowers:claude' && phase === 'failed' && /falló/u.test(message)));
  for (const id of ['superpowers:codex', 'superpowers:antigravity', 'memory-init', 'memory-connect:claude', 'review-instructions', 'final-check'])
    assert.ok(result.done.includes(id), `${id} still ran`);
  assert.equal(result.done.includes('superpowers:claude'), false);
  assert.deepEqual(w.clis.plugins, { claude: 'falta', codex: 'activo', agy: 'activo' });
  assert.equal(await exists(path.join(w.home, 'nexakit-memorias', 'punto-motos', 'project-memory.json')), true);
  assert.match(result.finalCheck.message, /quedó pendiente.*Superpowers en Claude Code/u);
});

test('a failed mod install is reported but does not stop the rest, and the run ends as not ready', async t => {
  const w = await world(t, { fail: { 'claude plugin install nexakit-ahorro': true } });
  const answers = suggestedAnswers(await gatherSetupState(w.options));
  const progress = [];
  const result = await applySetup(w.options, answers, { onProgress: (id, phase, message) => progress.push([id, phase, message]) });
  assert.equal(result.ok, false);
  assert.equal(result.failed, undefined, 'it did not stop');
  assert.deepEqual(result.skipped.map(item => item.id), ['mod:nexakit-ahorro']);
  assert.match(result.skipped[0].message, /Mod nexakit-ahorro.*Vuelve a ejecutar `npx nexakit`/u);
  assert.ok(progress.some(([id, phase]) => id === 'mod:nexakit-ahorro' && phase === 'failed'));
  for (const id of ['mod:nexakit-lecciones', 'mod:nexakit-sesion', 'memory-init', 'final-check']) assert.ok(result.done.includes(id), `${id} still ran`);
  assert.equal(w.clis.mods['nexakit-ahorro'], 'falta');
  assert.equal(w.clis.mods.niveles, 'activo');
  assert.match(result.finalCheck.message, /quedó pendiente.*Mod nexakit-ahorro en Claude Code/u);
});

test('a mod the person unchecked is not installed, and one that is disabled or outdated is enabled or updated', async t => {
  const w = await world(t, { mods: { 'nexakit-modelo': 'desactivado', 'nexakit-ahorro': 'actualizable', niveles: 'activo' } });
  const answers = suggestedAnswers(await gatherSetupState(w.options));
  answers.mods = { chosen: answers.mods.chosen.filter(name => name !== 'nexakit-sesion'), discarded: ['nexakit-sesion'] };
  const result = await applySetup(w.options, answers);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.done.filter(id => id.startsWith('mod:')), ['mod:nexakit-modelo', 'mod:nexakit-ahorro', 'mod:nexakit-lecciones']);
  assert.ok(w.clis.calls.some(call => call.join(' ') === 'claude plugin enable nexakit-modelo@agent-toolkit'));
  assert.ok(w.clis.calls.some(call => call.join(' ') === 'claude plugin update nexakit-ahorro@agent-toolkit'));
  assert.equal(w.clis.mods['nexakit-sesion'], 'falta', 'discarded: left alone');
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

test('from an npx cache: the stable copy comes first and everything points at it, so clearing the cache breaks nothing', async t => {
  const { writeFakeInstall } = await import('../test-support/fake-npm.js');
  const w = await world(t);
  // A small nexakit inside an npx cache: its catalog, the skills it names, the launchers and package.json.
  const ephemeral = path.join(w.base, '.npm/_npx/abc/node_modules/nexakit');
  const catalog = JSON.parse(await fs.readFile(path.join(TOOLKIT_ROOT, 'catalogs/skills.json'), 'utf8'));
  await fs.mkdir(path.join(ephemeral, 'catalogs'), { recursive: true });
  await fs.writeFile(path.join(ephemeral, 'catalogs/skills.json'), JSON.stringify(catalog));
  for (const entry of catalog.skills) await fs.cp(path.join(TOOLKIT_ROOT, entry.installedPath), path.join(ephemeral, entry.installedPath), { recursive: true });
  await fs.cp(path.join(TOOLKIT_ROOT, 'bin'), path.join(ephemeral, 'bin'), { recursive: true });
  await fs.copyFile(path.join(TOOLKIT_ROOT, 'package.json'), path.join(ephemeral, 'package.json'));
  const { version } = JSON.parse(await fs.readFile(path.join(ephemeral, 'package.json'), 'utf8'));
  const calls = [];
  const runNpm = async args => {
    calls.push(args);
    const installed = await writeFakeInstall(args[args.indexOf('--prefix') + 1], { version, skills: [] });
    await fs.cp(ephemeral, installed, { recursive: true, force: true });
    return { status: 0, stderr: '' };
  };
  const options = { ...w.options, toolkitRoot: ephemeral };
  const state = await gatherSetupState(options);
  const answers = { ...suggestedAnswers(state), agents: ['claude'], memory: { decision: 'later' } };
  const result = await applySetup(options, answers, { runNpm });
  assert.equal(result.ok, true, JSON.stringify(result.failed));
  assert.equal(result.done[1], 'stable-copy');
  assert.equal(calls.length, 1);
  const actual = await fs.realpath(path.join(w.home, '.nexakit/actual'));
  assert.equal(await fs.realpath(path.join(w.repo, '.claude/skills/frontend-design')), path.join(actual, 'skills/frontend-design'));
  if (process.platform !== 'win32') {
    assert.match(await fs.readFile(path.join(w.home, '.nexakit/nexakit'), 'utf8'), /\.nexakit\/actual\/bin\/nexakit\.js/u, 'the launcher follows the stable copy');
  }
  await fs.rm(path.join(w.base, '.npm'), { recursive: true });
  assert.equal(await exists(path.join(w.repo, '.claude/skills/frontend-design/SKILL.md')), true);
});

// ── Findings of the first review ─────────────────────────────────────────────────────────────────────────────────

test('another repository with the same name: its memory at the suggested place is never reused nor modified', async t => {
  const w = await world(t);
  const other = path.join(w.base, 'otro', 'Punto_Motos');
  await fs.mkdir(other, { recursive: true });
  execFileSync('git', ['init', '-q', other]);
  const { initializeMemory } = await import('../src/init.js');
  const vault = path.join(w.home, 'nexakit-memorias', 'punto-motos');
  initializeMemory({ destination: vault, projectId: 'punto-motos', projectName: 'Otro', sourcePath: other, syncMode: 'none', agents: ['claude'], apply: true });
  const before = await fs.readFile(path.join(vault, 'project-memory.json'), 'utf8');
  const state = await gatherSetupState(w.options);
  assert.equal(state.memory.kinds[vault], 'foreign');
  const confirmation = buildConfirmation(state, suggestedAnswers(state));
  assert.ok(confirmation.lines.some(line => line.mark === '!' && /memoria de otro proyecto/u.test(line.text)));
  assert.ok(!confirmation.blocks.some(block => block.id.startsWith('memory-')));
  await applySetup(w.options, suggestedAnswers(state));
  assert.equal(await fs.readFile(path.join(vault, 'project-memory.json'), 'utf8'), before);
});

test('a memory chosen in "otra carpeta…" is inspected again before applying, and reused', async t => {
  const w = await world(t);
  const { initializeMemory } = await import('../src/init.js');
  const vault = path.join(w.base, 'mi-memoria');
  initializeMemory({ destination: vault, projectId: 'punto-motos', projectName: 'Punto Motos', sourcePath: w.repo, syncMode: 'none', agents: ['claude'], apply: true });
  await fs.appendFile(path.join(vault, '00-INICIO', 'README.md'), '\nNota mía.\n');
  const answers = { ...suggestedAnswers(await gatherSetupState(w.options)), agents: ['claude'], memory: { decision: 'path', path: vault } };
  const result = await applySetup(w.options, answers);
  assert.equal(result.ok, true, JSON.stringify(result.failed ?? result.finalCheck));
  assert.ok(!result.done.includes('memory-init'), 'an existing memory is not created again');
  assert.match(await fs.readFile(path.join(vault, '00-INICIO', 'README.md'), 'utf8'), /Nota mía/u);
});

test('a new memory whose MCP name is taken in one agent: a ! line before confirming, and the others still connect', async t => {
  const w = await world(t);
  await fs.writeFile(w.clis.files.claudeFile, JSON.stringify({ mcpServers: { 'punto-motos-memory': { command: 'npx', args: ['-y', 'otra-cosa'] } } }));
  const state = await gatherSetupState(w.options);
  const answers = { ...suggestedAnswers(state), agents: ['claude', 'codex'] };
  const confirmation = buildConfirmation(state, answers);
  assert.ok(confirmation.lines.some(line => line.text === 'Claude Code ya tiene otra memoria con el mismo nombre; no la toco'));
  assert.ok(confirmation.lines.some(line => line.text === 'Conectar la memoria a Codex'));
  assert.ok(!confirmation.blocks.some(block => block.id === 'memory-connect:claude'));
  const result = await applySetup(w.options, answers);
  assert.equal(result.ok, true, JSON.stringify(result.failed ?? result.finalCheck));
  assert.match(result.finalCheck.message, /con avisos: Claude Code ya tiene otra memoria/u, 'the warning stays in the final check');
  assert.deepEqual(JSON.parse(await fs.readFile(w.clis.files.claudeFile, 'utf8')).mcpServers['punto-motos-memory'].args, ['-y', 'otra-cosa']);
});

test('a final check that still finds something pending makes the run fail', async t => {
  const w = await world(t);
  const answers = { ...suggestedAnswers(await gatherSetupState(w.options)), agents: ['claude'], memory: { decision: 'later' } };
  let calls = 0, first;
  // The last look (the final check) sees the state as it was before applying: still pending.
  const gather = async options => { calls++; const state = await gatherSetupState(options); first ??= state; return calls > 1 ? first : state; };
  const result = await applySetup(w.options, answers, { gather });
  assert.equal(result.ok, false);
  assert.equal(result.failed, undefined);
  assert.match(result.finalCheck.message, /quedó pendiente/u);
});

test('a memory MCP with the right name and vault but the wrong kind of server for that agent is a conflict', async t => {
  const w = await world(t);
  const claudeOnly = { ...suggestedAnswers(await gatherSetupState(w.options)), agents: ['claude'] };
  assert.equal((await applySetup(w.options, claudeOnly)).ok, true);
  const vault = path.join(w.home, 'nexakit-memorias', 'punto-motos');
  // Antigravity already has the name, serving this vault, but through server-filesystem (it could write).
  await fs.mkdir(path.dirname(w.clis.files.agyFile), { recursive: true });
  await fs.writeFile(w.clis.files.agyFile, JSON.stringify({ mcpServers: { 'punto-motos-memory': {
    command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem@2026.8.31', vault] } } }));
  const manifestBefore = await fs.readFile(path.join(vault, 'project-memory.json'), 'utf8');
  const state = await gatherSetupState(w.options);
  assert.equal(state.memory.connections[vault].antigravity, 'conflict');
  const all = { ...claudeOnly, agents: ['claude', 'antigravity'] };
  assert.ok(!buildConfirmation(state, all).blocks.some(block => block.id === 'memory-connect:antigravity'));
  await applySetup(w.options, all);
  assert.equal(await fs.readFile(path.join(vault, 'project-memory.json'), 'utf8'), manifestBefore, 'the manifest is not touched');
});
