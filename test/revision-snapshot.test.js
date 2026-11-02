import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { snapshotRevision, compareRevisionSnapshots } from '../src/revision-snapshot.js';

test('snapshot includes ignored and hidden files, skips git/modules and detects changes', async t => {
 const root = await fs.mkdtemp(path.join(os.tmpdir(), 'revision-snap-'));
 t.after(() => fs.rm(root, {recursive:true, force:true}));
 await fs.mkdir(path.join(root,'.git')); await fs.mkdir(path.join(root,'node_modules'));
 await fs.writeFile(path.join(root,'.git','config'),'secret');
 await fs.writeFile(path.join(root,'node_modules','dep'),'dependency');
 await fs.writeFile(path.join(root,'.hidden'),'hidden');
 await fs.writeFile(path.join(root,'ignored'),'old');
 const before = await snapshotRevision(root);
 assert.deepEqual([...before.keys()].sort(), ['.hidden','ignored']);
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
