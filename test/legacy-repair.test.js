import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { test } from 'node:test';
import { fakeNpm, writeFakeInstall } from '../test-support/fake-npm.js';

const moduleUrl = new URL('../src/legacy-repair.js', import.meta.url);
const cliUrl = new URL('../src/toolkit-cli.js', import.meta.url);
const registryUrl = new URL('../src/install-registry.js', import.meta.url);
const directoryLinkType = process.platform === 'win32' ? 'junction' : 'dir';
const SKILLS = ['alfa', 'beta', 'gamma', 'delta'];
const environment = { PATH: '' };

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'legacy-repair-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const homeDirectory = path.join(root, 'home');
  await fs.mkdir(homeDirectory);
  const toolkitRoot = await writeFakeInstall(path.join(root, 'toolkit'), { skills: SKILLS, version: '0.1.0' });
  const dead = path.join(root, 'Agent-Toolkit');
  const target = (client, name) => path.join(homeDirectory, client === 'codex' ? '.agents/skills' : '.claude/skills', name);
  const link = async (client, name, to) => {
    await fs.mkdir(path.dirname(target(client, name)), { recursive: true });
    await fs.symlink(to, target(client, name), directoryLinkType);
  };
  return { root, homeDirectory, toolkitRoot, dead, target, link, options: { homeDirectory, toolkitRoot, environment } };
}
// Three links into the dead root, one into another dead root, and one valid link that must be left out.
async function legacySetup(t) {
  const f = await fixture(t);
  await f.link('claude', 'alfa', path.join(f.dead, 'skills/alfa'));
  await f.link('claude', 'beta', path.join(f.dead, 'skills/beta'));
  await f.link('codex', 'gamma', path.join(f.dead, 'skills/gamma'));
  await f.link('claude', 'delta', path.join(f.root, 'Otro/skills/delta'));
  await f.link('codex', 'alfa', path.join(f.toolkitRoot, 'skills/alfa'));
  await f.link('claude', 'ajena', path.join(f.dead, 'skills/ajena'));
  return f;
}

function io() {
  const out = [], err = [];
  return { out, err, text: () => out.join(''), errText: () => err.join('') };
}
const interactive = answer => ({ input: Readable.from([answer]), output: new PassThrough(), isTTY: true });

test('the plan holds only the broken links into the given root that carry a nexakit skill name', async t => {
  const f = await legacySetup(t), { planLegacyRepair } = await import(moduleUrl);
  const plan = await planLegacyRepair({ ...f.options, from: f.dead });
  assert.equal(plan.from, f.dead);
  assert.deepEqual(plan.links.map(l => `${l.client}/${l.name}`).sort(), ['claude/alfa', 'claude/beta', 'codex/gamma']);
  assert.deepEqual(plan.links.find(l => l.name === 'beta'),
    { client: 'claude', name: 'beta', target: f.target('claude', 'beta'), literal: path.join(f.dead, 'skills/beta') });
  assert.equal(plan.ephemeral, false);
  assert.equal(plan.activeRoot, f.toolkitRoot);
  assert.deepEqual((await planLegacyRepair({ ...f.options, from: f.dead, agent: 'claude' })).links.map(l => l.name).sort(), ['alfa', 'beta']);
  assert.deepEqual((await planLegacyRepair({ ...f.options, from: path.join(f.root, 'Otro') })).links.map(l => l.name), ['delta']);
  assert.deepEqual((await planLegacyRepair({ ...f.options, from: path.join(f.root, 'Nada') })).links, []);
});

test('applying repoints the links, records them and leaves alone any that changed meanwhile', async t => {
  const f = await legacySetup(t), { planLegacyRepair, applyLegacyRepair } = await import(moduleUrl), { readRegistry } = await import(registryUrl);
  const plan = await planLegacyRepair({ ...f.options, from: f.dead });
  await fs.rm(f.target('claude', 'beta'));
  await fs.symlink(path.join(f.root, 'otra/skills/beta'), f.target('claude', 'beta'), directoryLinkType);

  const result = await applyLegacyRepair(plan, f.options);
  assert.deepEqual([result.repaired, result.changed, result.skipped], [2, 1, []]);
  assert.equal(await fs.realpath(f.target('claude', 'alfa')), path.join(f.toolkitRoot, 'skills/alfa'));
  assert.equal(await fs.realpath(f.target('codex', 'gamma')), path.join(f.toolkitRoot, 'skills/gamma'));
  assert.equal(await fs.readlink(f.target('claude', 'beta')), path.join(f.root, 'otra/skills/beta'));
  assert.equal(await fs.readlink(f.target('claude', 'delta')), path.join(f.root, 'Otro/skills/delta'), 'another root is untouched');
  assert.equal(await fs.readlink(f.target('claude', 'ajena')), path.join(f.dead, 'skills/ajena'), 'a name nexakit does not ship is untouched');
  const registry = await readRegistry(path.join(f.homeDirectory, '.nexakit'));
  assert.deepEqual(registry.entradas.map(e => e.destino).sort(), [f.target('claude', 'alfa'), f.target('codex', 'gamma')].sort());
  assert.ok(registry.entradas.every(e => e.raiz === f.toolkitRoot));
});

test('a skill the active copy does not have is skipped, not linked to nothing', async t => {
  const f = await legacySetup(t), { planLegacyRepair, applyLegacyRepair } = await import(moduleUrl);
  await f.link('claude', 'zeta', path.join(f.dead, 'skills/zeta'));
  const plan = await planLegacyRepair({ ...f.options, from: f.dead });
  const withZeta = { ...plan, links: [...plan.links, { client: 'claude', name: 'zeta', target: f.target('claude', 'zeta'), literal: path.join(f.dead, 'skills/zeta') }] };
  const result = await applyLegacyRepair(withZeta, f.options);
  assert.deepEqual([result.repaired, result.skipped], [3, ['zeta']]);
  assert.equal(await fs.readlink(f.target('claude', 'zeta')), path.join(f.dead, 'skills/zeta'));
});

test('from an npx cache the repaired links point at the stable copy', async t => {
  const f = await fixture(t), { planLegacyRepair, applyLegacyRepair } = await import(moduleUrl);
  const cache = await writeFakeInstall(path.join(f.root, '.npm/_npx/abc'), { skills: SKILLS, version: '0.1.0' });
  await f.link('claude', 'alfa', path.join(f.dead, 'skills/alfa'));
  const options = { ...f.options, toolkitRoot: cache };
  const plan = await planLegacyRepair({ ...options, from: f.dead });
  assert.deepEqual([plan.ephemeral, plan.activeRoot], [true, path.join(f.homeDirectory, '.nexakit', 'actual')]);
  const npm = fakeNpm({ skills: SKILLS, version: '0.1.0' });
  const result = await applyLegacyRepair(plan, { ...options, runNpm: npm });
  assert.deepEqual([result.repaired, npm.calls.length], [1, 1]);
  assert.equal(await fs.readlink(f.target('claude', 'alfa')), path.join(f.homeDirectory, '.nexakit/actual/skills/alfa'));
});

test('an MCP entry on the dead root is reported with the exact commands to move it, never changed here', async t => {
  const f = await legacySetup(t), { planLegacyRepair, applyLegacyRepair } = await import(moduleUrl);
  const bin = path.join(f.root, 'bin');
  await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, 'node'), '', { mode: 0o755 });
  const config = path.join(f.homeDirectory, '.claude.json');
  await fs.writeFile(config, JSON.stringify({ mcpServers: { 'agent-toolkit-workflow': { command: 'node', args: [path.join(f.dead, 'bin/agent-toolkit-mcp.js')] } } }));
  const before = await fs.readFile(config, 'utf8');
  const options = { ...f.options, environment: { PATH: bin } };
  const plan = await planLegacyRepair({ ...options, from: f.dead });
  assert.deepEqual(Object.keys(plan.mcp), ['claude']);
  const result = await applyLegacyRepair(plan, options);
  assert.deepEqual(result.mcpCommands, [
    `claude mcp remove agent-toolkit-workflow -s user && claude mcp add --scope user --transport stdio agent-toolkit-workflow -- '${path.join(bin, 'node')}' '${path.join(f.toolkitRoot, 'bin/agent-toolkit-mcp.js')}'`
  ]);
  assert.equal(await fs.readFile(config, 'utf8'), before);
});

test('the command refuses --si, a missing --desde and a terminal that is not interactive', async t => {
  const f = await legacySetup(t), { runToolkitCli } = await import(cliUrl);
  const run = async (argv, extra = {}) => { const o = io(); const code = await runToolkitCli(argv, { out: x => o.out.push(x), err: x => o.err.push(x), options: f.options, ...extra }); return { code, ...o }; };

  const si = await run(['reparar', '--desde', f.dead, '--si'], interactive('s\n'));
  assert.deepEqual([si.code, si.errText()], [2, 'reparar siempre pregunta; no admite --si.\n']);
  assert.equal(await fs.readlink(f.target('claude', 'alfa')), path.join(f.dead, 'skills/alfa'));

  const missing = await run(['reparar'], interactive('s\n'));
  assert.equal(missing.code, 2);
  assert.match(missing.errText(), /reparar --desde/u);

  const dumb = await run(['reparar', '--desde', f.dead], { input: Readable.from(['s\n']), output: new PassThrough(), isTTY: false });
  assert.equal(dumb.code, 2);
  assert.match(dumb.text(), /Encontré 3 enlaces rotos hacia/u);
  assert.doesNotMatch(dumb.text(), /\[s\/N\]/u, 'no question without a terminal');
  assert.equal(dumb.errText(), 'Este comando necesita una terminal interactiva.\n');
  assert.equal(await fs.readlink(f.target('claude', 'alfa')), path.join(f.dead, 'skills/alfa'));
});

test('the command lists what it found, asks, and only on "s" repoints the links', async t => {
  const f = await legacySetup(t), { runToolkitCli } = await import(cliUrl);
  const run = async (argv, extra) => { const o = io(); const code = await runToolkitCli(argv, { out: x => o.out.push(x), err: x => o.err.push(x), options: f.options, ...extra }); return { code, ...o }; };

  const no = await run(['reparar', '--desde', f.dead], interactive('\n'));
  assert.equal(no.code, 0);
  assert.equal(no.text(), [
    `Encontré 3 enlaces rotos hacia ${f.dead}.`,
    'No puedo comprobar que sean de nexakit: revisa la lista.',
    '  claude · alfa', '  claude · beta', '  codex · gamma',
    '¿Los re-apunto a la copia de nexakit en uso? [s/N]', 'No se cambió nada.', ''
  ].join('\n'));
  assert.equal(await fs.readlink(f.target('claude', 'alfa')), path.join(f.dead, 'skills/alfa'));

  const eof = await run(['reparar', '--desde', f.dead], { input: Readable.from([]), output: new PassThrough(), isTTY: true });
  assert.deepEqual([eof.code, /No se cambió nada/u.test(eof.text())], [0, true], 'no answer counts as no');

  const yes = await run(['reparar', '--desde', f.dead, '--agent', 'claude'], interactive('s\n'));
  assert.equal(yes.code, 0);
  assert.match(yes.text(), /Encontré 2 enlaces rotos/u);
  assert.match(yes.text(), /Listo: 2 enlaces re-apuntados\./u);
  assert.equal(await fs.realpath(f.target('claude', 'alfa')), path.join(f.toolkitRoot, 'skills/alfa'));
  assert.equal(await fs.readlink(f.target('codex', 'gamma')), path.join(f.dead, 'skills/gamma'), 'the other agent was not asked about');

  const none = await run(['reparar', '--desde', path.join(f.root, 'Nada')], interactive('s\n'));
  assert.deepEqual([none.code, none.text()], [0, `No encontré enlaces rotos hacia ${path.join(f.root, 'Nada')}.\n`]);
});
