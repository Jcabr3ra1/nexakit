import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { projectIdentity, resolveProjectRoot } from '../src/project-root.js';

async function temp(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'project-root-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  await fs.mkdir(home);
  return { root, home };
}
const gitInit = dir => execFileSync('git', ['init', '-q', dir], { stdio: 'ignore' });

test('from a subfolder the project is the whole Git repository', async t => {
  const { root, home } = await temp(t);
  const repo = path.join(root, 'Punto_Motos');
  await fs.mkdir(path.join(repo, 'frontend'), { recursive: true });
  gitInit(repo);
  const r = await resolveProjectRoot(path.join(repo, 'frontend'), { homeDirectory: home });
  assert.deepEqual(r, { root: repo, startedIn: path.join(repo, 'frontend'), git: true, fromSubfolder: true, id: 'punto-motos', displayName: 'Punto Motos' });
  assert.equal((await resolveProjectRoot(repo, { homeDirectory: home })).fromSubfolder, false);
});

test('without Git the project is the current folder', async t => {
  const { root, home } = await temp(t);
  const plain = path.join(root, 'plain');
  await fs.mkdir(plain);
  const r = await resolveProjectRoot(plain, { homeDirectory: home });
  assert.equal(r.root, plain);
  assert.equal(r.git, false);
  assert.equal(r.fromSubfolder, false);
});

test('a Git repository at the home folder is never taken as the project', async t => {
  const { home } = await temp(t);
  gitInit(home);
  const start = path.join(home, 'trabajo', 'app');
  await fs.mkdir(start, { recursive: true });
  const r = await resolveProjectRoot(start, { homeDirectory: home });
  assert.equal(r.root, start);
  assert.equal(r.git, false);
  assert.equal(r.fromSubfolder, false);
});

test('a git that fails or is missing means no Git, never an error', async t => {
  const { root, home } = await temp(t);
  const missing = () => { throw Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }); };
  const r = await resolveProjectRoot(root, { homeDirectory: home, runGit: missing });
  assert.equal(r.root, root);
  assert.equal(r.git, false);
  const empty = await resolveProjectRoot(root, { homeDirectory: home, runGit: () => '' });
  assert.equal(empty.git, false, 'an empty answer is not a root');
});

test('project ids follow the memory rules', () => {
  assert.deepEqual(projectIdentity('/x/Punto_Motos'), { id: 'punto-motos', displayName: 'Punto Motos' });
  assert.equal(projectIdentity('/x/my.app').id, 'my-app');
  assert.equal(projectIdentity('/x/--Mi  App--').id, 'mi-app');
  assert.equal(projectIdentity('/x/--Mi  App--').displayName, 'Mi App');
  assert.equal(projectIdentity('/x/2024').id, 'proyecto');
  assert.equal(projectIdentity('/x/__').id, 'proyecto');
  assert.equal(projectIdentity('/x/' + 'a'.repeat(70)).id, 'proyecto');
});
test('a clean project without Git is also found from its frontend folder',async t=>{
 const {root,home}=await temp(t);await fs.mkdir(path.join(root,'frontend'));await fs.mkdir(path.join(root,'.agent-toolkit'));
 await fs.writeFile(path.join(root,'.agent-toolkit/manifest.json'),JSON.stringify({managedBy:'nexakit',entries:[],answers:{cleanProject:{status:'creado'}}}));
 const r=await resolveProjectRoot(path.join(root,'frontend'),{homeDirectory:home,runGit:()=>{throw Error('Git ausente');}});
 assert.equal(r.root,root);assert.equal(r.git,false);
});
