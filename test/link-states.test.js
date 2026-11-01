import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const moduleUrl = new URL('../src/link-states.js', import.meta.url);
const directoryLinkType = process.platform === 'win32' ? 'junction' : 'dir';

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'link-states-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const links = path.join(root, 'links');
  await fs.mkdir(links);
  return { root, links, target: name => path.join(links, name) };
}

async function makeCopy(dir, name = 'nexakit') {
  for (const folder of ['skills/example', 'catalogs/skills/catalogada', 'bin']) {
    await fs.mkdir(path.join(dir, folder), { recursive: true });
  }
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name }));
  await fs.writeFile(path.join(dir, 'skills/example/SKILL.md'), 'x');
  await fs.writeFile(path.join(dir, 'catalogs/skills/catalogada/SKILL.md'), 'x');
  await fs.writeFile(path.join(dir, 'bin/agent-toolkit-mcp.js'), '');
  return dir;
}

const link = (to, at) => fs.symlink(to, at, directoryLinkType);

test('classifies every state in spec order', async t => {
  const f = await fixture(t), { classifyLink } = await import(moduleUrl);
  const suffix = 'skills/example';
  const active = await makeCopy(path.join(f.root, 'active'));
  const dev = await makeCopy(path.join(f.root, 'dev'));
  const cache = await makeCopy(path.join(f.root, 'home/.npm/_npx/abc/node_modules/nexakit'));
  const deadCache = path.join(f.root, 'old/.npm/_npx/zzz/node_modules/nexakit');
  const dead = path.join(f.root, 'dead');
  const owned = { value: true };
  const run = name => classifyLink({ target: f.target(name), suffix, activeRoots: [active], isOwned: () => owned.value });

  assert.equal((await run('falta')).state, 'falta');

  await fs.mkdir(f.target('conflicto'));
  assert.equal((await run('conflicto')).state, 'conflicto');

  await link(path.join(cache, suffix), f.target('efimero-existe'));
  assert.equal((await run('efimero-existe')).state, 'efimero');
  await link(path.join(deadCache, suffix), f.target('efimero-borrada'));
  const gone = await run('efimero-borrada');
  assert.equal(gone.state, 'efimero');
  assert.equal(gone.root, deadCache);

  await link(path.join(active, suffix), f.target('instalado'));
  assert.equal((await run('instalado')).state, 'instalado');

  await link(path.join(dev, suffix), f.target('otra-copia'));
  const other = await run('otra-copia');
  assert.equal(other.state, 'otra-copia');
  assert.equal(other.root, dev);

  await link(path.join(dead, suffix), f.target('roto-propio'));
  assert.equal((await run('roto-propio')).state, 'roto-propio');

  owned.value = false;
  const foreign = await run('roto-propio');
  assert.equal(foreign.state, 'roto-ajeno');
  assert.equal(foreign.root, dead);
  assert.equal(foreign.literal, path.join(dead, suffix));
});

test('ephemeral wins over installed when running from the same cache', async t => {
  const f = await fixture(t), { classifyLink } = await import(moduleUrl);
  const cache = await makeCopy(path.join(f.root, 'home/.npm/_npx/abc/node_modules/nexakit'));
  await link(path.join(cache, 'skills/example'), f.target('misma-cache'));
  const result = await classifyLink({ target: f.target('misma-cache'), suffix: 'skills/example', activeRoots: [cache], isOwned: () => false });
  assert.equal(result.state, 'efimero');
});

test('recognizes the catalog layout and rejects the wrong suffix', async t => {
  const f = await fixture(t), { classifyLink } = await import(moduleUrl);
  const dev = await makeCopy(path.join(f.root, 'dev'));
  await link(path.join(dev, 'catalogs/skills/catalogada'), f.target('catalogada'));
  const good = await classifyLink({ target: f.target('catalogada'), suffix: 'catalogs/skills/catalogada', activeRoots: [], isOwned: () => false });
  assert.equal(good.state, 'otra-copia');
  assert.equal(good.root, dev);
  const bad = await classifyLink({ target: f.target('catalogada'), suffix: 'skills/catalogada', activeRoots: [], isOwned: () => false });
  assert.equal(bad.state, 'conflicto');
});

test('a package that is not nexakit is a conflict, even with the right layout', async t => {
  const f = await fixture(t), { classifyLink } = await import(moduleUrl);
  const foreign = await makeCopy(path.join(f.root, 'foreign'), 'otra-cosa');
  await link(path.join(foreign, 'skills/example'), f.target('ajena'));
  const result = await classifyLink({ target: f.target('ajena'), suffix: 'skills/example', activeRoots: [], isOwned: () => false });
  assert.equal(result.state, 'conflicto');
});

test('relative literals and links behind an alias are compared by resolved path', async t => {
  const f = await fixture(t), { classifyLink } = await import(moduleUrl);
  const suffix = 'skills/example';
  const cache = await makeCopy(path.join(f.root, 'home/.npm/_npx/abc/node_modules/nexakit'));
  await link(path.relative(f.links, path.join(cache, suffix)), f.target('relativo'));
  assert.equal((await classifyLink({ target: f.target('relativo'), suffix, activeRoots: [], isOwned: () => false })).state, 'efimero');

  const active = await makeCopy(path.join(f.root, 'active'));
  await link(active, path.join(f.root, 'alias'));
  await link(path.join(f.root, 'alias', suffix), f.target('por-alias'));
  assert.equal((await classifyLink({ target: f.target('por-alias'), suffix, activeRoots: [active], isOwned: () => false })).state, 'instalado');

  const deadRelative = path.relative(f.links, path.join(f.root, 'muerta', suffix));
  await link(deadRelative, f.target('roto-relativo'));
  const broken = await classifyLink({ target: f.target('roto-relativo'), suffix, activeRoots: [], isOwned: () => false });
  assert.equal(broken.state, 'roto-ajeno');
  assert.equal(broken.root, path.join(f.root, 'muerta'));
});

test('chooseActiveRoot picks the majority other copy and never an ephemeral root', async t => {
  const { chooseActiveRoot } = await import(moduleUrl);
  const dev = '/work/nexakit', cache = '/home/.npm/_npx/abc/node_modules/nexakit';
  assert.equal(chooseActiveRoot([
    { state: 'otra-copia', root: dev }, { state: 'otra-copia', root: dev }, { state: 'instalado' }
  ], '/stable'), dev);
  assert.equal(chooseActiveRoot([
    { state: 'otra-copia', root: dev }, { state: 'falta' }, { state: 'falta' }
  ], '/stable'), '/stable');
  assert.equal(chooseActiveRoot([
    { state: 'otra-copia', root: cache }, { state: 'otra-copia', root: cache }, { state: 'otra-copia', root: cache }
  ], '/stable'), '/stable');
  assert.equal(chooseActiveRoot([], '/stable'), '/stable');
});

test('legacyGroups groups dead links by root with threshold 3 or the MCP root', async t => {
  const { legacyGroups } = await import(moduleUrl);
  const skillNames = new Set(['alfa', 'beta', 'gamma']);
  const dead = name => ({ state: 'roto-ajeno', root: '/old/Agent-Toolkit', target: `/home/.claude/skills/${name}` });
  assert.deepEqual(legacyGroups([dead('alfa'), dead('beta'), dead('gamma')], { skillNames }),
    [{ root: '/old/Agent-Toolkit', targets: ['/home/.claude/skills/alfa', '/home/.claude/skills/beta', '/home/.claude/skills/gamma'] }]);
  assert.deepEqual(legacyGroups([dead('alfa'), dead('beta')], { skillNames }), []);
  assert.equal(legacyGroups([dead('alfa'), dead('beta')], { skillNames, mcpDeadRoot: '/old/Agent-Toolkit' }).length, 1);
  assert.deepEqual(legacyGroups([dead('alfa'), dead('beta'), dead('mia')], { skillNames }), []);
  assert.deepEqual(legacyGroups([{ state: 'roto-propio', root: '/old/Agent-Toolkit', target: '/x/alfa' }, dead('beta'), dead('gamma')], { skillNames }), []);
});

test('relinkIfUnchanged repoints a link that still has the expected literal', async t => {
  const f = await fixture(t), { relinkIfUnchanged } = await import(moduleUrl);
  const next = await makeCopy(path.join(f.root, 'next'));
  const old = path.join(f.root, 'gone', 'skills/example');
  await link(old, f.target('x'));
  assert.equal(await relinkIfUnchanged({ target: f.target('x'), expectedLiteral: old, source: path.join(next, 'skills/example') }), 'hecho');
  assert.equal(await fs.realpath(f.target('x')), path.join(next, 'skills/example'));
  assert.deepEqual((await fs.readdir(f.links)).sort(), ['x']);
});

test('relinkIfUnchanged refuses when the link changed and leaves it alone', async t => {
  const f = await fixture(t), { relinkIfUnchanged } = await import(moduleUrl);
  const next = await makeCopy(path.join(f.root, 'next'));
  const other = await makeCopy(path.join(f.root, 'other'));
  const old = path.join(f.root, 'gone', 'skills/example');
  await link(old, f.target('x'));
  await fs.rm(f.target('x'));
  await link(path.join(other, 'skills/example'), f.target('x'));
  assert.equal(await relinkIfUnchanged({ target: f.target('x'), expectedLiteral: old, source: path.join(next, 'skills/example') }), 'cambio');
  assert.equal(await fs.realpath(f.target('x')), path.join(other, 'skills/example'));

  await fs.mkdir(f.target('real'));
  await fs.writeFile(path.join(f.target('real'), 'mio'), 'keep');
  assert.equal(await relinkIfUnchanged({ target: f.target('real'), expectedLiteral: old, source: path.join(next, 'skills/example') }), 'cambio');
  assert.equal(await fs.readFile(path.join(f.target('real'), 'mio'), 'utf8'), 'keep');
  assert.equal(await relinkIfUnchanged({ target: f.target('real'), expectedLiteral: null, source: path.join(next, 'skills/example') }), 'cambio');
  assert.equal(await relinkIfUnchanged({ target: f.target('nada'), expectedLiteral: old, source: path.join(next, 'skills/example') }), 'cambio');
});

test('relinkIfUnchanged with a null literal only creates a link that does not exist yet', async t => {
  const f = await fixture(t), { relinkIfUnchanged } = await import(moduleUrl);
  const next = await makeCopy(path.join(f.root, 'next'));
  assert.equal(await relinkIfUnchanged({ target: f.target('nuevo'), expectedLiteral: null, source: path.join(next, 'skills/example') }), 'hecho');
  assert.equal(await fs.realpath(f.target('nuevo')), path.join(next, 'skills/example'));
});
