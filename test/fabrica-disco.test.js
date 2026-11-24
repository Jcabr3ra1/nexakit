import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { instantanea as snapshotRevision, comparar as compareRevisionSnapshots } from '../dist/fabrica/disco.js';
import { fileSymlinkSkipReason } from '../testing/symlink-capability.js';

test('snapshot includes ignored and hidden files, records module entries and skips git and detects changes', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'revision-snap-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, '.git'));
  await fs.mkdir(path.join(root, 'node_modules'));
  await fs.writeFile(path.join(root, '.git', 'config'), 'secret');
  await fs.writeFile(path.join(root, 'node_modules', 'dep'), 'dependency');
  await fs.writeFile(path.join(root, '.hidden'), 'hidden');
  await fs.writeFile(path.join(root, 'ignored'), 'old');
  const before = await snapshotRevision(root);
  assert.deepEqual([...before.keys()].sort(), ['.hidden', 'ignored', 'node_modules/dep']);
  await fs.unlink(path.join(root, '.hidden'));
  await fs.writeFile(path.join(root, 'ignored'), 'longer now');
  await fs.writeFile(path.join(root, 'new file'), 'new');
  assert.deepEqual(compareRevisionSnapshots(before, await snapshotRevision(root)), [
    '.hidden',
    'ignored',
    'new file',
  ]);
});

test(
  'snapshot never follows an external symlink and accepts a git file in a worktree',
  { skip: process.platform === 'win32' || fileSymlinkSkipReason() },
  async (t) => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'revision-links-'));
    t.after(() => fs.rm(base, { recursive: true, force: true }));
    const root = path.join(base, 'repo');
    await fs.mkdir(root);
    await fs.writeFile(path.join(base, 'outside'), 'outside');
    await fs.symlink(path.join(base, 'outside'), path.join(root, 'link'));
    await fs.writeFile(path.join(root, '.git'), 'gitdir: elsewhere');
    const first = await snapshotRevision(root);
    await fs.writeFile(path.join(base, 'outside'), 'external content changed');
    assert.deepEqual(compareRevisionSnapshots(first, await snapshotRevision(root)), []);
    assert.equal(first.get('link').kind, 'symlink');
    assert.equal(first.has('.git'), false);
  },
);

// Reviewers must not be able to hide Git mutations behind an unchanged tree.
import { execFileSync } from 'node:child_process';
const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
async function gitRepo(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'revision-git-snap-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.invalid');
  git(root, 'config', 'user.name', 'Test');
  await fs.writeFile(path.join(root, 'tracked'), 'original');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'base');
  return root;
}
test('snapshot detects a reviewer commit even when working files do not change', async (t) => {
  const root = await gitRepo(t);
  const before = await snapshotRevision(root);
  git(root, 'commit', '--allow-empty', '-qm', 'reviewer commit');
  const changes = compareRevisionSnapshots(before, await snapshotRevision(root));
  assert.ok(changes.includes('.git/HEAD'));
  assert.ok(changes.includes('.git/refs'));
});
test('snapshot detects add and checkout, including a linked worktree index', async (t) => {
  const root = await gitRepo(t);
  const other = path.join(root, '..', path.basename(root) + '-worktree');
  git(root, 'worktree', 'add', '-qb', 'review', other);
  t.after(() => fs.rm(other, { recursive: true, force: true }));
  await fs.writeFile(path.join(other, 'tracked'), 'modified');
  const before = await snapshotRevision(other);
  git(other, 'add', 'tracked');
  const after = await snapshotRevision(other);
  const changes = compareRevisionSnapshots(before, after);
  assert.ok(changes.includes('.git/index'));
  assert.ok(changes.includes('.git/status'));
  git(other, 'checkout', '--detach', '-q');
  assert.ok(compareRevisionSnapshots(after, await snapshotRevision(other)).includes('.git/HEAD'));
});

test('snapshot hashes tracked and untracked files even with same size and restored mtime', async (t) => {
  const root = await gitRepo(t);
  for (const name of ['tracked', 'untracked']) {
    const file = path.join(root, name);
    await fs.writeFile(file, 'AAAA');
    // Use an exactly representable timestamp on all platforms.
    await fs.utimes(file, 1700000000, 1700000000);
    const original = await fs.stat(file);
    const before = await snapshotRevision(root);
    await fs.writeFile(file, 'BBBB');
    await fs.utimes(file, original.atime, original.mtime);
    assert.ok(compareRevisionSnapshots(before, await snapshotRevision(root)).includes(name));
  }
});
test('snapshot notices first-level node_modules names and sizes without scanning dependencies', async (t) => {
  const root = await gitRepo(t);
  const modules = path.join(root, 'node_modules');
  await fs.mkdir(modules);
  await fs.writeFile(path.join(modules, 'entry'), 'small');
  const before = await snapshotRevision(root);
  await fs.writeFile(path.join(modules, 'entry'), 'larger content');
  await fs.mkdir(path.join(modules, 'new-package'));
  const changes = compareRevisionSnapshots(before, await snapshotRevision(root));
  assert.ok(changes.includes('node_modules/entry'));
  assert.ok(changes.includes('node_modules/new-package'));
});

test('Git ignored files keep metadata without content hashes; tracked ignored files remain hashed', async (t) => {
  const root = await gitRepo(t);
  await fs.writeFile(path.join(root, '.gitignore'), 'dist/\ntracked\n');
  await fs.mkdir(path.join(root, 'dist'));
  await fs.writeFile(path.join(root, 'dist', 'bundle'), 'ignored build');
  const before = await snapshotRevision(root);
  assert.equal(before.get('dist/bundle').sha256, undefined);
  assert.equal(typeof before.get('tracked').sha256, 'string');
  await fs.writeFile(path.join(root, 'dist', 'bundle'), 'larger ignored build');
  assert.ok(compareRevisionSnapshots(before, await snapshotRevision(root)).includes('dist/bundle'));
});

test('snapshot watches .git/config, hooks (content and mode) and info, which run code outside any sandbox', async (t) => {
  const root = await gitRepo(t);
  await fs.mkdir(path.join(root, '.git', 'info'), { recursive: true });
  await fs.writeFile(path.join(root, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 0\n', { mode: 0o644 });
  const cases = [
    ['.git/config', () => fs.appendFile(path.join(root, '.git', 'config'), '[core]\n\tfsmonitor = ./x\n')],
    ['.git/hooks/pre-commit', () => fs.writeFile(path.join(root, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\ncurl x\n')],
    ['.git/hooks/post-checkout', () => fs.writeFile(path.join(root, '.git', 'hooks', 'post-checkout'), '#!/bin/sh\n')],
    ['.git/info/attributes', () => fs.writeFile(path.join(root, '.git', 'info', 'attributes'), '* filter=x\n')],
  ];
  if (process.platform !== 'win32') {
    cases.push(['.git/hooks/pre-commit', () => fs.chmod(path.join(root, '.git', 'hooks', 'pre-commit'), 0o755)]);
  }
  for (const [key, change] of cases) {
    const before = await snapshotRevision(root);
    assert.deepEqual(compareRevisionSnapshots(before, await snapshotRevision(root)), [], 'stable without changes');
    await change();
    assert.ok(compareRevisionSnapshots(before, await snapshotRevision(root)).includes(key), key);
  }
});

test('snapshot follows core.hooksPath and still watches the common hooks folder', async (t) => {
  const root = await gitRepo(t);
  const hooks = await fs.mkdtemp(path.join(os.tmpdir(), 'revision-hooks-'));
  t.after(() => fs.rm(hooks, { recursive: true, force: true }));
  git(root, 'config', 'core.hooksPath', hooks);
  const before = await snapshotRevision(root);
  await fs.writeFile(path.join(hooks, 'pre-push'), '#!/bin/sh\n');
  await fs.writeFile(path.join(root, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\n');
  const changes = compareRevisionSnapshots(before, await snapshotRevision(root));
  assert.ok(changes.includes('.git/hooks/pre-push'), changes.join(','));
  assert.ok(changes.includes('.git/hooks-comunes/pre-commit'), changes.join(','));
});

test('snapshot hashes package.json of first-level and scoped packages and node_modules files', async (t) => {
  const root = await gitRepo(t);
  const modules = path.join(root, 'node_modules');
  await fs.mkdir(path.join(modules, 'dep'), { recursive: true });
  await fs.mkdir(path.join(modules, '@scope', 'pkg'), { recursive: true });
  await fs.writeFile(path.join(modules, 'dep', 'package.json'), '{"name":"dep"}');
  await fs.writeFile(path.join(modules, '@scope', 'pkg', 'package.json'), '{"name":"@scope/pkg"}');
  await fs.writeFile(path.join(modules, '.package-lock.json'), '{"a":1}');
  const cases = [
    ['node_modules/dep', () => fs.writeFile(path.join(modules, 'dep', 'package.json'), '{"name":"evil"}')],
    ['node_modules/@scope/pkg', () => fs.writeFile(path.join(modules, '@scope', 'pkg', 'package.json'), '{"name":"evil"}')],
    ['node_modules/.package-lock.json', () => fs.writeFile(path.join(modules, '.package-lock.json'), '{"a":2}')],
    ['node_modules/@scope/new', () => fs.mkdir(path.join(modules, '@scope', 'new'))],
  ];
  for (const [key, change] of cases) {
    const before = await snapshotRevision(root);
    await change();
    assert.ok(compareRevisionSnapshots(before, await snapshotRevision(root)).includes(key), key);
  }
});

const SIN_ENLACES = process.platform === 'win32' || fileSymlinkSkipReason();
/** Carpeta temporal fuera del repo, para destinos de enlaces. */
async function carpetaExterna(t) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'revision-externa-')));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('snapshot watches .git/config.worktree: created, edited and removed', async (t) => {
  const root = await gitRepo(t);
  const archivo = path.join(root, '.git', 'config.worktree');
  const cases = [
    ['.git/config.worktree', () => fs.writeFile(archivo, '[core]\n\thooksPath = /tmp/x\n')],
    ['.git/config.worktree', () => fs.writeFile(archivo, '[core]\n\tfsmonitor = ./y\n')],
    ['.git/config.worktree', () => fs.rm(archivo)],
  ];
  for (const [key, change] of cases) {
    const before = await snapshotRevision(root);
    assert.deepEqual(compareRevisionSnapshots(before, await snapshotRevision(root)), [], 'stable without changes');
    await change();
    assert.ok(compareRevisionSnapshots(before, await snapshotRevision(root)).includes(key), key);
  }
});

test('snapshot watches config.worktree of a linked worktree (it lives in its own git dir)', async (t) => {
  const root = await gitRepo(t);
  const other = path.join(root, '..', `${path.basename(root)}-worktree`);
  git(root, 'worktree', 'add', '-qb', 'review', other);
  t.after(() => fs.rm(other, { recursive: true, force: true }));
  const before = await snapshotRevision(other);
  const propio = git(other, 'rev-parse', '--git-dir').trim();
  await fs.writeFile(path.resolve(other, propio, 'config.worktree'), '[core]\n\tfsmonitor = ./x\n');
  assert.ok(compareRevisionSnapshots(before, await snapshotRevision(other)).includes('.git/config.worktree'));
});

test('snapshot does not collapse a symlinked .git/config.worktree or .git/config to absent: link, target and target content are watched', { skip: SIN_ENLACES }, async (t) => {
  const root = await gitRepo(t);
  const fuera = await carpetaExterna(t);
  const destino = path.join(fuera, 'config-externa');
  const otro = path.join(fuera, 'otra-config');
  await fs.writeFile(destino, '[core]\n');
  await fs.writeFile(otro, '[core]\n');
  for (const nombre of ['config.worktree', 'config']) {
    const clave = `.git/${nombre}`;
    const enlace = path.join(root, '.git', nombre);
    const original = nombre === 'config' ? await fs.readFile(enlace) : null;
    // Crear el enlace durante el encargo (config.worktree no existía) o sustituir `config` por un enlace: se nota.
    let before = await snapshotRevision(root);
    if (nombre === 'config') {
      await fs.writeFile(destino, original);
      await fs.rm(enlace);
    }
    await fs.symlink(destino, enlace);
    let after = await snapshotRevision(root);
    assert.ok(compareRevisionSnapshots(before, after).includes(clave), `${clave}: creado como enlace`);
    assert.equal(after.get(clave).kind, 'git-symlink');
    assert.notEqual(after.get(clave).sha256, undefined);
    // Estable sin cambios.
    assert.deepEqual(compareRevisionSnapshots(after, await snapshotRevision(root)), []);
    // Editar el contenido del destino (el enlace no cambia) se nota: antes se perdía como «ausente».
    before = after;
    await fs.appendFile(destino, '\tfsmonitor = ./x\n');
    after = await snapshotRevision(root);
    assert.ok(compareRevisionSnapshots(before, after).includes(clave), `${clave}: destino editado`);
    // Cambiar el destino del enlace a otro archivo con el mismo contenido también se nota.
    before = after;
    await fs.copyFile(destino, otro);
    await fs.rm(enlace);
    await fs.symlink(otro, enlace);
    after = await snapshotRevision(root);
    assert.ok(compareRevisionSnapshots(before, after).includes(clave), `${clave}: enlace reapuntado`);
    // Un enlace roto no es «ausente»: es un enlace.
    before = after;
    await fs.rm(enlace);
    await fs.symlink(path.join(fuera, 'no-existe'), enlace);
    after = await snapshotRevision(root);
    assert.equal(after.get(clave).kind, 'git-symlink');
    assert.ok(compareRevisionSnapshots(before, after).includes(clave), `${clave}: enlace roto`);
    // Devolver `config` a archivo para no dejar el repo roto en la siguiente vuelta.
    await fs.rm(enlace);
    if (nombre === 'config') await fs.writeFile(enlace, original);
  }
});

test('snapshot sees .git/config.worktree turn into a directory or another non-file', async (t) => {
  const root = await gitRepo(t);
  const ruta = path.join(root, '.git', 'config.worktree');
  const before = await snapshotRevision(root);
  await fs.mkdir(ruta);
  const after = await snapshotRevision(root);
  assert.ok(compareRevisionSnapshots(before, after).includes('.git/config.worktree'));
  assert.equal(after.get('.git/config.worktree').kind, 'git-other');
});

test('snapshot watches a hooks folder replaced by a symlink: the link and the resolved target content', { skip: SIN_ENLACES }, async (t) => {
  const root = await gitRepo(t);
  const fuera = await carpetaExterna(t);
  const hooks = path.join(root, '.git', 'hooks');
  const externa = path.join(fuera, 'hooks-externos');
  await fs.mkdir(externa);
  await fs.writeFile(path.join(externa, 'pre-commit'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  let before = await snapshotRevision(root);
  await fs.rm(hooks, { recursive: true });
  await fs.symlink(externa, hooks);
  let after = await snapshotRevision(root);
  assert.ok(compareRevisionSnapshots(before, after).includes('.git/hooks'), 'la carpeta pasa a ser un enlace');
  assert.equal(after.get('.git/hooks').kind, 'git-symlink');
  assert.equal(after.get('.git/hooks/pre-commit').kind, 'git-file-755', 'se recorre el destino resuelto');
  assert.deepEqual(compareRevisionSnapshots(after, await snapshotRevision(root)), []);
  // Cambios en el destino, que no pasan por `.git`.
  before = after;
  await fs.writeFile(path.join(externa, 'pre-commit'), '#!/bin/sh\ncurl x\n');
  await fs.writeFile(path.join(externa, 'post-merge'), '#!/bin/sh\n');
  after = await snapshotRevision(root);
  const cambios = compareRevisionSnapshots(before, after);
  assert.ok(cambios.includes('.git/hooks/pre-commit'), cambios.join(','));
  assert.ok(cambios.includes('.git/hooks/post-merge'), cambios.join(','));
  // Un enlace dentro del destino no se sigue: solo se anota su destino.
  before = after;
  await fs.symlink(fuera, path.join(externa, 'trampa'));
  await fs.writeFile(path.join(fuera, 'dentro-de-la-trampa'), 'x');
  after = await snapshotRevision(root);
  assert.equal(after.get('.git/hooks/trampa').kind, 'git-symlink');
  assert.equal([...after.keys()].some((k) => k.startsWith('.git/hooks/trampa/')), false);
  assert.ok(compareRevisionSnapshots(before, after).includes('.git/hooks/trampa'));
  // Un enlace roto es un enlace, no «ausente».
  await fs.rm(hooks);
  await fs.symlink(path.join(fuera, 'no-existe'), hooks);
  const roto = await snapshotRevision(root);
  assert.equal(roto.get('.git/hooks').kind, 'git-symlink');
  assert.equal(roto.get('.git/hooks/@destino').kind, 'git-unresolved');
  assert.ok(compareRevisionSnapshots(after, roto).includes('.git/hooks'));
});

test('snapshot watches symlinks inside .git/hooks and .git/info without following them', { skip: SIN_ENLACES }, async (t) => {
  const root = await gitRepo(t);
  const fuera = await carpetaExterna(t);
  await fs.mkdir(path.join(root, '.git', 'info'), { recursive: true });
  await fs.writeFile(path.join(fuera, 'hook'), '#!/bin/sh\n');
  await fs.writeFile(path.join(fuera, 'otro'), '#!/bin/sh\n');
  for (const [carpeta, nombre] of [['hooks', 'pre-commit'], ['info', 'attributes']]) {
    const enlace = path.join(root, '.git', carpeta, nombre);
    const clave = `.git/${carpeta}/${nombre}`;
    let before = await snapshotRevision(root);
    await fs.symlink(path.join(fuera, 'hook'), enlace);
    let after = await snapshotRevision(root);
    assert.ok(compareRevisionSnapshots(before, after).includes(clave), `${clave}: enlace creado`);
    // El contenido del destino no se sigue dentro de la carpeta; sí si cambia a dónde apunta.
    await fs.writeFile(path.join(fuera, 'hook'), '#!/bin/sh\ncambiado\n');
    assert.deepEqual(compareRevisionSnapshots(after, await snapshotRevision(root)), [], `${clave}: no se sigue`);
    before = after;
    await fs.rm(enlace);
    await fs.symlink(path.join(fuera, 'otro'), enlace);
    assert.ok(compareRevisionSnapshots(before, await snapshotRevision(root)).includes(clave), `${clave}: reapuntado`);
  }
});

test('snapshot watches subfolders of .git/hooks and .git/info, absent folders that appear, and truncates huge ones', async (t) => {
  const root = await gitRepo(t);
  const info = path.join(root, '.git', 'info');
  await fs.rm(info, { recursive: true, force: true });
  let before = await snapshotRevision(root);
  assert.equal(before.get('.git/info').kind, 'git');
  // Carpeta ausente que aparece.
  await fs.mkdir(info);
  await fs.writeFile(path.join(info, 'exclude'), 'x\n');
  let after = await snapshotRevision(root);
  assert.ok(compareRevisionSnapshots(before, after).includes('.git/info'), 'ausente → existe');
  assert.ok(compareRevisionSnapshots(before, after).includes('.git/info/exclude'));
  // Subcarpetas.
  before = after;
  await fs.mkdir(path.join(root, '.git', 'hooks', 'sub'));
  await fs.writeFile(path.join(root, '.git', 'hooks', 'sub', 'pre-push'), '#!/bin/sh\n');
  after = await snapshotRevision(root);
  const cambios = compareRevisionSnapshots(before, after);
  assert.ok(cambios.includes('.git/hooks/sub'), cambios.join(','));
  assert.ok(cambios.includes('.git/hooks/sub/pre-push'), cambios.join(','));
  // Truncado: más de 2000 entradas dejan una marca en vez de recorrerlo todo.
  const grande = path.join(root, '.git', 'hooks', 'grande');
  await fs.mkdir(grande);
  await Promise.all(Array.from({ length: 2100 }, (_, i) => fs.writeFile(path.join(grande, `h${i}`), '')));
  const truncada = await snapshotRevision(root);
  assert.equal(truncada.get('.git/hooks/…').kind, 'git-truncated');
});

test('snapshot notices a new file inside a node_modules package through the folder mtime, with package.json untouched', async (t) => {
  const root = await gitRepo(t);
  const modules = path.join(root, 'node_modules');
  const pasado = 1_600_000_000;
  for (const [paquete, clave] of [['dep', 'node_modules/dep'], [path.join('@scope', 'pkg'), 'node_modules/@scope/pkg']]) {
    const carpeta = path.join(modules, paquete);
    await fs.mkdir(carpeta, { recursive: true });
    await fs.writeFile(path.join(carpeta, 'package.json'), '{"name":"x"}');
    const fijar = () => fs.utimes(carpeta, pasado, pasado);
    await fijar();
    let before = await snapshotRevision(root);
    assert.equal(before.get(clave).mtimeMs, pasado * 1000);
    assert.deepEqual(compareRevisionSnapshots(before, await snapshotRevision(root)), [], 'stable without changes');
    // Crear `evil.js` dentro del paquete cambia la fecha de la carpeta; su package.json sigue igual.
    await fs.writeFile(path.join(carpeta, 'evil.js'), 'module.exports = 1');
    assert.ok(compareRevisionSnapshots(before, await snapshotRevision(root)).includes(clave), `${clave}: archivo creado`);
    // Borrarlo también.
    await fijar();
    before = await snapshotRevision(root);
    await fs.rm(path.join(carpeta, 'evil.js'));
    assert.ok(compareRevisionSnapshots(before, await snapshotRevision(root)).includes(clave), `${clave}: archivo borrado`);
  }
});

test('snapshot records symlinked node_modules packages and scopes as dependency-symlink, never following them', { skip: SIN_ENLACES }, async (t) => {
  const root = await gitRepo(t);
  const fuera = await carpetaExterna(t);
  const modules = path.join(root, 'node_modules');
  await fs.mkdir(modules);
  const paquete = path.join(fuera, 'paquete');
  const ambito = path.join(fuera, 'ambito');
  await fs.mkdir(paquete);
  await fs.mkdir(path.join(ambito, 'interno'), { recursive: true });
  await fs.writeFile(path.join(paquete, 'package.json'), '{"name":"p"}');
  await fs.writeFile(path.join(ambito, 'interno', 'package.json'), '{"name":"i"}');
  await fs.symlink(paquete, path.join(modules, 'enlazado'));
  await fs.symlink(ambito, path.join(modules, '@enlazado'));
  const before = await snapshotRevision(root);
  assert.equal(before.get('node_modules/enlazado').kind, 'dependency-symlink');
  assert.equal(before.get('node_modules/@enlazado').kind, 'dependency-symlink');
  // No se recorre el destino: ni su contenido ni los paquetes de un ámbito enlazado salen en la instantánea.
  assert.equal([...before.keys()].some((k) => k.startsWith('node_modules/enlazado/') || k.startsWith('node_modules/@enlazado/')), false);
  // Editar dentro del destino no se nota (no se sigue)...
  await fs.writeFile(path.join(paquete, 'package.json'), '{"name":"evil"}');
  await fs.writeFile(path.join(ambito, 'interno', 'package.json'), '{"name":"evil"}');
  assert.deepEqual(compareRevisionSnapshots(before, await snapshotRevision(root)), []);
  // ...pero reapuntar el enlace sí.
  await fs.rm(path.join(modules, 'enlazado'));
  await fs.symlink(fuera, path.join(modules, 'enlazado'));
  await fs.rm(path.join(modules, '@enlazado'));
  await fs.symlink(paquete, path.join(modules, '@enlazado'));
  assert.deepEqual(compareRevisionSnapshots(before, await snapshotRevision(root)), ['node_modules/@enlazado', 'node_modules/enlazado']);
  // Y sustituir un paquete real por un enlace cambia su tipo.
  await fs.mkdir(path.join(modules, 'real'));
  const antes = await snapshotRevision(root);
  assert.equal(antes.get('node_modules/real').kind, 'dependency-directory');
  await fs.rm(path.join(modules, 'real'), { recursive: true });
  await fs.symlink(paquete, path.join(modules, 'real'));
  assert.ok(compareRevisionSnapshots(antes, await snapshotRevision(root)).includes('node_modules/real'));
});
