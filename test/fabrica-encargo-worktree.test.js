import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gitConfigGlobalVacio } from '../test-support/git-aislado.js';
import { borrarWorktree, crearWorktree, diffDelWorktree } from '../dist/fabrica/encargo/worktree.js';

process.env.GIT_CONFIG_GLOBAL = gitConfigGlobalVacio;
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'Prueba';
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'prueba@example.com';

const temporales = [];
test.after(() => {
  for (const dir of temporales) rmSync(dir, { recursive: true, force: true });
});

const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();

function entorno() {
  const raiz = mkdtempSync(path.join(tmpdir(), 'enc-repo-'));
  const home = mkdtempSync(path.join(tmpdir(), 'enc-home-'));
  temporales.push(raiz, home);
  git(raiz, 'init', '-q');
  writeFileSync(path.join(raiz, 'a.txt'), 'uno\n');
  git(raiz, 'add', '-A');
  git(raiz, 'commit', '-q', '-m', 'base');
  return { raiz, home };
}

const modo = (ruta) => lstatSync(ruta).mode & 0o777;

test('crea el worktree de HEAD con permisos 0o700 y nombre neutro', async () => {
  const { raiz, home } = entorno();
  const w = await crearWorktree(raiz, home);
  assert.equal(w.dir, path.join(home, '.nexakit', 'encargos', w.id, 'repo'));
  assert.equal(w.base, git(raiz, 'rev-parse', 'HEAD'));
  assert.deepEqual(w.avisos, []);
  assert.equal(readFileSync(path.join(w.dir, 'a.txt'), 'utf8'), 'uno\n');
  for (const ruta of [path.join(home, '.nexakit'), path.join(home, '.nexakit', 'encargos'), path.dirname(w.dir), w.dir]) {
    assert.equal(modo(ruta), 0o700, ruta);
  }
  assert.doesNotMatch(w.id, /encargo|nexakit|banco/iu);
  assert.match(git(raiz, 'worktree', 'list'), new RegExp(w.id));
});

test('avisa de los cambios sin commit y no los copia', async () => {
  const { raiz, home } = entorno();
  writeFileSync(path.join(raiz, 'a.txt'), 'sucio\n');
  const w = await crearWorktree(raiz, home);
  assert.equal(w.avisos.length, 1);
  assert.match(w.avisos[0], /sin commit/u);
  assert.equal(readFileSync(path.join(w.dir, 'a.txt'), 'utf8'), 'uno\n');
});

test('el diff incluye un archivo modificado, uno nuevo y un binario, y git apply lo aplica', async () => {
  const { raiz, home } = entorno();
  const w = await crearWorktree(raiz, home);
  writeFileSync(path.join(w.dir, 'a.txt'), 'dos\n');
  writeFileSync(path.join(w.dir, 'nuevo.txt'), 'hola\n');
  writeFileSync(path.join(w.dir, 'datos.bin'), Buffer.from([0, 1, 2, 255, 0, 9]));
  const diff = await diffDelWorktree(w);
  assert.match(diff, /b\/a\.txt/u);
  assert.match(diff, /b\/nuevo\.txt/u);
  assert.match(diff, /GIT binary patch/u);

  const destino = mkdtempSync(path.join(tmpdir(), 'enc-aplicar-'));
  temporales.push(destino);
  git(destino, 'init', '-q');
  writeFileSync(path.join(destino, 'a.txt'), 'uno\n');
  const parche = path.join(destino, '..', `${path.basename(destino)}.diff`);
  writeFileSync(parche, diff);
  temporales.push(parche);
  git(destino, 'apply', parche);
  assert.equal(readFileSync(path.join(destino, 'a.txt'), 'utf8'), 'dos\n');
  assert.equal(readFileSync(path.join(destino, 'nuevo.txt'), 'utf8'), 'hola\n');
  assert.deepEqual([...readFileSync(path.join(destino, 'datos.bin'))], [0, 1, 2, 255, 0, 9]);
});

test('sin cambios el diff está vacío', async () => {
  const { raiz, home } = entorno();
  const w = await crearWorktree(raiz, home);
  assert.equal(await diffDelWorktree(w), '');
});

test('borra el worktree tras un error y deja limpio el registro de git', async () => {
  const { raiz, home } = entorno();
  const w = await crearWorktree(raiz, home);
  writeFileSync(path.join(w.dir, 'sucio.txt'), 'x\n');
  try {
    throw new Error('el conector falló');
  } catch {
    assert.equal(await borrarWorktree(w), null);
  }
  assert.equal(existsSync(w.dir), false);
  assert.doesNotMatch(git(raiz, 'worktree', 'list'), new RegExp(w.id));
});

test('borrar nunca lanza: con la carpeta ya borrada limpia el registro y con un fallo devuelve aviso', async () => {
  const { raiz, home } = entorno();
  const w = await crearWorktree(raiz, home);
  rmSync(w.dir, { recursive: true, force: true });
  assert.equal(await borrarWorktree(w), null);
  assert.doesNotMatch(git(raiz, 'worktree', 'list'), new RegExp(w.id));
  const aviso = await borrarWorktree({ ...w, raiz: path.join(home, 'no-existe') });
  assert.equal(typeof aviso, 'string');
  assert.match(aviso, /worktree/u);
});

test('el repo real no se toca: ni archivos ni estado', async () => {
  const { raiz, home } = entorno();
  const antes = { estado: git(raiz, 'status', '--porcelain'), head: git(raiz, 'rev-parse', 'HEAD'), ramas: git(raiz, 'branch', '--list') };
  const w = await crearWorktree(raiz, home);
  writeFileSync(path.join(w.dir, 'a.txt'), 'cambiado\n');
  writeFileSync(path.join(w.dir, 'otro.txt'), 'x\n');
  await diffDelWorktree(w);
  await borrarWorktree(w);
  assert.equal(readFileSync(path.join(raiz, 'a.txt'), 'utf8'), 'uno\n');
  assert.equal(existsSync(path.join(raiz, 'otro.txt')), false);
  assert.deepEqual({ estado: git(raiz, 'status', '--porcelain'), head: git(raiz, 'rev-parse', 'HEAD'), ramas: git(raiz, 'branch', '--list') }, antes);
});

test('no sigue enlaces: si encargos es un enlace, se rechaza', async () => {
  const { raiz, home } = entorno();
  const otro = mkdtempSync(path.join(tmpdir(), 'enc-otro-'));
  temporales.push(otro);
  mkdirSync(path.join(home, '.nexakit'), { mode: 0o700 });
  execFileSync('ln', ['-s', otro, path.join(home, '.nexakit', 'encargos')]);
  await assert.rejects(crearWorktree(raiz, home), /no sigue enlaces/u);
  assert.deepEqual(execFileSync('ls', [otro], { encoding: 'utf8' }).trim(), '');
});
