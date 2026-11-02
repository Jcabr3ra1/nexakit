import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { collectRevisionContext } from '../src/revision-context.js';
const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']});
async function repo(t){
 const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'revision-context-')));
 t.after(()=>fs.rm(base,{recursive:true,force:true}));const root=path.join(base,'repo');const home=path.join(base,'home');
 await fs.mkdir(root);await fs.mkdir(home);git(root,'init','-q','-b','main');
 git(root,'config','user.email','test@example.invalid');git(root,'config','user.name','Test');
 await fs.writeFile(path.join(root,'tracked'),'original');git(root,'add','.');git(root,'commit','-qm','base');return {root,home,base};
}
test('context includes branch, staged, unstaged and untracked changes from a subfolder',async t=>{
 const {root,home}=await repo(t);git(root,'checkout','-qb','feature');
 await fs.writeFile(path.join(root,'committed'),'committed');git(root,'add','.');git(root,'commit','-qm','feature');
 await fs.writeFile(path.join(root,'staged'),'staged');git(root,'add','.');
 await fs.writeFile(path.join(root,'tracked'),'working tree');
 const name=process.platform==='win32'?'new file.txt':'new \n slash\\name.txt';
 await fs.writeFile(path.join(root,name),'UNTRACKED CONTENT');await fs.mkdir(path.join(root,'sub'));
 const r=await collectRevisionContext({start:path.join(root,'sub'),homeDirectory:home});
 assert.equal(r.root,root);assert.equal(r.base,'main');
 assert.deepEqual(r.changedFiles.sort(),['committed','staged','tracked',name].sort());
 for(const text of ['committed','staged','working tree','UNTRACKED CONTENT'])assert.ok(r.diff.includes(text));
});
test('base selection rejects missing, option-like and ambiguous bases',async t=>{
 const {root,home}=await repo(t);
 for(const base of ['missing','--output=/tmp/unsafe'])await assert.rejects(collectRevisionContext({start:root,base,homeDirectory:home}));
 git(root,'branch','master');await assert.rejects(collectRevisionContext({start:root,homeDirectory:home}),/ambigua/);
 const r=await collectRevisionContext({start:root,base:'main',homeDirectory:home});assert.deepEqual(r.changedFiles,[]);
 git(root,'symbolic-ref','refs/remotes/origin/HEAD','refs/heads/main');
 assert.equal((await collectRevisionContext({start:root,homeDirectory:home})).base,'refs/heads/main');
});
test('context resolves a linked worktree with a .git file',async t=>{
 const {root,home,base}=await repo(t);const other=path.join(base,'worktree');
 git(root,'worktree','add','-qb','feature',other);
 await fs.writeFile(path.join(other,'tracked'),'worktree change');
 const r=await collectRevisionContext({start:other,homeDirectory:home});assert.equal(r.root,other);assert.match(r.diff,/worktree change/);
});
