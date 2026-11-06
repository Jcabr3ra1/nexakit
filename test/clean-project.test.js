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

// Every operation below plans argv only: no generator or package manager is started.
const catalog = await (await import('../src/generators-catalog.js')).loadGeneratorsCatalog();
const planner = async options => (await import('../src/clean-project.js')).planCleanProject({ catalog, name: 'Punto Motos', ...options });
test('only frontend goes to the root', async () => {
  const plan = await planner({ choice: { frontend: 'react-vite' } });
  assert.equal(plan.parts.length, 1); assert.equal(plan.parts[0].dir, '.');
  assert.deepEqual(plan.parts[0].commands[0], { argv: ['npm','create','--yes','vite@latest','.','--','--template','react-ts','--no-interactive'], cwd: '.' });
  assert.deepEqual(plan.gitignore, ['.env']);
});
test('frontend and backend go to folders', async () => {
  const plan = await planner({ choice: { frontend: 'react-vite', backend: 'django' }, platform: 'linux' });
  assert.deepEqual(plan.parts.map(p => [p.part,p.dir]), [['frontend','frontend'],['backend','backend']]);
  assert.deepEqual(plan.parts[1].commands[1], { argv: ['.venv/bin/django-admin','startproject','config','.'], cwd: 'backend' });
  assert.deepEqual(plan.gitignore, ['.venv/', '.env']);
});
test('postgresql adds the driver to the backend', async () => {
  const plan = await planner({ choice: { backend: 'django', database: 'postgresql' } });
  assert.ok(plan.parts[0].commands.some(c => c.argv.includes('psycopg[binary]')));
  assert.deepEqual(plan.parts[0].writes, [{ path: '.env.example', content: 'DATABASE_URL=postgresql://usuario:clave@localhost:5432/nombre\n' }]);
});
test('supabase goes to the frontend when both exist', async () => {
  const plan = await planner({ choice: { frontend: 'react-vite', backend: 'django', database: 'supabase' } });
  assert.ok(plan.parts[0].commands.some(c => c.argv.includes('@supabase/supabase-js')));
  assert.ok(!plan.parts[1].commands.some(c => c.argv.includes('supabase')));
  assert.deepEqual(plan.parts[0].commands.find(c => c.argv.includes('supabase@latest')), { argv: ['npx','--yes','supabase@latest','init'], cwd: '.' });
});
test('database without backend only allows supabase', async () => {
  for (const database of ['postgresql','sqlite']) await assert.rejects(planner({ choice: { frontend: 'react-vite', database } }), /backend/i);
  assert.equal((await planner({ choice: { frontend: 'react-vite', database: 'supabase' } })).parts.length, 1);
});
test('python commands use the venv', async () => {
  for (const [platform,python] of [['win32','.venv\\Scripts\\python.exe'],['linux','.venv/bin/python']]) {
    const plan = await planner({ choice: { backend: 'fastapi' }, platform });
    assert.equal(plan.parts[0].commands[0].argv[0], python); assert.equal(plan.parts[0].check.argv[0], python);
  }
});
test('the name is normalized', async () => {
  const plan = await planner({ choice: { frontend: 'angular' }, name: 'Éxito_2' });
  assert.ok(plan.parts[0].commands[0].argv.includes('exito-2'));
});
test('mobile participates in folder counting and follows the backend', async () => {
  const plan = await planner({ choice: { frontend:'nextjs', backend:'express', mobile:'expo' } });
  assert.deepEqual(plan.parts.map(p=>p.dir), ['frontend','backend','movil']);
});
test('fastapi writes stay inside its part and planning is deterministic', async () => {
  const options = { choice: { frontend: 'react-vite', backend: 'fastapi', database: 'supabase' } };
  const before = JSON.stringify(catalog), plan = await planner(options);
  assert.deepEqual(plan.parts[1].writes.map(w => w.path), ['backend/main.py','backend/requirements.txt']);
  assert.deepEqual(await planner(options), plan); assert.equal(JSON.stringify(catalog), before);
  assert.doesNotMatch(JSON.stringify(plan), /\{(?:dir|name|python|venvBin)\}/);
});
test('unknown choices and mismatched parts are rejected', async () => {
  for (const choice of [{ frontend:'unknown' },{ frontend:'django' },{ database:'supabase' },{ wrong:'react-vite' }]) {
    await assert.rejects(planner({choice}), /elección|parte|frontend|backend/i);
  }
});

const requirements = async (choice, runCommand, platform = 'linux', suppliedCatalog = catalog) => {
  const plan = await planner({ choice });
  return (await import('../src/clean-project.js')).checkRequirements(plan, suppliedCatalog, { runCommand, platform });
};
test('missing python blocks django', async () => {
  const result = await requirements({ backend:'django' }, () => { throw Error('missing'); });
  assert.deepEqual(result, [{program:'python', minVersion:'3.12', found:null, ok:false}]);
});
test('old node is reported with the version found', async () => {
  const copy = structuredClone(catalog); copy.generators.find(g=>g.id==='react-vite').requires[0].minVersion='20.19';
  assert.deepEqual(await requirements({frontend:'react-vite'}, ()=>'v18.0.0', 'linux', copy),
    [{program:'node', minVersion:'20.19', found:'18.0.0', ok:false}]);
});
test('uses py on windows', async () => {
  const result = await requirements({backend:'django'}, (cmd,args)=>{
    assert.equal(cmd,'py'); assert.deepEqual(args,['--version']); return 'Python 3.13.2';
  }, 'win32');
  assert.equal(result[0].ok,true);
});
const executePlan = async (plan, opts) => (await import('../src/clean-project.js')).runCleanProject(plan, opts);
test('runs parts in order and writes the log', async t => {
  const root = await folder(t), calls=[];
  const runCommand = async (cmd,args,{cwd}) => {
    calls.push([cmd,...args]);
    if (args.includes('vite@latest')) await fs.writeFile(path.join(cwd,'package.json'), '{"dependencies":{"react":"*"}}');
    return {status:0,stdout:'ok'};
  };
  const result = await executePlan(await planner({choice:{frontend:'react-vite'}}), {projectRoot:root,runCommand});
  assert.deepEqual(result.done,['frontend']); assert.equal(result.ok,true);
  assert.ok(calls[0].includes('vite@latest')); assert.equal(calls.at(-1).join(' '),'npm run build');
  assert.match(await fs.readFile(path.join(root,'.agent-toolkit/creacion.log'),'utf8'), /vite@latest/);
  assert.ok(await fs.stat(path.join(root,'package.json')));
});
test('stops at the first failure and keeps what was created', async t => {
  const root=await folder(t); let calls=0;
  const result=await executePlan(await planner({choice:{frontend:'react-vite',backend:'django'}}),{
    projectRoot:root,runCommand:async()=>{calls++;return {status:1,stderr:'falló'};}
  });
  assert.equal(result.ok,false); assert.equal(result.failed.part,'frontend'); assert.equal(calls,1);
});
test('never overwrites an existing file', async t => {
  const root=await folder(t);await fs.writeFile(path.join(root,'README.md'),'ajeno');let calls=0;
  const result=await executePlan(await planner({choice:{frontend:'react-vite'}}),{projectRoot:root,runCommand:async()=>{calls++;return {status:0};}});
  assert.equal(result.ok,false); assert.equal(calls,0); assert.equal(await fs.readFile(path.join(root,'README.md'),'utf8'),'ajeno');
});
test('a command that exceeds the timeout fails and is logged', async t => {
  const root=await folder(t);
  const r=await executePlan(await planner({choice:{frontend:'react-vite'}}),{projectRoot:root,timeoutMs:10,runCommand:()=>new Promise(()=>{})});
  assert.equal(r.ok,false);assert.match(r.failed.output,/tiempo/i);
  assert.match(await fs.readFile(path.join(root,'.agent-toolkit/creacion.log'),'utf8'),/tiempo/i);
});
test('secrets in the output are redacted in the log', async t => {
  const root=await folder(t);
  const r=await executePlan(await planner({choice:{frontend:'react-vite'}}),{projectRoot:root,runCommand:()=>({status:1,stderr:'postgresql://u:secreto@h API_TOKEN=privado'})});
  const log=await fs.readFile(path.join(root,'.agent-toolkit/creacion.log'),'utf8');
  assert.doesNotMatch(log+r.failed.output,/secreto|privado/);assert.match(log,/\*\*\*/);
});
test('Python venv stays at its final path and the check runs after promotion', async t => {
  const root=await folder(t), seen=[];
  const r=await executePlan(await planner({choice:{backend:'fastapi'},platform:'linux'}),{projectRoot:root,platform:'linux',runCommand:async(cmd,args,{cwd})=>{
    seen.push({cmd,args,cwd});
    if(args.includes('venv')) { assert.equal(cwd,root); await fs.mkdir(path.join(root,'.venv')); }
    if(args.includes('pip')) assert.equal(cmd,path.join(root,'.venv/bin/python'));
    if(args.includes('import main')) { assert.equal(cwd,root); assert.ok(await fs.stat(path.join(root,'main.py'))); }
    return {status:0};
  }});
  assert.equal(r.ok,true);assert.equal(seen.length,3);
});

const initializeGit = async(root,options)=>(await import('../src/clean-project.js')).initGit(root,options);
test('git initialization creates the first commit after adding missing ignore lines',async t=>{
 const root=await folder(t),calls=[];
 assert.equal(await initializeGit(root,{insideGit:false,gitignore:['.venv/','.env'],runCommand:async(cmd,args)=>{calls.push([cmd,...args]);return {status:0};}}),'hecho');
 assert.deepEqual(calls.map(c=>c.slice(0,2)),[['git','--version'],['git','init'],['git','add'],['git','commit']]);
 assert.match(await fs.readFile(path.join(root,'.gitignore'),'utf8'),/\.venv\//);
});
test('insideGit skips initialization without changing any files',async t=>{
 const root=await folder(t);
 assert.equal(await initializeGit(root,{insideGit:true,gitignore:[],runCommand:()=>{throw Error('must not run');}}),'omitido-repo-existente');
 assert.deepEqual(await fs.readdir(root),[]);
});
test('missing Git is reported without attempting a commit',async t=>{
 assert.equal(await initializeGit(await folder(t),{insideGit:false,gitignore:[],runCommand:()=>{throw Error('not found');}}),'sin-git');
});
test('does not duplicate gitignore lines',async t=>{
 const root=await folder(t);await fs.writeFile(path.join(root,'.gitignore'),'.env\nnode_modules/\n');
 await initializeGit(root,{insideGit:false,gitignore:['.env','.venv/'],runCommand:()=>({status:0})});
 const text=await fs.readFile(path.join(root,'.gitignore'),'utf8');assert.equal(text.split('\n').filter(l=>l==='.env').length,1);assert.match(text,/node_modules/);
});
test('cancellation aborts an active generator and records the stopped creation',async t=>{
 const root=await folder(t),controller=new AbortController();let aborted=false;
 const running=executePlan(await planner({choice:{frontend:'react-vite'}}),{projectRoot:root,timeoutMs:30,signal:controller.signal,runCommand:async(_c,_a,{signal})=>{
   signal.addEventListener('abort',()=>{aborted=true;});controller.abort();return new Promise(()=>{});
 }});
 const r=await running;assert.equal(r.ok,false);assert.equal(aborted,true);assert.match(r.failed.output,/cancelad/i);
});
test('the current Node 24.14 satisfies React generators without requiring an unrelated upgrade',async()=>{
 const result=await requirements({frontend:'react-vite'},()=>'v24.14.1');assert.equal(result[0].ok,true);
});
test('Supabase root configuration survives promotion with multiple parts',async t=>{
 const root=await folder(t),{fakeGenerators}=await import('../test-support/fake-generators.js'),base=fakeGenerators();
 const r=await executePlan(await planner({choice:{frontend:'react-vite',backend:'express',database:'supabase'}}),{projectRoot:root,runCommand:async(cmd,args,opts)=>{
   if(args.includes('supabase@latest')){await fs.mkdir(path.join(opts.cwd,'supabase'));await fs.writeFile(path.join(opts.cwd,'supabase/config.toml'),'project_id="prueba"');return {status:0};}
   return base(cmd,args,opts);
 }});
 assert.equal(r.ok,true);assert.match(await fs.readFile(path.join(root,'supabase/config.toml'),'utf8'),/prueba/);
});
test('requirements probes that never finish are bounded and aborted',async()=>{
 let aborted=false;
 const plan=await planner({choice:{frontend:'react-vite'}});
 const {checkRequirements}=await import('../src/clean-project.js');
 const result=await checkRequirements(plan,catalog,{timeoutMs:15,runCommand:(_c,_a,{signal})=>{signal.addEventListener('abort',()=>{aborted=true;});return new Promise(()=>{});}});
 assert.equal(result[0].ok,false);assert.equal(aborted,true);
});
for(const interruption of ['timeout','cancel']) test(`partial output is logged on ${interruption}`,async t=>{
 const root=await folder(t),controller=new AbortController();
 const r=await executePlan(await planner({choice:{frontend:'react-vite'}}),{projectRoot:root,signal:controller.signal,timeoutMs:20,
 runCommand:async(_cmd,_args,{onOutput})=>{onOutput?.('Última salida API_TOKEN=privado\n');if(interruption==='cancel')controller.abort();return new Promise(()=>{});}});
 assert.equal(r.ok,false);const log=await fs.readFile(path.join(root,'.agent-toolkit/creacion.log'),'utf8');assert.match(log,/Última salida/);assert.doesNotMatch(log,/privado/);
});
