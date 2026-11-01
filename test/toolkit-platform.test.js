import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {isNodeSupported, executable} from '../src/toolkit-setup.js';
test('doctor follows the Node floor declared in package.json',()=>{
 assert.equal(isNodeSupported('24.0.0'),true);
 assert.equal(isNodeSupported('26.13.0'),true);
 assert.equal(isNodeSupported('23.11.0'),false);
});
test('Windows executable detection uses case-insensitive PATHEXT and defaults', {skip:process.platform!=='win32'},async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'toolkit-path-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.writeFile(path.join(root,'codex.CMD'),'@echo off');
 assert.equal(await executable('codex',{PATH:root,PATHEXT:'.exe;.cMd'}),true);
 assert.equal(await executable('codex',{PATH:root}),true);
 assert.equal(await executable('codex',{PATH:root,PATHEXT:''}),true);
 assert.equal(await executable('codex',{PATH:root,PATHEXT:'.exe'}),false);
 assert.equal(await executable('absent',{PATH:root}),false);
});

test('setup creates and preserves links without deleting targets; foreign links and real folders conflict', async t=>{
 const {setupToolkit}=await import('../src/toolkit-setup.js');
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'toolkit-links-')));
 const homeDirectory=path.join(root,'home'), toolkitRoot=path.join(root,'toolkit'), other=path.join(root,'other');
 await fs.mkdir(homeDirectory); await fs.mkdir(other);
 await fs.writeFile(path.join(other,'keep'),'preserve');
 await fs.mkdir(path.join(toolkitRoot,'skills/example'),{recursive:true});
 await fs.writeFile(path.join(toolkitRoot,'skills/example/SKILL.md'),'example');
 const options={homeDirectory,toolkitRoot,agent:'codex',apply:true,environment:{}};
 const target=path.join(homeDirectory,'.agents/skills/example');
 // Remove links explicitly before recursively cleaning the isolated fixture.
 t.after(async()=>{ try { if((await fs.lstat(target)).isSymbolicLink()) await fs.unlink(target); } catch(e) {if(e.code!=='ENOENT') throw e;} await fs.rm(root,{recursive:true,force:true}); });
 assert.equal((await setupToolkit(options)).applied,true);
 const before=await fs.lstat(target);
 assert.equal((await setupToolkit(options)).skills[0].state,'instalado');
 assert.equal((await fs.lstat(target)).birthtimeMs,before.birthtimeMs);
 await fs.unlink(target);
 await fs.symlink(path.resolve(other),target,process.platform==='win32'?'junction':'dir');
 // A link to an existing folder that is not a copy of nexakit belongs to the user: it is never repointed.
 const preview=await setupToolkit({...options,apply:false});
 assert.equal(preview.skills[0].state,'conflicto');
 const kept=await setupToolkit(options);
 assert.deepEqual([kept.applied,kept.conflicts],[true,1]);
 assert.equal(await fs.realpath(target),other);
 assert.equal(await fs.readFile(path.join(other,'keep'),'utf8'),'preserve');
 await fs.unlink(target); await fs.mkdir(target); await fs.writeFile(path.join(target,'keep'),'original');
 assert.equal((await setupToolkit(options)).conflicts,1);
 assert.equal(await fs.readFile(path.join(target,'keep'),'utf8'),'original');
});
