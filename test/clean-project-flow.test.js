import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fakeGenerators} from '../test-support/fake-generators.js';
import {loadGeneratorsCatalog} from '../src/generators-catalog.js';
import {detectSignals} from '../src/project-signals.js';
import {readCleanProjectAnswers} from '../src/skill-recommendations.js';
const generators=await loadGeneratorsCatalog();
async function setup(t){const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'clean-flow-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;}
const create=async(root,choice,runCommand)=>{
 const {createCleanProject}=await import('../src/clean-project-flow.js');
 return createCleanProject({folder:root,choice:{frontend:null,backend:null,database:null,mobile:null,...choice},git:false,insideGit:false},
  {runCommand,options:{start:root},gather:async()=>({signals:(await detectSignals(root,{git:false})).signals,project:{root},cleanProject:await readCleanProjectAnswers(root)})});
};
test('react only ends at skills state with React detected',async t=>{
 const root=await setup(t),r=await create(root,{frontend:'react-vite'},fakeGenerators());
 assert.equal(r.ok,true);assert.ok(r.state.signals.some(s=>s.id==='react'));assert.equal(r.state.cleanProject.status,'creado');
});
test('react and django create both folders and detect both',async t=>{
 const root=await setup(t),r=await create(root,{frontend:'react-vite',backend:'django'},fakeGenerators());
 assert.equal(r.ok,true);assert.ok(r.state.signals.some(s=>s.id==='react'));assert.ok(r.state.signals.some(s=>s.id==='django'));
});
test('a failing generator stops logs and keeps files and saved answers',async t=>{
 const root=await setup(t),r=await create(root,{frontend:'react-vite'},fakeGenerators({fail:(_command,args)=>args.includes('vite@latest')}));
 assert.equal(r.ok,false);assert.equal((await readCleanProjectAnswers(root)).status,'fallido');
 assert.match(await fs.readFile(path.join(root,'.agent-toolkit/creacion.log'),'utf8'),/Fallo simulado/);
});
test('a second run does not ask again',async t=>{
 const root=await setup(t);await create(root,{frontend:'react-vite'},fakeGenerators());
 assert.equal((await readCleanProjectAnswers(root)).status,'creado');
});
test('a clean project boundary stays at its folder inside another repository',async t=>{
 const root=await setup(t),nested=path.join(root,'nested');await fs.mkdir(nested);
 await create(nested,{frontend:'react-vite'},fakeGenerators());
 const {resolveProjectRoot}=await import('../src/project-root.js');
 const resolved=await resolveProjectRoot(nested,{runGit:()=>root});assert.equal(resolved.root,nested);assert.equal(resolved.git,true);
});
test('failed creation returns the child project state for continuing with its own files',async t=>{
 const root=await setup(t),child=path.join(root,'nuevo');
 const r=await create(child,{frontend:'react-vite'},fakeGenerators({fail:(_c,args)=>args.includes('vite@latest')}));
 assert.equal(r.ok,false);assert.equal(r.state?.project.root,child);
});
test('Python and secret ignore rules are kept when Git initialization is disabled',async t=>{
 const root=await setup(t),r=await create(root,{backend:'fastapi'},fakeGenerators());assert.equal(r.ok,true);
 const ignore=await fs.readFile(path.join(root,'.gitignore'),'utf8');assert.match(ignore,/^\.venv\/$/m);assert.match(ignore,/^\.env$/m);
});
test('Git failure retains the precise command and redacted diagnostic in the creation log',async t=>{
 const root=await setup(t),{createCleanProject}=await import('../src/clean-project-flow.js'),base=fakeGenerators();
 const r=await createCleanProject({folder:root,choice:{frontend:'react-vite',backend:null,database:null,mobile:null},git:true,insideGit:false},
   {runCommand:(cmd,args,opts)=>cmd==='git'&&args[0]==='commit'?{status:128,stderr:'Falta identidad API_TOKEN=privado'}:base(cmd,args,opts),gather:async()=>({project:{root}})});
 assert.equal(r.ok,false);assert.equal(r.failed.argv[1],'commit');
 const log=await fs.readFile(path.join(root,'.agent-toolkit/creacion.log'),'utf8');assert.match(log,/git commit/);assert.match(log,/Falta identidad/);assert.doesNotMatch(log,/privado/);
});
