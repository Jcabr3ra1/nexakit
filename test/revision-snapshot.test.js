import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { snapshotRevision, compareRevisionSnapshots } from '../src/revision-snapshot.js';

test('snapshot includes ignored and hidden files, records module entries and skips git and detects changes', async t => {
 const root = await fs.mkdtemp(path.join(os.tmpdir(), 'revision-snap-'));
 t.after(() => fs.rm(root, {recursive:true, force:true}));
 await fs.mkdir(path.join(root,'.git')); await fs.mkdir(path.join(root,'node_modules'));
 await fs.writeFile(path.join(root,'.git','config'),'secret');
 await fs.writeFile(path.join(root,'node_modules','dep'),'dependency');
 await fs.writeFile(path.join(root,'.hidden'),'hidden');
 await fs.writeFile(path.join(root,'ignored'),'old');
 const before = await snapshotRevision(root);
 assert.deepEqual([...before.keys()].sort(), ['.hidden','ignored','node_modules/dep']);
 await fs.unlink(path.join(root,'.hidden')); await fs.writeFile(path.join(root,'ignored'),'longer now');
 await fs.writeFile(path.join(root,'new file'),'new');
 assert.deepEqual(compareRevisionSnapshots(before, await snapshotRevision(root)), ['.hidden','ignored','new file']);
});

test('snapshot never follows an external symlink and accepts a git file in a worktree', {skip: process.platform === 'win32'}, async t => {
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'revision-links-'));
 t.after(()=>fs.rm(base,{recursive:true,force:true})); const root=path.join(base,'repo');await fs.mkdir(root);
 await fs.writeFile(path.join(base,'outside'),'outside');await fs.symlink(path.join(base,'outside'),path.join(root,'link'));
 await fs.writeFile(path.join(root,'.git'),'gitdir: elsewhere');const first=await snapshotRevision(root);
 await fs.writeFile(path.join(base,'outside'),'external content changed');
 assert.deepEqual(compareRevisionSnapshots(first,await snapshotRevision(root)),[]);
 assert.equal(first.get('link').kind,'symlink');assert.equal(first.has('.git'),false);
});

// Reviewers must not be able to hide Git mutations behind an unchanged tree.
import { execFileSync } from 'node:child_process';
const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']});
async function gitRepo(t) {
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'revision-git-snap-')));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));git(root,'init','-q','-b','main');
 git(root,'config','user.email','test@example.invalid');git(root,'config','user.name','Test');
 await fs.writeFile(path.join(root,'tracked'),'original');git(root,'add','.');git(root,'commit','-qm','base');return root;
}
test('snapshot detects a reviewer commit even when working files do not change',async t=>{
 const root=await gitRepo(t);const before=await snapshotRevision(root);
 git(root,'commit','--allow-empty','-qm','reviewer commit');
 const changes=compareRevisionSnapshots(before,await snapshotRevision(root));
 assert.ok(changes.includes('.git/HEAD'));assert.ok(changes.includes('.git/refs'));
});
test('snapshot detects add and checkout, including a linked worktree index',async t=>{
 const root=await gitRepo(t);const other=path.join(root,'..',path.basename(root)+'-worktree');
 git(root,'worktree','add','-qb','review',other);t.after(()=>fs.rm(other,{recursive:true,force:true}));
 await fs.writeFile(path.join(other,'tracked'),'modified');const before=await snapshotRevision(other);
 git(other,'add','tracked');const after=await snapshotRevision(other);
 const changes=compareRevisionSnapshots(before,after);
 assert.ok(changes.includes('.git/index'));assert.ok(changes.includes('.git/status'));
 git(other,'checkout','--detach','-q');
 assert.ok(compareRevisionSnapshots(after,await snapshotRevision(other)).includes('.git/HEAD'));
});

test('snapshot hashes tracked and untracked files even with same size and restored mtime',async t=>{
 const root=await gitRepo(t);
 for(const name of ['tracked','untracked']) {
  const file=path.join(root,name);await fs.writeFile(file,'AAAA');
  // Use an exactly representable timestamp on all platforms.
  await fs.utimes(file,1700000000,1700000000);const original=await fs.stat(file);
  const before=await snapshotRevision(root);await fs.writeFile(file,'BBBB');
  await fs.utimes(file,original.atime,original.mtime);
  assert.ok(compareRevisionSnapshots(before,await snapshotRevision(root)).includes(name));
 }
});
test('snapshot notices first-level node_modules names and sizes without scanning dependencies',async t=>{
 const root=await gitRepo(t);const modules=path.join(root,'node_modules');await fs.mkdir(modules);
 await fs.writeFile(path.join(modules,'entry'),'small');const before=await snapshotRevision(root);
 await fs.writeFile(path.join(modules,'entry'),'larger content');await fs.mkdir(path.join(modules,'new-package'));
 const changes=compareRevisionSnapshots(before,await snapshotRevision(root));
 assert.ok(changes.includes('node_modules/entry'));assert.ok(changes.includes('node_modules/new-package'));
});
