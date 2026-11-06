import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fakeNpm, writeFakeInstall } from '../test-support/fake-npm.js';

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'toolkit-setup-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const homeDirectory = path.join(root, 'home'), toolkitRoot = path.join(root, 'toolkit');
  await fs.mkdir(homeDirectory);
  await fs.mkdir(path.join(toolkitRoot, 'skills', 'example'), { recursive: true });
  await fs.writeFile(path.join(toolkitRoot, 'skills', 'example', 'SKILL.md'), '---\nname: example\ndescription: Example\n---\n');
  return { root, homeDirectory, toolkitRoot };
}
const moduleUrl = new URL('../src/toolkit-setup.js', import.meta.url);
const stableUrl = new URL('../src/stable-install.js', import.meta.url);
const registryUrl = new URL('../src/install-registry.js', import.meta.url);
const lockUrl = new URL('../src/install-lock.js', import.meta.url);
const directoryLinkType = process.platform === 'win32' ? 'junction' : 'dir';
test('setup preview writes nothing; apply links both clients and repeating preserves links', async t => {
  const f = await fixture(t);
  assert.equal(await fs.access(moduleUrl).then(() => true, () => false), true, 'setup module exists');
  const { setupToolkit } = await import(moduleUrl);
  // Without `agy` on the PATH, `all` means Codex and Claude.
  const environment = { PATH: '' };
  const preview = await setupToolkit({ ...f, agent: 'all', environment });
  assert.equal(preview.applied, false);
  assert.equal(preview.skills.length, 2);
  assert.deepEqual(await fs.readdir(f.homeDirectory), []);
  assert.equal((await setupToolkit({ ...f, agent: 'all', apply: true, environment })).applied, true);
  assert.equal(await fs.realpath(path.join(f.homeDirectory, '.agents/skills/example')), path.join(f.toolkitRoot, 'skills/example'));
  assert.equal((await setupToolkit({ ...f, agent: 'all', apply: true, environment })).skills.every(s => s.state === 'instalado'), true);
});

test('setup recognizes an equivalent directory link and keeps its source intact', async t => {
  const f = await fixture(t), { setupToolkit } = await import(moduleUrl);
  const target = path.join(f.homeDirectory, '.agents', 'skills', 'example');
  const source = path.join(f.toolkitRoot, 'skills', 'example');
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.symlink(process.platform === 'win32' ? source.toUpperCase() : path.relative(path.dirname(target), source), target, directoryLinkType);
  const before = await fs.readlink(target);
  const result = await setupToolkit({ ...f, agent: 'codex', apply: true });
  assert.equal(result.skills[0].state, 'instalado');
  assert.equal(await fs.readlink(target), before);
  assert.match(await fs.readFile(path.join(source, 'SKILL.md'), 'utf8'), /name: example/u);
});

test('doctor finds client executables using platform PATH extensions', async t => {
  const f = await fixture(t), { doctorToolkit } = await import(moduleUrl);
  const bin = path.join(f.root, 'bin');
  await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, process.platform === 'win32' ? 'codex.cmd' : 'codex'), '', { mode: 0o755 });
  const result = await doctorToolkit({ ...f, agent: 'codex', environment: { PATH: bin, PATHEXT: '.EXE;.CMD' } });
  assert.equal(result.clients.codex.available, true);
});
test('setup skips occupied targets, reports them and rejects symlink parents without modifying unrelated files', async t => {
  const f = await fixture(t);
  assert.equal(await fs.access(moduleUrl).then(() => true, () => false), true);
  const { setupToolkit } = await import(moduleUrl);
  await fs.mkdir(path.join(f.homeDirectory, '.agents/skills/example'), { recursive: true });
  await fs.writeFile(path.join(f.homeDirectory, '.agents/skills/example/mine'), 'keep');
  // A conflict is skipped and reported; it does not block the rest of the apply.
  const blocked = await setupToolkit({ ...f, agent: 'codex', apply: true });
  assert.equal(blocked.applied, true);
  assert.equal(blocked.conflicts, 1);
  assert.equal(blocked.skills[0].state, 'conflicto');
  assert.equal(await fs.readFile(path.join(f.homeDirectory, '.agents/skills/example/mine'), 'utf8'), 'keep');
  await fs.symlink(f.root, path.join(f.homeDirectory, '.claude'), directoryLinkType);
  await assert.rejects(setupToolkit({ ...f, agent: 'claude', apply: true }));
});
test('doctor reports missing dependencies and required Superpowers without creating configuration', async t => {
  const f = await fixture(t);
  assert.equal(await fs.access(moduleUrl).then(() => true, () => false), true);
  const { doctorToolkit } = await import(moduleUrl);
  const result = await doctorToolkit({ ...f, agent: 'codex', environment: { PATH: '' } });
  assert.equal(result.clients.codex.available, false);
  assert.equal(result.superpowers.required, true);
  assert.deepEqual(result.superpowers.states, {}, 'no agent found, nothing inspected');
  assert.equal(result.mcp.codex.state, 'falta');
  assert.equal(result.nativeConnectionVerified, false);
  assert.deepEqual(await fs.readdir(f.homeDirectory), []);
});

test('doctor recognizes complete MCP tables with extra fields without exposing their contents', async t => {
  const f = await fixture(t), { doctorToolkit } = await import(moduleUrl);
  await fs.mkdir(path.join(f.homeDirectory,'.codex'));
  // The entry only counts as installed when the script it runs exists.
  await fs.mkdir(path.join(f.toolkitRoot, 'bin'));
  await fs.writeFile(path.join(f.toolkitRoot, 'bin/agent-toolkit-mcp.js'), '');
  const config = `[mcp_servers.agent-toolkit-workflow]\ncommand = "node"\nargs = [${JSON.stringify(path.join(f.toolkitRoot,'bin/agent-toolkit-mcp.js'))}]\nstartup_timeout_sec = 20\n[mcp_servers.agent-toolkit-workflow.env]\nPRIVATE_VALUE = "must-not-leak"\n`;
  await fs.writeFile(path.join(f.homeDirectory,'.codex/config.toml'), config);
  const result = await doctorToolkit({ ...f, agent: 'codex', environment: { PATH: '' } });
  assert.equal(result.mcp.codex.state, 'instalado');
  assert.equal(JSON.stringify(result).includes('must-not-leak'), false);
});

test('setup and doctor report whether the Codex sandbox lets $revisar write its reviewer record', async t => {
  const f = await fixture(t), { setupToolkit, doctorToolkit } = await import(moduleUrl);
  const codexHome = path.join(f.homeDirectory, '.codex'), config = path.join(codexHome, 'config.toml');
  const state = path.join(f.homeDirectory, '.agent-toolkit');
  const check = async () => (await setupToolkit({ ...f, agent: 'codex', codexHome })).codexSandbox;
  assert.equal((await setupToolkit({ ...f, agent: 'claude', codexHome })).codexSandbox, undefined);
  const missing = await check();
  assert.deepEqual([missing.state, missing.writableRoot], ['missing', state]);
  await fs.mkdir(codexHome);
  await fs.writeFile(config, 'model = "x"\n');
  // The printed command appends the section once and refuses to duplicate it.
  assert.equal(execSync(missing.command, { encoding: 'utf8' }), '');
  assert.equal(execSync(missing.command, { encoding: 'utf8' }), 'Ya existe la sección: añade la ruta a writable_roots a mano\n');
  assert.equal((await fs.readFile(config, 'utf8')).match(/\[sandbox_workspace_write\]/gu).length, 1);
  assert.equal((await check()).state, 'allowed');
  assert.equal((await doctorToolkit({ ...f, agent: 'codex', codexHome, environment: { PATH: '' } })).codexSandbox.state, 'allowed');
  await fs.writeFile(config, '[sandbox_workspace_write]\nwritable_roots = ["~/.agent-toolkit"]\n');
  assert.equal((await check()).state, 'allowed');
  await fs.writeFile(config, '[sandbox_workspace_write]\nwritable_roots = ["/otra"]\n');
  const partial = await check();
  assert.deepEqual([partial.state, 'command' in partial], ['missing-root', false]);
  assert.match(partial.hint, /writable_roots/u);
  await fs.writeFile(config, 'sandbox_mode = "danger-full-access"\n');
  assert.equal((await check()).state, 'not-needed');
  await fs.writeFile(config, 'roto = [\n');
  assert.equal((await check()).state, 'unreadable');
});

test('the sandbox check follows the mode, profiles, permission profiles, parent roots, links and CODEX_HOME', async t => {
  const f = await fixture(t), { setupToolkit, doctorToolkit } = await import(moduleUrl);
  const codexHome = path.join(f.homeDirectory, '.codex'), config = path.join(codexHome, 'config.toml');
  const state = path.join(f.homeDirectory, '.agent-toolkit');
  await fs.mkdir(codexHome);
  const check = async (text, extra = {}) => { await fs.writeFile(config, text); return (await setupToolkit({ ...f, agent: 'codex', codexHome, ...extra })).codexSandbox; };
  const roots = list => `[sandbox_workspace_write]\nwritable_roots = ${JSON.stringify(list)}\n`;
  // writable_roots only count in workspace-write; read-only blocks the record whatever the roots say.
  const readOnly = await check('sandbox_mode = "read-only"\n' + roots([state]));
  assert.equal(readOnly.state, 'read-only');
  assert.match(readOnly.hint, /workspace-write/u);
  assert.equal((await check('sandbox_mode = "workspace-write"\n' + roots([state]))).state, 'allowed');
  // A parent folder allows it; a sibling that only shares the prefix does not.
  assert.equal((await check(roots([f.homeDirectory]))).state, 'allowed');
  assert.equal((await check(roots([path.join(f.homeDirectory, '.agent')]))).state, 'missing-root');
  // The same folder reached through a link counts.
  const link = path.join(f.root, 'enlace-home');
  await fs.symlink(f.homeDirectory, link, directoryLinkType);
  assert.equal((await check(roots([path.join(link, '.agent-toolkit')]))).state, 'allowed');
  // The selected configuration profile overrides the top level.
  assert.equal((await check(`profile = "trabajo"\n[profiles.trabajo]\nsandbox_mode = "danger-full-access"\n`)).state, 'not-needed');
  assert.equal((await check(`profile = "trabajo"\nsandbox_mode = "danger-full-access"\n[profiles.trabajo]\nsandbox_mode = "read-only"\n`)).state, 'read-only');
  assert.equal((await check(`profile = "trabajo"\n[profiles.trabajo]\nsandbox_mode = "workspace-write"\n[profiles.trabajo.sandbox_workspace_write]\nwritable_roots = ${JSON.stringify([state])}\n`)).state, 'allowed');
  const missingProfile = await check('profile = "otro"\n');
  assert.deepEqual([missingProfile.state, 'command' in missingProfile], ['unknown', false]);
  // Permission profiles: full access is understood; anything else is reported as unknown, not as a change to make.
  assert.equal((await check('default_permissions = ":danger-full-access"\n')).state, 'not-needed');
  const custom = await check('default_permissions = "revisor"\n[permissions.revisor]\nnetwork = false\n');
  assert.deepEqual([custom.state, 'command' in custom], ['unknown', false]);
  assert.equal((await check('sandbox_mode = "otro-modo"\n')).state, 'unknown');
  // setup and doctor read the same configuration when CODEX_HOME is set.
  const other = path.join(f.root, 'codex-home');
  await fs.mkdir(other);
  await fs.writeFile(path.join(other, 'config.toml'), 'sandbox_mode = "danger-full-access"\n');
  await fs.writeFile(config, 'model = "x"\n');
  const environment = { PATH: '', CODEX_HOME: other };
  assert.equal((await setupToolkit({ ...f, agent: 'codex', environment })).codexSandbox.state, 'not-needed');
  assert.equal((await doctorToolkit({ ...f, agent: 'codex', environment })).codexSandbox.state, 'not-needed');
});

test('sandbox_mode takes precedence, :read-only blocks and current profile files are layered or reported', async t => {
  const f = await fixture(t), { setupToolkit } = await import(moduleUrl);
  const { runToolkitCli } = await import(new URL('../src/toolkit-cli.js', import.meta.url));
  const codexHome = path.join(f.homeDirectory, '.codex'), config = path.join(codexHome, 'config.toml');
  const state = path.join(f.homeDirectory, '.agent-toolkit');
  await fs.mkdir(codexHome);
  const check = async (text, extra = {}) => { if (text !== null) await fs.writeFile(config, text); return (await setupToolkit({ ...f, agent: 'codex', codexHome, ...extra })).codexSandbox; };
  // With sandbox_mode present Codex ignores default_permissions.
  assert.equal((await check('sandbox_mode = "read-only"\ndefault_permissions = ":danger-full-access"\n')).state, 'read-only');
  assert.equal((await check(`sandbox_mode = "workspace-write"\ndefault_permissions = ":read-only"\n[sandbox_workspace_write]\nwritable_roots = ${JSON.stringify([state])}\n`)).state, 'allowed');
  // The built-in :read-only permission profile is known and blocking.
  const readOnly = await check('default_permissions = ":read-only"\n');
  assert.equal(readOnly.state, 'read-only');
  // `codex --profile <name>` layers <name>.config.toml over config.toml.
  await fs.writeFile(config, 'sandbox_mode = "workspace-write"\n');
  await fs.writeFile(path.join(codexHome, 'libre.config.toml'), 'sandbox_mode = "danger-full-access"\n');
  await fs.writeFile(path.join(codexHome, 'estricto.config.toml'), 'sandbox_mode = "read-only"\n');
  await fs.writeFile(path.join(codexHome, 'roots.config.toml'), `[sandbox_workspace_write]\nwritable_roots = ${JSON.stringify([state])}\n`);
  const plain = await check(null);
  assert.deepEqual([plain.state, plain.profileFiles], ['missing', ['estricto', 'libre', 'roots']]);
  assert.match(plain.profileHint, /--perfil-codex/u);
  assert.equal((await check(null, { codexProfile: 'libre' })).state, 'not-needed');
  assert.equal((await check(null, { codexProfile: 'estricto' })).state, 'read-only');
  const layered = await check(null, { codexProfile: 'roots' });
  assert.deepEqual([layered.state, 'profileFiles' in layered], ['allowed', false]);
  assert.equal((await check(null, { codexProfile: 'falta' })).state, 'unknown');
  await assert.rejects(setupToolkit({ ...f, agent: 'codex', codexHome, codexProfile: '../fuera' }));
  // The CLI forwards --perfil-codex and rejects bad names; a blocking state makes doctor fail.
  const run = async argv => { const out = []; const code = await runToolkitCli(argv, { out: t => out.push(t), err: () => {}, options: { ...f, codexHome, environment: { PATH: '' } } }); return { code, json: out.length ? JSON.parse(out.join('')) : null }; };
  const viaCli = await run(['setup', '--agent', 'codex', '--perfil-codex', 'libre', '--json']);
  assert.equal(viaCli.json.codexSandbox.state, 'not-needed');
  assert.equal((await run(['doctor', '--agent', 'codex', '--perfil-codex', '../x'])).code, 2);
  assert.equal((await run(['doctor', '--agent', 'codex', '--perfil-codex', 'estricto', '--json'])).json.codexSandbox.state, 'read-only');
  assert.equal((await run(['doctor', '--agent', 'codex', '--perfil-codex', 'estricto', '--json'])).code, 1);
});

const link = async (to, at) => { await fs.mkdir(path.dirname(at), { recursive: true }); await fs.symlink(to, at, directoryLinkType); };
const exists = file => fs.lstat(file).then(() => true, () => false);
const skillTarget = (home, client, name) => path.join(home, client === 'codex' ? '.agents/skills' : '.claude/skills', name);

async function npxFixture(t, skills = ['example']) {
  const f = await fixture(t);
  const ephemeral = await writeFakeInstall(path.join(f.root, '.npm/_npx/abc'), { skills });
  return { ...f, ephemeral, npm: fakeNpm({ skills }) };
}
async function register(home, entries) {
  const { acquireLock } = await import(lockUrl), { recordEntries } = await import(registryUrl), { nexakitDir } = await import(stableUrl);
  const lock = await acquireLock(nexakitDir(home), { waitMs: 1000 });
  try { await recordEntries(nexakitDir(home), entries, lock); } finally { await lock.release(); }
}

test('an npx run links to the stable copy and survives removing the npx cache', async t => {
  const f = await npxFixture(t), { setupToolkit, doctorToolkit } = await import(moduleUrl), { actualRoot } = await import(stableUrl);
  const result = await setupToolkit({ homeDirectory: f.homeDirectory, toolkitRoot: f.ephemeral, agent: 'all', apply: true, environment: { PATH: '' }, runNpm: f.npm });
  assert.deepEqual([result.applied, result.ephemeral, f.npm.calls.length], [true, true, 1]);
  for (const client of ['codex', 'claude']) {
    assert.equal(await fs.readlink(skillTarget(f.homeDirectory, client, 'example')), path.join(actualRoot(f.homeDirectory), 'skills/example'));
  }
  await fs.rm(path.join(f.root, '.npm'), { recursive: true });
  const doctor = await doctorToolkit({ homeDirectory: f.homeDirectory, toolkitRoot: actualRoot(f.homeDirectory), agent: 'all', environment: { PATH: '' } });
  assert.deepEqual(doctor.skills.map(skill => skill.state), ['instalado', 'instalado']);
});

test('an npx run keeps a valid development copy and does not mix origins', async t => {
  const f = await npxFixture(t, ['example', 'other', 'extra']), { setupToolkit } = await import(moduleUrl);
  const dev = await writeFakeInstall(path.join(f.root, 'dev'), { skills: ['example', 'other'] });
  for (const client of ['codex', 'claude']) for (const name of ['example', 'other']) {
    await link(path.join(dev, 'skills', name), skillTarget(f.homeDirectory, client, name));
  }
  const result = await setupToolkit({ homeDirectory: f.homeDirectory, toolkitRoot: f.ephemeral, agent: 'all', apply: true, environment: { PATH: '' }, runNpm: f.npm });
  assert.equal(result.activeRoot, dev);
  assert.deepEqual(result.otherCopy, { root: dev, missing: ['extra'] });
  assert.equal(f.npm.calls.length, 0, 'no stable copy is needed when the development copy is the active root');
  for (const client of ['codex', 'claude']) {
    for (const name of ['example', 'other']) assert.equal(await fs.readlink(skillTarget(f.homeDirectory, client, name)), path.join(dev, 'skills', name));
    assert.equal(await exists(skillTarget(f.homeDirectory, client, 'extra')), false);
  }
  assert.deepEqual(result.skills.map(skill => skill.state).sort(), ['falta', 'falta', 'otra-copia', 'otra-copia', 'otra-copia', 'otra-copia']);
});

test('links into another npx cache, a deleted one or the running one are moved to the stable copy', async t => {
  const f = await npxFixture(t, ['example', 'other']), { setupToolkit } = await import(moduleUrl), { actualRoot } = await import(stableUrl);
  const oldCache = await writeFakeInstall(path.join(f.root, '.npm/_npx/old'), { skills: ['example', 'other'] });
  await link(path.join(oldCache, 'skills/example'), skillTarget(f.homeDirectory, 'claude', 'example'));
  await link(path.join(f.root, '.npm/_npx/gone/node_modules/nexakit/skills/example'), skillTarget(f.homeDirectory, 'codex', 'example'));
  await link(path.join(f.ephemeral, 'skills/other'), skillTarget(f.homeDirectory, 'claude', 'other'));
  const options = { homeDirectory: f.homeDirectory, toolkitRoot: f.ephemeral, agent: 'all', environment: { PATH: '' }, runNpm: f.npm };
  const preview = await setupToolkit(options);
  assert.deepEqual(preview.skills.map(skill => `${skill.client}/${skill.name}:${skill.state}`),
    ['codex/example:efimero', 'codex/other:falta', 'claude/example:efimero', 'claude/other:efimero']);
  await setupToolkit({ ...options, apply: true });
  for (const client of ['codex', 'claude']) for (const name of ['example', 'other']) {
    assert.equal(await fs.readlink(skillTarget(f.homeDirectory, client, name)), path.join(actualRoot(f.homeDirectory), 'skills', name));
  }
});

test('a registered broken link is repaired; an unregistered one is left as it is', async t => {
  const f = await fixture(t), { setupToolkit } = await import(moduleUrl);
  const owned = path.join(f.root, 'dead1/skills/example'), foreign = path.join(f.root, 'dead2/skills/example');
  const claude = skillTarget(f.homeDirectory, 'claude', 'example'), codex = skillTarget(f.homeDirectory, 'codex', 'example');
  await link(owned, claude);
  await link(foreign, codex);
  await register(f.homeDirectory, [{ destino: claude, apunta: owned, raiz: path.join(f.root, 'dead1') }]);
  const result = await setupToolkit({ ...f, agent: 'all', apply: true, environment: { PATH: '' } });
  assert.equal(await fs.realpath(claude), path.join(f.toolkitRoot, 'skills/example'));
  assert.equal(await fs.readlink(codex), foreign);
  assert.equal(result.conflicts, 1);
  assert.deepEqual(result.skills.map(skill => `${skill.client}:${skill.state}`), ['codex:roto-ajeno', 'claude:instalado']);
});

test('groups of old broken links are reported for `reparar --desde` and never touched', async t => {
  const f = await fixture(t), { setupToolkit } = await import(moduleUrl);
  for (const name of ['b', 'c']) {
    await fs.mkdir(path.join(f.toolkitRoot, 'skills', name));
    await fs.writeFile(path.join(f.toolkitRoot, 'skills', name, 'SKILL.md'), 'x');
  }
  const legacyRoot = path.join(f.root, 'Agent-Toolkit');
  for (const name of ['b', 'c', 'example']) await link(path.join(legacyRoot, 'skills', name), skillTarget(f.homeDirectory, 'claude', name));
  const preview = await setupToolkit({ ...f, agent: 'claude' });
  assert.deepEqual(preview.legacy, [{ root: legacyRoot, targets: ['b', 'c', 'example'].map(name => skillTarget(f.homeDirectory, 'claude', name)) }]);
  await setupToolkit({ ...f, agent: 'claude', apply: true, environment: { PATH: '' } });
  for (const name of ['b', 'c', 'example']) assert.equal(await fs.readlink(skillTarget(f.homeDirectory, 'claude', name)), path.join(legacyRoot, 'skills', name));
});

test('a stable copy removed by hand leaves its links as owned and broken, and the next apply rebuilds it', async t => {
  const f = await npxFixture(t), { setupToolkit, doctorToolkit } = await import(moduleUrl);
  const options = { homeDirectory: f.homeDirectory, toolkitRoot: f.ephemeral, agent: 'claude', environment: { PATH: '' }, runNpm: f.npm };
  await setupToolkit({ ...options, apply: true });
  await fs.rm(path.join(f.homeDirectory, '.nexakit/versiones'), { recursive: true });
  assert.equal((await setupToolkit(options)).skills[0].state, 'roto-propio');
  await setupToolkit({ ...options, apply: true });
  assert.equal(f.npm.calls.length, 2);
  assert.equal((await doctorToolkit(options)).skills[0].state, 'instalado');
});

test('Antigravity is included when agy is installed or its folder exists, and only then', async t => {
  const f = await fixture(t), { setupToolkit, doctorToolkit } = await import(moduleUrl);
  const bin = path.join(f.root, 'bin');
  await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, 'agy'), '', { mode: 0o755 });
  const without = await setupToolkit({ ...f, agent: 'all', apply: true, environment: { PATH: '' } });
  assert.deepEqual(without.clients, ['codex', 'claude']);
  assert.equal(await exists(path.join(f.homeDirectory, '.gemini')), false);
  const withAgy = await setupToolkit({ ...f, agent: 'all', apply: true, environment: { PATH: bin } });
  assert.deepEqual(withAgy.clients, ['codex', 'claude', 'antigravity']);
  assert.equal(await fs.realpath(path.join(f.homeDirectory, '.gemini/antigravity-cli/skills/example')), path.join(f.toolkitRoot, 'skills/example'));
  const doctor = await doctorToolkit({ ...f, agent: 'all', environment: { PATH: bin } });
  assert.equal(doctor.clients.antigravity.available, true);
  assert.equal('antigravity' in doctor.mcp, false, 'Antigravity has no coordination MCP in this phase');

  const g = await fixture(t);
  await fs.mkdir(path.join(g.homeDirectory, '.gemini/antigravity-cli'), { recursive: true });
  assert.deepEqual((await setupToolkit({ ...g, agent: 'all', environment: { PATH: '' } })).clients, ['codex', 'claude', 'antigravity']);
  assert.deepEqual((await setupToolkit({ ...g, agent: 'antigravity', environment: { PATH: '' } })).clients, ['antigravity']);
  await assert.rejects(setupToolkit({ ...g, agent: 'gemini', environment: { PATH: '' } }), /antigravity/u);
});

test('MCP states and registration commands only for what needs them, with the node on the PATH', async t => {
  const f = await fixture(t), { setupToolkit } = await import(moduleUrl);
  await fs.mkdir(path.join(f.toolkitRoot, 'bin'));
  await fs.writeFile(path.join(f.toolkitRoot, 'bin/agent-toolkit-mcp.js'), '');
  const dev = await writeFakeInstall(path.join(f.root, 'dev'));
  const bin = path.join(f.root, 'bin');
  await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, 'node'), '', { mode: 0o755 });
  const config = path.join(f.homeDirectory, '.claude.json');
  const write = server => fs.writeFile(config, JSON.stringify({ mcpServers: { 'agent-toolkit-workflow': server } }));
  const check = async () => {
    const result = await setupToolkit({ ...f, agent: 'claude', environment: { PATH: bin } });
    return { state: result.mcp.states.claude.state, command: result.mcp.registrationCommands.claude };
  };
  const runs = file => ({ command: 'node', args: [file] });
  const add = `claude mcp add --scope user --transport stdio agent-toolkit-workflow -- '${path.join(bin, 'node')}' '${path.join(f.toolkitRoot, 'bin/agent-toolkit-mcp.js')}'`;

  await write(runs(path.join(f.toolkitRoot, 'bin/agent-toolkit-mcp.js')));
  assert.deepEqual(await check(), { state: 'instalado', command: undefined });
  await write(runs(path.join(dev, 'bin/agent-toolkit-mcp.js')));
  assert.deepEqual(await check(), { state: 'otra-copia', command: undefined });
  await write({ command: 'python', args: ['server.py'] });
  assert.deepEqual(await check(), { state: 'conflicto', command: undefined });
  await write(runs(path.join(f.root, '.npm/_npx/zz/node_modules/nexakit/bin/agent-toolkit-mcp.js')));
  assert.deepEqual(await check(), { state: 'efimero', command: `claude mcp remove agent-toolkit-workflow -s user && ${add}` });
  const dead = path.join(f.root, 'dead/bin/agent-toolkit-mcp.js');
  await write(runs(dead));
  assert.deepEqual(await check(), { state: 'roto-ajeno', command: undefined });
  await register(f.homeDirectory, [{ destino: 'mcp:claude:agent-toolkit-workflow', apunta: dead, raiz: path.join(f.root, 'dead') }]);
  assert.deepEqual(await check(), { state: 'roto-propio', command: `claude mcp remove agent-toolkit-workflow -s user && ${add}` });
  await fs.rm(config);
  assert.deepEqual(await check(), { state: 'falta', command: add });
});

test('a registration command is never suggested for a stable copy that does not exist yet', async t => {
  const f = await npxFixture(t), { setupToolkit } = await import(moduleUrl);
  const options = { homeDirectory: f.homeDirectory, toolkitRoot: f.ephemeral, agent: 'claude', environment: { PATH: '' }, runNpm: f.npm };
  const preview = await setupToolkit(options);
  assert.deepEqual([preview.mcp.registrationCommands, preview.mcp.registrationPending], [{}, ['claude']]);
  const applied = await setupToolkit({ ...options, apply: true });
  assert.match(applied.mcp.registrationCommands.claude, /\.nexakit[\\/]actual[\\/]bin[\\/]agent-toolkit-mcp\.js/u);
  assert.equal(applied.mcp.registrationPending, undefined);
});

// A lock that is lost after `keep` checks, to prove each write checks it first.
const losingLock = keep => {
  let checks = 0;
  return async () => ({ token: 'x', release: async () => {}, assertHeld: async () => { if (++checks > keep) throw Object.assign(new Error('perdido'), { code: 'perdido' }); } });
};

test('setup checks it still holds the lock right before writing each link', async t => {
  const f = await fixture(t), { setupToolkit } = await import(moduleUrl);
  await fs.mkdir(path.join(f.toolkitRoot, 'skills', 'b'));
  await fs.writeFile(path.join(f.toolkitRoot, 'skills', 'b', 'SKILL.md'), 'x');
  await assert.rejects(setupToolkit({ ...f, agent: 'claude', apply: true, environment: { PATH: '' }, acquire: losingLock(1) }), { code: 'perdido' });
  assert.deepEqual(await fs.readdir(path.join(f.homeDirectory, '.claude/skills')), ['b'], 'only the link written while the lock was held');
});

test('the node registered for the MCP is never one inside an npx cache', async t => {
  const f = await fixture(t), { resolveNodeExecutable } = await import(moduleUrl);
  const ephemeral = path.join(f.root, '.npm/_npx/abc/node_modules/.bin'), stable = path.join(f.root, 'bin');
  for (const dir of [ephemeral, stable]) {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'node'), '', { mode: 0o755 });
  }
  assert.equal(await resolveNodeExecutable({ PATH: [ephemeral, stable].join(path.delimiter) }), path.join(stable, 'node'));
  assert.equal(await resolveNodeExecutable({ PATH: ephemeral }), process.execPath, 'falls back to the node running nexakit when it is not ephemeral');
});

test('a node reached through a link into an npx cache is not registered either', async t => {
  const f = await fixture(t), { resolveNodeExecutable } = await import(moduleUrl);
  const cached = path.join(f.root, '.npm/_npx/abc/node_modules/.bin/node');
  await fs.mkdir(path.dirname(cached), { recursive: true });
  await fs.writeFile(cached, '', { mode: 0o755 });
  const viaLink = path.join(f.root, 'enlace'), stable = path.join(f.root, 'estable');
  await fs.mkdir(viaLink);
  await fs.mkdir(stable);
  await fs.symlink(cached, path.join(viaLink, 'node'));
  await fs.writeFile(path.join(stable, 'node'), '', { mode: 0o755 });
  assert.equal(await resolveNodeExecutable({ PATH: [viaLink, stable].join(path.delimiter) }), path.join(stable, 'node'));
});
test('retired skills are removed only when registered and unchanged', async t => {
 const f=await fixture(t);const { setupToolkit }=await import(moduleUrl);
 const target=path.join(f.homeDirectory,'.agents','skills','programar');await fs.mkdir(path.dirname(target),{recursive:true});
 const source=path.join(f.toolkitRoot,'skills','gone');await fs.symlink(source,target,directoryLinkType);
 const { acquireLock }=await import(lockUrl);const { recordEntries }=await import(registryUrl);
 const lock=await acquireLock(path.join(f.homeDirectory,'.nexakit'));
 try {await recordEntries(path.join(f.homeDirectory,'.nexakit'),[{destino:target,apunta:await fs.readlink(target),raiz:f.toolkitRoot}],lock);}finally{await lock.release();}
 await fs.mkdir(path.join(f.homeDirectory,'.agents','skills','estado'));
 const preview=await setupToolkit({...f,agent:'codex',environment:{PATH:''}});
 assert.equal(preview.retiredSkills.find(s=>s.name==='programar').owned,true);
 assert.equal(preview.conflicts,1);
 await setupToolkit({...f,agent:'codex',apply:true,environment:{PATH:''}});
 await assert.rejects(fs.lstat(target));assert.ok((await fs.stat(path.join(f.homeDirectory,'.agents','skills','estado'))).isDirectory());
});

test('doctor reads Superpowers from each agent found, through the given runner', async t => {
  const f = await fixture(t), { doctorToolkit } = await import(moduleUrl);
  const bin = path.join(f.root, 'bin');
  await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, process.platform === 'win32' ? 'codex.cmd' : 'codex'), '', { mode: 0o755 });
  const calls = [];
  const runCommand = (command, args) => {
    calls.push([command, ...args].join(' '));
    return { status: 0, stdout: 'superpowers@openai-curated-remote   not installed   7.0.1   id\n', stderr: '' };
  };
  const result = await doctorToolkit({ ...f, agent: 'codex', environment: { PATH: bin, PATHEXT: '.EXE;.CMD' }, runCommand });
  assert.deepEqual(result.superpowers.states, { codex: 'falta' });
  assert.deepEqual(calls, ['codex plugin list']);
});
test('the skills now covered by Superpowers are retired like the old commands', async t => {
  const f = await fixture(t); const { setupToolkit, RETIRED_SKILLS } = await import(moduleUrl);
  assert.deepEqual(RETIRED_SKILLS.slice(2), ['spec-driven-development', 'depurar', 'desarrollo-con-pruebas']);
  const target = path.join(f.homeDirectory, '.claude', 'skills', 'depurar'); await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.symlink(path.join(f.toolkitRoot, 'skills', 'depurar'), target, directoryLinkType);
  const { acquireLock } = await import(lockUrl); const { recordEntries } = await import(registryUrl);
  const lock = await acquireLock(path.join(f.homeDirectory, '.nexakit'));
  try { await recordEntries(path.join(f.homeDirectory, '.nexakit'), [{ destino: target, apunta: await fs.readlink(target), raiz: f.toolkitRoot }], lock); } finally { await lock.release(); }
  const preview = await setupToolkit({ ...f, agent: 'claude', environment: { PATH: '' } });
  assert.equal(preview.retiredSkills.find(s => s.name === 'depurar').owned, true);
  await setupToolkit({ ...f, agent: 'claude', apply: true, environment: { PATH: '' } });
  await assert.rejects(fs.lstat(target));
});
test('a retired skill linked into a nexakit copy before the registry existed is still nexakit\'s', async t => {
  const f = await fixture(t); const { setupToolkit } = await import(moduleUrl);
  await fs.writeFile(path.join(f.toolkitRoot, 'package.json'), JSON.stringify({ name: 'nexakit', version: '0.1.0' }));
  const old = path.join(f.homeDirectory, '.claude', 'skills', 'desarrollo-con-pruebas'); await fs.mkdir(path.dirname(old), { recursive: true });
  await fs.symlink(path.join(f.toolkitRoot, 'skills', 'desarrollo-con-pruebas'), old, directoryLinkType);
  const foreignRoot = path.join(f.root, 'otro'); await fs.mkdir(path.join(foreignRoot, 'skills'), { recursive: true });
  await fs.writeFile(path.join(foreignRoot, 'package.json'), JSON.stringify({ name: 'otro-paquete' }));
  const foreign = path.join(f.homeDirectory, '.claude', 'skills', 'depurar');
  await fs.symlink(path.join(foreignRoot, 'skills', 'depurar'), foreign, directoryLinkType);
  const preview = await setupToolkit({ ...f, agent: 'claude', environment: { PATH: '' } });
  assert.equal(preview.retiredSkills.find(s => s.name === 'desarrollo-con-pruebas').owned, true, 'unregistered, but inside a nexakit copy');
  assert.equal(preview.retiredSkills.find(s => s.name === 'depurar').owned, false, 'a link into another package is not ours');
  await setupToolkit({ ...f, agent: 'claude', apply: true, environment: { PATH: '' } });
  await assert.rejects(fs.lstat(old));
  assert.equal((await fs.lstat(foreign)).isSymbolicLink(), true, 'the foreign link is left alone');
});
