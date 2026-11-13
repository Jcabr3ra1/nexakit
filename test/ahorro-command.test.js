import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runAhorroCommand } from '../src/ahorro-command.js';

const AHORA = 1700000000000;
const DIA = 24 * 60 * 60 * 1000;

async function ejecutar(argv, contenido) {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ahorro-')));
  if (contenido !== undefined) {
    await fs.mkdir(path.join(home, '.nexakit'));
    await fs.writeFile(path.join(home, '.nexakit', 'ahorro.jsonl'), contenido);
  }
  let salida = '';
  let error = '';
  const code = await runAhorroCommand(
    argv,
    { out: (m) => { salida += m; }, err: (m) => { error += m; } },
    { homeDirectory: home, tempDirectory: path.join(home, 'temporal-ausente'), now: AHORA },
  );
  return { code, salida, error };
}

const linea = (fecha, antes, despues) => JSON.stringify({ fecha, antes, despues, lineasAntes: 10, lineasDespues: 5 });

test('sin registro explica que aún no hay recortes', async () => {
  const { code, salida } = await ejecutar([]);
  assert.equal(code, 0);
  assert.match(salida, /Aún no hay recortes/u);
  assert.match(salida, /nexakit-ahorro/u);
});

test('resume los últimos 7 días y el total, e ignora líneas inválidas', async () => {
  const contenido = [linea(AHORA - DIA, 1000, 200), 'no es json', '{"fecha":1}', linea(AHORA - 30 * DIA, 400, 0), ''].join('\n');
  const { code, salida } = await ejecutar([], contenido);
  assert.equal(code, 0);
  assert.match(salida, /Últimos 7 días: 1 recortes, 800 caracteres evitados, ~200 tokens/u);
  assert.match(salida, /Total: 2 recortes, 1200 caracteres evitados, ~300 tokens/u);
  assert.match(salida, /estimación/u);
});

test('--json imprime el mismo resumen', async () => {
  const { code, salida } = await ejecutar(['--json'], `${linea(AHORA, 1000, 200)}\n`);
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(salida), {
    ultimos7Dias: { recortes: 1, caracteresEvitados: 800, tokensEstimados: 200 },
    total: { recortes: 1, caracteresEvitados: 800, tokensEstimados: 200 },
  });
});

test('un argumento desconocido devuelve 2', async () => {
  const { code, error } = await ejecutar(['--x']);
  assert.equal(code, 2);
  assert.match(error, /Uso/u);
});

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ahorro-fuentes-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const temporal = path.join(root, 'tmp');
  const privado = path.join(temporal, `nexakit-codex-${process.getuid?.() ?? 'user'}`);
  await fs.mkdir(home);
  await fs.mkdir(temporal);
  async function guardar(base, contenido = linea(AHORA, 1000, 200)) {
    await fs.mkdir(path.join(base, '.nexakit'), { recursive: true });
    await fs.writeFile(path.join(base, '.nexakit', 'ahorro.jsonl'), contenido);
  }
  async function leer(options = {}) {
    let salida = '';
    let error = '';
    const code = await runAhorroCommand(['--json'], {
      out: m => { salida += m; }, err: m => { error += m; },
    }, { homeDirectory: home, tempDirectory: temporal, now: AHORA, ...options });
    assert.equal(code, 0);
    assert.equal(error, '');
    return JSON.parse(salida);
  }
  return { root, home, temporal, privado, guardar, leer };
}

test('suma hogar y temporal sin exponer comando ni prompt', async t => {
  const f = await fixture(t);
  await f.guardar(f.home, linea(AHORA - 30 * DIA, 400, 0));
  await f.guardar(f.privado, JSON.stringify({ fecha: AHORA, antes: 1000, despues: 200, comando: 'SECRETO', prompt: 'SECRETO' }));
  const resumen = await f.leer();
  assert.deepEqual(resumen, {
    ultimos7Dias: { recortes: 1, caracteresEvitados: 800, tokensEstimados: 200 },
    total: { recortes: 2, caracteresEvitados: 1200, tokensEstimados: 300 },
  });
  assert.ok(!JSON.stringify(resumen).includes('SECRETO'));
});

test('cuenta una sola vez cuando ambas fuentes son la misma ruta', async t => {
  const f = await fixture(t);
  await f.guardar(f.privado);
  assert.equal((await f.leer({ homeDirectory: f.privado })).total.recortes, 1);
});

test('fuentes ausentes no crean directorios y permiten leer la otra fuente', async t => {
  const f = await fixture(t);
  assert.equal((await f.leer()).total.recortes, 0);
  assert.deepEqual(await fs.readdir(f.home), []);
  assert.deepEqual(await fs.readdir(f.temporal), []);
  await f.guardar(f.privado);
  assert.equal((await f.leer({ homeDirectory: path.join(f.root, 'ausente') })).total.recortes, 1);
  await assert.rejects(fs.stat(path.join(f.root, 'ausente')), { code: 'ENOENT' });
});

test('resuelve el directorio temporal del sistema antes de buscar métricas', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  await f.guardar(f.privado);
  const alias = path.join(f.root, 'tmp-alias');
  await fs.symlink(f.temporal, alias);
  assert.equal((await f.leer({ tempDirectory: alias })).total.recortes, 1);
});

for (const fuente of ['home', 'privado']) {
  for (const enlace of ['symlink', 'hardlink', 'directorio', 'ancestro']) {
    test(`rechaza ${enlace} en registro ${fuente}`, { skip: process.platform === 'win32' }, async t => {
      const f = await fixture(t);
      const base = f[fuente];
      const externo = path.join(f.root, 'externo');
      await f.guardar(externo);
      await fs.mkdir(base, { recursive: true });
      if (enlace === 'directorio') {
        await fs.symlink(path.join(externo, '.nexakit'), path.join(base, '.nexakit'));
      } else if (enlace === 'ancestro') {
        await fs.rmdir(base);
        await fs.symlink(externo, base);
      } else {
        await fs.mkdir(path.join(base, '.nexakit'));
        const source = path.join(externo, '.nexakit', 'ahorro.jsonl');
        const target = path.join(base, '.nexakit', 'ahorro.jsonl');
        if (enlace === 'symlink') await fs.symlink(source, target);
        else await fs.link(source, target);
      }
      assert.equal((await f.leer()).total.recortes, 0);
    });
  }
  test(`ignora registro sobredimensionado en ${fuente} y lee la otra fuente`, async t => {
    const f = await fixture(t);
    await f.guardar(f[fuente], linea(AHORA, 9000, 200) + '\n' + ' '.repeat(2 * 1024 * 1024));
    await f.guardar(f[fuente === 'home' ? 'privado' : 'home']);
    assert.deepEqual((await f.leer()).total, { recortes: 1, caracteresEvitados: 800, tokensEstimados: 200 });
  });
}

test('usa el sufijo user cuando getuid no proporciona UID', { skip: typeof process.getuid !== 'function' }, async t => {
  t.mock.method(process, 'getuid', () => undefined);
  const f = await fixture(t);
  await f.guardar(f.privado);
  assert.equal(path.basename(f.privado), 'nexakit-codex-user');
  assert.equal((await f.leer()).total.recortes, 1);
});
