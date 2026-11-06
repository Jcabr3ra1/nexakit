import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inspectFolder, projectName } from '../src/clean-project.js';
async function folder(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'clean-project-')));
  t.after(() => fs.rm(root, { recursive: true, force: true })); return root;
}
const noGit = () => { throw new Error('not a repository'); };
test('an empty folder or one with only .git, .DS_Store and Thumbs.db is empty', async t => {
  const root = await folder(t);
  assert.deepEqual(await inspectFolder(root, { runGit: noGit }), { empty: true, insideGit: false, entries: [] });
  await fs.mkdir(path.join(root, '.git'));
  for (const f of ['.DS_Store', 'Thumbs.db']) await fs.writeFile(path.join(root, f), '');
  const result = await inspectFolder(root, { runGit: () => root });
  assert.equal(result.empty, true); assert.equal(result.insideGit, true);
  assert.deepEqual(result.entries, ['.DS_Store', '.git', 'Thumbs.db']);
});
test('a README or a node_modules folder makes it non-empty', async t => {
  const root = await folder(t); await fs.writeFile(path.join(root, 'README.md'), '# app');
  assert.equal((await inspectFolder(root, { runGit: noGit })).empty, false);
  await fs.unlink(path.join(root, 'README.md')); await fs.mkdir(path.join(root, 'node_modules'));
  assert.equal((await inspectFolder(root, { runGit: noGit })).empty, false);
});
test('insideGit is true in a subfolder of a repository', async t => {
  const root = await folder(t), sub = path.join(root, 'child'); await fs.mkdir(sub);
  const result = await inspectFolder(sub, { runGit: (args, cwd) => {
    assert.deepEqual(args, ['rev-parse', '--show-toplevel']); assert.equal(cwd, sub); return root + '\n';
  } });
  assert.equal(result.insideGit, true); assert.equal(result.empty, true);
});
test('projectName normalizes accents, spaces and capitals', () => {
  assert.equal(projectName('/tmp/Punto Motos'), 'punto-motos');
  assert.equal(projectName('/tmp/Éxito_2'), 'exito-2');
  assert.equal(projectName('/tmp/!!!'), 'proyecto');
});

