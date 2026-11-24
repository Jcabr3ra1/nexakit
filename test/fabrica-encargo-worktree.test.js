import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, readlinkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gitConfigGlobalVacio } from '../test-support/git-aislado.js';
import { borrarWorktree, buscarGitAnidado, cambiosDelWorktree, crearWorktree, diffDelWorktree } from '../dist/fabrica/encargo/worktree.js';
import { fileSymlinkSkipReason } from '../testing/symlink-capability.js';

const SIN_ENLACES = process.platform === 'win32' || fileSymlinkSkipReason();
const POSIX = process.platform !== 'win32';

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
  if (POSIX) {
    for (const ruta of [path.join(home, '.nexakit'), path.join(home, '.nexakit', 'encargos'), path.dirname(w.dir), w.dir]) {
      assert.equal(modo(ruta), 0o700, ruta);
    }
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
  const diff = (await diffDelWorktree(w)).toString('utf8');
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
  assert.equal((await diffDelWorktree(w)).length, 0);
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

test('no sigue enlaces: si encargos es un enlace, se rechaza', { skip: SIN_ENLACES }, async () => {
  const { raiz, home } = entorno();
  const otro = mkdtempSync(path.join(tmpdir(), 'enc-otro-'));
  temporales.push(otro);
  mkdirSync(path.join(home, '.nexakit'), { mode: 0o700 });
  symlinkSync(otro, path.join(home, '.nexakit', 'encargos'), 'dir');
  await assert.rejects(crearWorktree(raiz, home), /no sigue enlaces/u);
  assert.deepEqual(readdirSync(otro), []);
});

test('el diff de un archivo Latin-1 se conserva byte a byte y git apply --check lo acepta', async () => {
  const { raiz, home } = entorno();
  writeFileSync(path.join(raiz, 'latin.txt'), Buffer.from('caf\xe9\n', 'latin1'));
  git(raiz, 'add', '-A');
  git(raiz, 'commit', '-q', '-m', 'latin');
  const w = await crearWorktree(raiz, home);
  writeFileSync(path.join(w.dir, 'latin.txt'), Buffer.from('caf\xe9 con leche\n', 'latin1'));
  const diff = await diffDelWorktree(w);
  assert.ok(Buffer.isBuffer(diff));
  assert.ok(diff.includes(Buffer.from('caf\xe9 con leche', 'latin1')));
  assert.ok(!diff.includes(Buffer.from([0xef, 0xbf, 0xbd])));
  const destino = mkdtempSync(path.join(tmpdir(), 'enc-latin-'));
  temporales.push(destino);
  git(destino, 'init', '-q');
  writeFileSync(path.join(destino, 'latin.txt'), Buffer.from('caf\xe9\n', 'latin1'));
  const parche = path.join(destino, '..', `${path.basename(destino)}.diff`);
  writeFileSync(parche, diff);
  temporales.push(parche);
  git(destino, 'apply', '--check', parche);
});

test('un .git reescrito por la IA no hace ejecutar nada al leer el diff', async () => {
  const { raiz, home } = entorno();
  const w = await crearWorktree(raiz, home);
  const testigo = path.join(home, 'testigo');
  const malo = mkdtempSync(path.join(tmpdir(), 'enc-malo-'));
  temporales.push(malo);
  cpSync(path.join(raiz, '.git'), path.join(malo, 'gitdir'), { recursive: true });
  const config = path.join(malo, 'gitdir', 'config');
  writeFileSync(config, `${readFileSync(config, 'utf8')}[core]\n\tfsmonitor = touch ${testigo}; true\n`);
  // En Windows git marca `.git` como oculto y abrirlo para escribir da EPERM: se borra antes (como haría la IA).
  rmSync(path.join(w.dir, '.git'), { force: true });
  writeFileSync(path.join(w.dir, '.git'), `gitdir: ${path.join(malo, 'gitdir')}\n`);
  writeFileSync(path.join(w.dir, 'nuevo.txt'), 'x\n');
  // Comprobación previa: sin las protecciones, git sí ejecutaría la orden.
  try {
    git(w.dir, 'add', '-N', '--all', '--', '.');
  } catch {}
  const explotable = existsSync(testigo);
  rmSync(testigo, { force: true });
  const diff = await diffDelWorktree(w);
  assert.equal(existsSync(testigo), false, 'la orden de fsmonitor no debe ejecutarse');
  assert.match(diff.toString('utf8'), /b\/nuevo\.txt/u);
  if (!explotable) console.log('aviso: esta versión de git no ejecutó fsmonitor en la comprobación previa');
});

test('un GIT_DIR heredado no desvía las órdenes al repo equivocado', async () => {
  const { raiz, home } = entorno();
  const { raiz: otro } = entorno();
  const indiceAntes = git(otro, 'ls-files', '--stage');
  const previo = process.env.GIT_DIR;
  process.env.GIT_DIR = path.join(otro, '.git');
  let w;
  try {
    w = await crearWorktree(raiz, home);
    writeFileSync(path.join(w.dir, 'nuevo.txt'), 'x\n');
    assert.match((await diffDelWorktree(w)).toString('utf8'), /b\/nuevo\.txt/u);
    assert.equal(await borrarWorktree(w), null);
  } finally {
    if (previo === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = previo;
  }
  assert.equal(git(otro, 'worktree', 'list').split('\n').length, 1);
  assert.equal(git(otro, 'ls-files', '--stage'), indiceAntes);
  assert.equal(git(otro, 'status', '--porcelain'), '');
  assert.equal(git(raiz, 'worktree', 'list').split('\n').length, 1);
});

test('si falla la creación se limpia todo, también la entrada de .git/worktrees', async () => {
  const { raiz, home } = entorno();
  await assert.rejects(
    crearWorktree(raiz, home, {
      despuesDeCrear: async () => {
        throw new Error('fallo simulado');
      },
    }),
    /fallo simulado/u,
  );
  assert.equal(git(raiz, 'worktree', 'list').split('\n').length, 1);
  assert.equal(existsSync(path.join(raiz, '.git', 'worktrees')) ? readdirSync(path.join(raiz, '.git', 'worktrees')).length : 0, 0);
  assert.deepEqual(readdirSync(path.join(home, '.nexakit', 'encargos')), []);
});

function conNodeModules(ignorado) {
  const { raiz, home } = entorno();
  if (ignorado) {
    writeFileSync(path.join(raiz, '.gitignore'), 'node_modules\n');
    git(raiz, 'add', '-A');
    git(raiz, 'commit', '-q', '-m', 'ignora');
  }
  mkdirSync(path.join(raiz, 'node_modules', 'dep'), { recursive: true });
  writeFileSync(path.join(raiz, 'node_modules', 'dep', 'i.js'), 'x\n');
  return { raiz, home };
}

test('enlaza node_modules ignorado, no entra en el diff y borrar no toca el real', { skip: SIN_ENLACES }, async () => {
  const { raiz, home } = conNodeModules(true);
  const w = await crearWorktree(raiz, home);
  const enlace = path.join(w.dir, 'node_modules');
  assert.ok(lstatSync(enlace).isSymbolicLink());
  assert.equal(readlinkSync(enlace), path.join(raiz, 'node_modules'));
  assert.equal(readFileSync(path.join(enlace, 'dep', 'i.js'), 'utf8'), 'x\n');
  writeFileSync(path.join(w.dir, 'a.txt'), 'dos\n');
  await diffDelWorktree(w);
  assert.deepEqual((await cambiosDelWorktree(w)).map((c) => c.ruta), ['a.txt']);
  await borrarWorktree(w);
  assert.equal(existsSync(w.dir), false);
  assert.equal(readFileSync(path.join(raiz, 'node_modules', 'dep', 'i.js'), 'utf8'), 'x\n');
});

test('no enlaza node_modules si no está ignorado por git', async () => {
  const { raiz, home } = conNodeModules(false);
  const w = await crearWorktree(raiz, home);
  assert.equal(existsSync(path.join(w.dir, 'node_modules')), false);
  await borrarWorktree(w);
});

test('si el patrón solo ignora carpetas (node_modules/), el enlace no se crea para no entrar en el diff', async () => {
  const { raiz, home } = conNodeModules(true);
  writeFileSync(path.join(raiz, '.gitignore'), 'node_modules/\n');
  git(raiz, 'add', '-A');
  git(raiz, 'commit', '-q', '-m', 'patron carpeta');
  const w = await crearWorktree(raiz, home);
  if (POSIX) assert.equal(existsSync(path.join(w.dir, 'node_modules')), false);
  else {
    // En Windows el enlace es una junction y git la trata como carpeta: `node_modules/` sí la ignora, así que puede quedar.
    // Lo que importa es lo mismo: no entra en el diff.
    writeFileSync(path.join(w.dir, 'a.txt'), 'dos\n');
    const diff = (await diffDelWorktree(w)).toString('utf8');
    assert.doesNotMatch(diff, /node_modules/u);
    assert.deepEqual((await cambiosDelWorktree(w)).map((c) => c.ruta), ['a.txt']);
  }
  await borrarWorktree(w);
});

test('buscarGitAnidado encuentra un .git anidado de cualquier tipo, salta el de la raíz y no sigue enlaces', async () => {
  const { raiz, home } = entorno();
  const w = await crearWorktree(raiz, home);
  try {
    assert.equal(await buscarGitAnidado(w.dir), null, 'el .git de la raíz no cuenta');
    if (!SIN_ENLACES) {
      // Un enlace a una carpeta con un .git dentro no se sigue.
      symlinkSync(raiz, path.join(w.dir, 'enlace-al-repo'), 'dir');
      assert.equal(await buscarGitAnidado(w.dir), null);
    }
    mkdirSync(path.join(w.dir, 'a', 'b'), { recursive: true });
    writeFileSync(path.join(w.dir, 'a', 'b', '.git'), 'gitdir: /tmp/otro\n');
    assert.equal(await buscarGitAnidado(w.dir), 'a/b/.git');
  } finally {
    await borrarWorktree(w);
  }
});

test('el diff no entra en un repo anidado aunque se llame sin comprobarlo antes: su filtro clean no corre', async () => {
  const { raiz, home } = entorno();
  const w = await crearWorktree(raiz, home);
  const testigo = path.join(home, 'testigo-filtro');
  const sub = path.join(w.dir, 'sub');
  mkdirSync(sub);
  git(sub, 'init', '-q');
  writeFileSync(path.join(sub, 'f.txt'), 'hola\n');
  git(sub, 'add', '-A');
  git(sub, 'commit', '-q', '-m', 'sub');
  git(sub, 'config', 'filter.testigo.clean', `"${process.execPath}" -e "require('fs').writeFileSync(process.argv[1], 'x')" "${testigo}"`);
  writeFileSync(path.join(sub, '.gitattributes'), '* filter=testigo\n');
  writeFileSync(path.join(sub, 'f.txt'), 'HOLA\n');
  const hace = new Date(Date.now() - 3_600_000);
  utimesSync(path.join(sub, 'f.txt'), hace, hace);
  try {
    await diffDelWorktree(w).catch(() => {});
    assert.equal(existsSync(testigo), false, 'diff.ignoreSubmodules=all: git no mira dentro del repo anidado');
  } finally {
    await borrarWorktree(w);
  }
});
