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
