import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fakeNpm, writeFakeInstall } from '../test-support/fake-npm.js';

const moduleUrl = new URL('../src/stable-install.js', import.meta.url);
const lockUrl = new URL('../src/install-lock.js', import.meta.url);
const held = { assertHeld: async () => {} };
const lostError = () => Object.assign(new Error('perdido'), { code: 'perdido' });
const exists = file => fs.lstat(file).then(() => true, () => false);

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'stable-install-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  await fs.mkdir(home);
  const base = path.join(home, '.nexakit');
  return { root, home, base, version: v => path.join(base, 'versiones', v), staging: path.join(base, 'preparacion') };
}
const install = (f, mod, npm, version = '9.9.9', lock = held) =>
  mod.ensureStableInstall({ homeDirectory: f.home, version, lock, runNpm: npm, packageSpec: `nexakit@${version}` });

test('paths and version comparison', async () => {
  const { nexakitDir, actualRoot, compareVersions } = await import(moduleUrl);
  assert.equal(nexakitDir('/h'), path.join('/h', '.nexakit'));
  assert.equal(actualRoot('/h'), path.join('/h', '.nexakit', 'actual'));
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
  assert.equal(compareVersions('0.1.0', '0.1.1'), -1);
  assert.equal(compareVersions('2.0.0', '10.0.0'), -1);
  assert.equal(compareVersions('1.0.0-beta.1', '1.0.0'), -1);
  assert.equal(compareVersions('1.0.0', '1.0.0-beta.1'), 1);
  assert.equal(compareVersions('no-es-version', '1.0.0'), 0);
});

test('npmInvocation prefers the npm that launched us and never goes through a shell shim', async () => {
  const { npmInvocation } = await import(moduleUrl);
  const withNpm = { npm_execpath: path.resolve('/x/npm/bin/npm-cli.js'), npm_node_execpath: path.resolve('/n/bin/node') };
  assert.deepEqual(npmInvocation(['install'], { environment: withNpm, platform: 'linux' }),
    { command: path.resolve('/n/bin/node'), args: [path.resolve('/x/npm/bin/npm-cli.js'), 'install'] });
  assert.deepEqual(npmInvocation(['install'], { environment: {}, platform: 'linux' }), { command: 'npm', args: ['install'] });
  assert.equal(npmInvocation(['install'], { environment: {}, platform: 'win32' }), null);
  assert.deepEqual(npmInvocation(['install'], { environment: { npm_execpath: 'npm.cmd' }, platform: 'linux' }), { command: 'npm', args: ['install'] });
  assert.equal(npmInvocation(['install'], { environment: { npm_execpath: 'npm-cli.js' }, platform: 'win32' }), null);
});

test('installs, validates, publishes and points actual at the package root', async t => {
  const f = await fixture(t), mod = await import(moduleUrl), npm = fakeNpm();
  const result = await install(f, mod, npm);
  assert.deepEqual(result, { root: mod.actualRoot(f.home), version: '9.9.9', reused: false, pointer: 'movido' });
  assert.equal(await exists(path.join(f.version('9.9.9'), '.completa')), true);
  assert.equal(await fs.realpath(mod.actualRoot(f.home)), path.join(f.version('9.9.9'), 'node_modules', 'nexakit'));
  assert.equal(await mod.readActualVersion(f.home), '9.9.9');
  assert.deepEqual(await fs.readdir(f.staging), []);
  assert.deepEqual(npm.calls[0].slice(0, 2), ['install', '--prefix']);
  assert.deepEqual(npm.calls[0].slice(3), ['--no-audit', '--no-fund', 'nexakit@9.9.9']);
});

test('reuses a complete version without calling npm', async t => {
  const f = await fixture(t), mod = await import(moduleUrl);
  await install(f, mod, fakeNpm());
  const never = () => { throw new Error('npm no debe llamarse'); };
  const again = await install(f, mod, never);
  assert.deepEqual(again, { root: mod.actualRoot(f.home), version: '9.9.9', reused: true, pointer: 'igual' });
});

test('a complete version that was damaged afterwards is reported, not touched', async t => {
  const f = await fixture(t), mod = await import(moduleUrl);
  await install(f, mod, fakeNpm());
  await fs.rm(path.join(f.version('9.9.9'), 'node_modules/nexakit/bin/agent-toolkit-mcp.js'));
  await assert.rejects(install(f, mod, () => { throw new Error('npm no debe llamarse'); }),
    error => error.name === 'StableInstallError' && error.message.includes('agent-toolkit-mcp.js'));
  assert.equal(await exists(path.join(f.version('9.9.9'), '.completa')), true);
});

test('an npm failure keeps the previous version intact and leaves nothing behind', async t => {
  const f = await fixture(t), mod = await import(moduleUrl);
  await install(f, mod, fakeNpm({ version: '9.9.8' }), '9.9.8');
  await assert.rejects(install(f, mod, fakeNpm({ fail: true })),
    error => error.name === 'StableInstallError' && error.message.includes('fallo simulado'));
  assert.equal(await exists(f.version('9.9.9')), false);
  assert.equal(await mod.readActualVersion(f.home), '9.9.8');
  assert.deepEqual(await fs.readdir(f.staging), []);
});

test('a version that fails validation is discarded, whichever part is wrong', async t => {
  const mod = await import(moduleUrl);
  for (const broken of ['bin', 'dependencia', 'version', 'skill']) {
    const f = await fixture(t);
    await install(f, mod, fakeNpm({ version: '9.9.8' }), '9.9.8');
    await assert.rejects(install(f, mod, fakeNpm({ broken })), error => error.name === 'StableInstallError', broken);
    assert.equal(await exists(f.version('9.9.9')), false, broken);
    assert.equal(await mod.readActualVersion(f.home), '9.9.8', broken);
    assert.deepEqual(await fs.readdir(f.staging), [], broken);
  }
});

test('never moves actual backwards and does not even install the older version', async t => {
  const f = await fixture(t), mod = await import(moduleUrl);
  await install(f, mod, fakeNpm({ version: '10.0.0' }), '10.0.0');
  const older = fakeNpm();
  const result = await install(f, mod, older, '9.9.9');
  assert.deepEqual(result, { root: mod.actualRoot(f.home), version: '10.0.0', reused: true, pointer: 'mayor-conservado' });
  assert.equal(older.calls.length, 0);
  assert.equal(await exists(f.version('9.9.9')), false);
  assert.equal(await mod.readActualVersion(f.home), '10.0.0');
});

test('moves actual forward to a newer version', async t => {
  const f = await fixture(t), mod = await import(moduleUrl);
  await install(f, mod, fakeNpm({ version: '9.9.8' }), '9.9.8');
  const result = await install(f, mod, fakeNpm(), '9.9.9');
  assert.equal(result.pointer, 'movido');
  assert.equal(await mod.readActualVersion(f.home), '9.9.9');
  assert.equal(await exists(f.version('9.9.8')), true, 'the old version is kept');
});

test('occupied nexakit paths are conflicts that change nothing', async t => {
  const mod = await import(moduleUrl);
  const cases = {
    'a file instead of ~/.nexakit': async f => fs.writeFile(f.base, 'mio'),
    'a file instead of versiones': async f => { await fs.mkdir(f.base); await fs.writeFile(path.join(f.base, 'versiones'), 'mio'); },
    'a file instead of preparacion': async f => { await fs.mkdir(f.base); await fs.writeFile(path.join(f.base, 'preparacion'), 'mio'); },
    'a real folder instead of actual': async f => { await fs.mkdir(path.join(f.base, 'actual'), { recursive: true }); await fs.writeFile(path.join(f.base, 'actual/mio'), 'mio'); },
    '~/.nexakit as a link': async f => { await fs.mkdir(path.join(f.root, 'otro')); await fs.symlink(path.join(f.root, 'otro'), f.base); }
  };
  for (const [name, setup] of Object.entries(cases)) {
    const f = await fixture(t), npm = fakeNpm();
    await setup(f);
    await assert.rejects(install(f, mod, npm), error => error.name === 'StableInstallError', name);
    assert.equal(npm.calls.length, 0, `${name}: npm was not called`);
    assert.equal(await exists(f.version('9.9.9')), false, name);
  }
});

test('refuses to run without the lock, and losing it midway publishes nothing', async t => {
  const f = await fixture(t), mod = await import(moduleUrl), npm = fakeNpm();
  const lost = { assertHeld: async () => { throw lostError(); } };
  await assert.rejects(install(f, mod, npm, '9.9.9', lost), { code: 'perdido' });
  assert.equal(npm.calls.length, 0);
  assert.equal(await exists(f.base), false, 'nothing was created');

  let calls = 0;
  const losesBeforePublishing = { assertHeld: async () => { if (++calls > 1) throw lostError(); } };
  await assert.rejects(install(f, mod, fakeNpm(), '9.9.9', losesBeforePublishing), { code: 'perdido' });
  assert.equal(await exists(f.version('9.9.9')), false);
  assert.deepEqual(await fs.readdir(f.staging), []);
});

test('losing the lock right before the pointer move leaves a complete version and no pointer', async t => {
  const f = await fixture(t), mod = await import(moduleUrl);
  let calls = 0;
  const losesBeforePointer = { assertHeld: async () => { if (++calls > 2) throw lostError(); } };
  await assert.rejects(install(f, mod, fakeNpm(), '9.9.9', losesBeforePointer), { code: 'perdido' });
  assert.equal(await exists(path.join(f.version('9.9.9'), '.completa')), true);
  assert.equal(await exists(mod.actualRoot(f.home)), false);
  assert.deepEqual((await fs.readdir(f.base)).sort(), ['preparacion', 'versiones']);
  const next = await install(f, mod, () => { throw new Error('npm no debe llamarse'); });
  assert.deepEqual([next.reused, next.pointer], [true, 'movido']);
});

test('two runs at once leave one complete version, the second one reuses it', async t => {
  const f = await fixture(t), mod = await import(moduleUrl), { acquireLock } = await import(lockUrl), npm = fakeNpm();
  const run = async () => {
    const lock = await acquireLock(f.base, { waitMs: 10_000, pollMs: 5 });
    try { return await install(f, mod, npm, '9.9.9', lock); } finally { await lock.release(); }
  };
  const results = await Promise.all([run(), run()]);
  assert.deepEqual(results.map(result => result.reused).sort(), [false, true]);
  assert.equal(npm.calls.length, 1);
  assert.equal(await mod.readActualVersion(f.home), '9.9.9');
  assert.deepEqual((await fs.readdir(f.base)).sort(), ['actual', 'preparacion', 'versiones']);
});

test('a stable copy deleted by hand is rebuilt; a pointer that dangled works again or is replaced', async t => {
  const f = await fixture(t), mod = await import(moduleUrl), npm = fakeNpm();
  await install(f, mod, npm);
  await fs.rm(path.join(f.base, 'versiones'), { recursive: true });
  assert.equal(await mod.readActualVersion(f.home), null, 'actual dangles');
  // Same version again: the dangling pointer already names the rebuilt folder, so it is left as it is.
  const same = await install(f, mod, npm);
  assert.deepEqual([same.reused, same.pointer], [false, 'igual']);
  assert.equal(npm.calls.length, 2);
  assert.equal(await mod.readActualVersion(f.home), '9.9.9');

  // A newer version while the pointer dangles toward a deleted older one: the pointer is replaced.
  await fs.rm(path.join(f.base, 'versiones'), { recursive: true });
  assert.equal(await mod.readActualVersion(f.home), null);
  const newer = await install(f, mod, fakeNpm({ version: '9.9.10' }), '9.9.10');
  assert.deepEqual([newer.reused, newer.pointer], [false, 'movido']);
  assert.equal(await mod.readActualVersion(f.home), '9.9.10');
});

test('stale staging folders from a crashed run are cleared under the lock', async t => {
  const f = await fixture(t), mod = await import(moduleUrl);
  await fs.mkdir(path.join(f.staging, '9.9.7-vieja', 'node_modules'), { recursive: true });
  await install(f, mod, fakeNpm());
  assert.deepEqual(await fs.readdir(f.staging), []);
});

test('the version is validated before it becomes part of a path', async t => {
  const f = await fixture(t), mod = await import(moduleUrl), npm = fakeNpm();
  for (const bad of ['../../x', '1.2', '1.2.3/../x', '', 'latest', 123]) {
    await assert.rejects(install(f, mod, npm, bad), error => error.name === 'StableInstallError', String(bad));
  }
  assert.equal(npm.calls.length, 0);
  assert.equal(await exists(f.base), false);
});

test('validatePackageRoot accepts a good install and names what is wrong with a bad one', async t => {
  const f = await fixture(t), { validatePackageRoot } = await import(moduleUrl);
  const good = await writeFakeInstall(path.join(f.root, 'bueno'), { version: '1.2.3' });
  await validatePackageRoot(good, '1.2.3');
  const reasons = { bin: /agent-toolkit-mcp\.js/u, dependencia: /dependencias/u, version: /0\.0\.1/u, skill: /SKILL\.md/u };
  for (const [broken, pattern] of Object.entries(reasons)) {
    const root = await writeFakeInstall(path.join(f.root, `malo-${broken}`), { version: '1.2.3', broken });
    await assert.rejects(validatePackageRoot(root, '1.2.3'), error => error.name === 'StableInstallError' && pattern.test(error.message), broken);
  }
  const foreign = await writeFakeInstall(path.join(f.root, 'ajeno'), { version: '1.2.3', name: 'otra-cosa' });
  await assert.rejects(validatePackageRoot(foreign, '1.2.3'), /no es nexakit/u);
  await assert.rejects(validatePackageRoot(path.join(f.root, 'no-existe'), '1.2.3'), { name: 'StableInstallError' });
});

test('replacing the pointer the Windows way never loses it, even when the second rename fails', async t => {
  const f = await fixture(t), { replacePointer } = await import(moduleUrl);
  const dirType = process.platform === 'win32' ? 'junction' : 'dir';
  const setup = async () => {
    const v1 = path.join(f.root, 'v1'), v2 = path.join(f.root, 'v2'), actual = path.join(f.root, 'actual'), temporary = path.join(f.root, 'actual.nuevo');
    for (const dir of [v1, v2]) await fs.mkdir(dir, { recursive: true });
    await fs.rm(actual, { force: true });
    await fs.rm(temporary, { force: true });
    await fs.symlink(v1, actual, dirType);
    await fs.symlink(v2, temporary, dirType);
    return { v1, v2, actual, temporary };
  };
  const failing = plan => {
    let call = 0;
    return async (from, to) => {
      const outcome = plan[call++];
      if (outcome) throw Object.assign(new Error(outcome), { code: outcome });
      return fs.rename(from, to);
    };
  };
  const leftovers = async () => (await fs.readdir(f.root)).filter(name => name.startsWith('actual.anterior'));

  // Rename over the link refused, then the second rename fails: the old pointer is put back.
  let p = await setup();
  await assert.rejects(replacePointer(p.temporary, p.actual, { windows: true, rename: failing(['EPERM', null, 'EIO', null]) }), { code: 'EIO' });
  assert.equal(await fs.readlink(p.actual), p.v1);
  assert.deepEqual(await leftovers(), []);

  // Rename over the link refused, the rest works: the pointer moves and nothing is left aside.
  p = await setup();
  await replacePointer(p.temporary, p.actual, { windows: true, rename: failing(['EPERM']) });
  assert.equal(await fs.readlink(p.actual), p.v2);
  assert.deepEqual(await leftovers(), []);

  // Elsewhere a refused rename is an error and nothing is moved aside.
  p = await setup();
  await assert.rejects(replacePointer(p.temporary, p.actual, { windows: false, rename: failing(['EPERM']) }), { code: 'EPERM' });
  assert.equal(await fs.readlink(p.actual), p.v1);
});
