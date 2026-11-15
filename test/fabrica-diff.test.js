import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir, devNull } from 'node:os';
import path from 'node:path';
import { leerDiff, clasificar, LIMITE_DIFF_BYTES } from '../dist/fabrica/diff.js';
import { cargarConfig } from '../dist/fabrica/config.js';
import { ErrorFabrica } from '../dist/fabrica/errores.js';

// El git del usuario no debe influir en los resultados (prefijos, colores, firmas...).
process.env.GIT_CONFIG_GLOBAL = devNull;
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'Prueba';
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'prueba@example.com';

const temporales = [];
test.after(() => {
  for (const dir of temporales) rmSync(dir, { recursive: true, force: true });
});

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim();
}

function crearRepo({ commit = true } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'fabrica-diff-'));
  temporales.push(dir);
  git(dir, 'init', '-q');
  git(dir, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  if (commit) {
    escribir(dir, 'README.txt', 'base\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'base');
  }
  return dir;
}

function escribir(dir, ruta, contenido) {
  const destino = path.join(dir, ...ruta.split('/'));
  mkdirSync(path.dirname(destino), { recursive: true });
  writeFileSync(destino, contenido);
}

const rutas = (resultado) => resultado.archivos.map((a) => a.ruta);

test('leerDiff incluye índice, árbol de trabajo y archivos no seguidos', async () => {
  const dir = crearRepo();
  git(dir, 'checkout', '-q', '-b', 'trabajo');
  escribir(dir, 'confirmado.txt', 'uno\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'confirmado');
  escribir(dir, 'indice.txt', 'dos\n');
  git(dir, 'add', 'indice.txt');
  escribir(dir, 'README.txt', 'base\ncambiado\n');
  escribir(dir, 'nuevo.txt', 'sin seguir\n');

  const r = await leerDiff(dir, 'main');
  assert.deepEqual(
    r.archivos,
    [
      { ruta: 'README.txt', tipo: 'M' },
      { ruta: 'confirmado.txt', tipo: 'A' },
      { ruta: 'indice.txt', tipo: 'A' },
      { ruta: 'nuevo.txt', tipo: 'A' },
    ],
  );
  assert.equal(r.head, git(dir, 'rev-parse', 'HEAD'));
  assert.equal(r.base, git(dir, 'rev-parse', 'main'));
  assert.match(r.texto, /\+cambiado/u);
  assert.match(r.texto, /sin seguir/u);
  assert.match(r.sha256, /^[0-9a-f]{64}$/u);
  assert.deepEqual(await leerDiff(dir, 'main'), r, 'es determinista');
});

test('leerDiff usa el ancestro común, no los cambios que solo llegaron a la base', async () => {
  const dir = crearRepo();
  git(dir, 'checkout', '-q', '-b', 'trabajo');
  escribir(dir, 'mio.txt', 'mio\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'mio');
  git(dir, 'checkout', '-q', 'main');
  escribir(dir, 'ajeno.txt', 'ajeno\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'ajeno');
  git(dir, 'checkout', '-q', 'trabajo');

  const r = await leerDiff(dir, 'main');
  assert.deepEqual(rutas(r), ['mio.txt']);
  assert.equal(r.base, git(dir, 'merge-base', 'main', 'trabajo'));
});

test('leerDiff trata nombres con espacios y comillas, binarios, borrados y renombrados', async () => {
  const dir = crearRepo();
  escribir(dir, 'viejo nombre.txt', 'contenido largo para detectar el renombrado\n'.repeat(5));
  escribir(dir, 'sobra.txt', 'x\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'más archivos');
  git(dir, 'checkout', '-q', '-b', 'trabajo');
  git(dir, 'mv', 'viejo nombre.txt', 'nuevo nombre.txt');
  git(dir, 'rm', '-q', 'sobra.txt');
  escribir(dir, 'a "b" ñ.txt', 'comillas\n');
  writeFileSync(path.join(dir, 'imagen.bin'), Buffer.from([0, 1, 2, 3, 0]));

  const r = await leerDiff(dir, 'main');
  const tipos = Object.fromEntries(r.archivos.map((a) => [a.ruta, a.tipo]));
  assert.deepEqual(tipos, {
    'a "b" ñ.txt': 'A',
    'imagen.bin': 'A',
    'nuevo nombre.txt': 'R',
    'sobra.txt': 'D',
  });
  assert.match(r.texto, /Archivo nuevo: "a \\"b\\" ñ\.txt"/u);
  assert.match(r.texto, /Binario: sin diff textual/u);
  assert.match(r.texto, /rename from viejo nombre\.txt/u);
});

test('sha256 cambia al modificar un archivo no seguido de texto, binario o no UTF-8', async () => {
  const dir = crearRepo();
  const huella = async () => (await leerDiff(dir, 'main')).sha256;
  const casos = [
    ['texto.txt', 'uno\n', 'dos\n'],
    ['dato.bin', Buffer.from([0, 1, 2]), Buffer.from([0, 1, 3])],
    ['latin.txt', Buffer.from('caf\xe9', 'latin1'), Buffer.from('caf\xe1', 'latin1')],
  ];
  for (const [nombre, a, b] of casos) {
    writeFileSync(path.join(dir, nombre), a);
    const antes = await huella();
    assert.equal(await huella(), antes, `${nombre}: estable`);
    writeFileSync(path.join(dir, nombre), b);
    assert.notEqual(await huella(), antes, nombre);
  }
});

test('sha256 cambia al modificar el contenido de un binario seguido', async () => {
  const dir = crearRepo();
  writeFileSync(path.join(dir, 'seguido.bin'), Buffer.from([0, 1, 2]));
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'binario');
  writeFileSync(path.join(dir, 'seguido.bin'), Buffer.from([0, 1, 3]));
  const a = await leerDiff(dir, 'main');
  writeFileSync(path.join(dir, 'seguido.bin'), Buffer.from([0, 1, 4]));
  const b = await leerDiff(dir, 'main');
  assert.match(a.texto, /Binary files/u);
  assert.notEqual(a.sha256, b.sha256);
});

test('sha256 cambia al cambiar el bit ejecutable y al borrar o preparar un archivo', async (t) => {
  const dir = crearRepo();
  escribir(dir, 'run.sh', 'echo\n');
  const sinPreparar = (await leerDiff(dir, 'main')).sha256;
  git(dir, 'add', 'run.sh');
  assert.notEqual((await leerDiff(dir, 'main')).sha256, sinPreparar, 'el índice cuenta');
  if (process.platform === 'win32') {
    t.diagnostic('bit ejecutable no comprobado en Windows');
  } else {
    const antes = (await leerDiff(dir, 'main')).sha256;
    chmodSync(path.join(dir, 'run.sh'), 0o755);
    assert.notEqual((await leerDiff(dir, 'main')).sha256, antes, 'el bit ejecutable cuenta');
  }
  escribir(dir, 'README.txt', 'otro\n');
  const conCambio = (await leerDiff(dir, 'main')).sha256;
  unlinkSync(path.join(dir, 'README.txt'));
  assert.notEqual((await leerDiff(dir, 'main')).sha256, conCambio, 'el borrado cuenta');
});

test('sha256 no colisiona cuando un contenido imita la cabecera de otro archivo', async () => {
  const dir = crearRepo();
  escribir(dir, 'a.txt', 'x');
  escribir(dir, 'b.txt', 'y');
  const dos = await leerDiff(dir, 'main');
  unlinkSync(path.join(dir, 'b.txt'));
  escribir(dir, 'a.txt', 'x\n\nArchivo nuevo: "b.txt"\ny');
  const uno = await leerDiff(dir, 'main');
  assert.equal(uno.texto, dos.texto, 'precondición: el texto de presentación es idéntico');
  assert.notEqual(uno.sha256, dos.sha256);
});

test('leerDiff describe enlaces simbólicos sin seguirlos', async (t) => {
  const dir = crearRepo();
  try {
    symlinkSync('README.txt', path.join(dir, 'enlace'));
  } catch {
    t.skip('no se pueden crear enlaces simbólicos en este sistema');
    return;
  }
  const r = await leerDiff(dir, 'main');
  assert.deepEqual(rutas(r), ['enlace']);
  assert.match(r.texto, /Enlace: README\.txt/u);
});

test('leerDiff rechaza con ErrorFabrica un repositorio sin commits', async () => {
  const dir = crearRepo({ commit: false });
  await assert.rejects(leerDiff(dir, 'main'), (e) => {
    assert.ok(e instanceof ErrorFabrica);
    assert.equal(e.message, 'El repositorio no tiene commits');
    return true;
  });
});

test('leerDiff rechaza una base inexistente o con forma de opción', async () => {
  const dir = crearRepo();
  for (const base of ['no-existe', '--output=/tmp/x', '']) {
    await assert.rejects(leerDiff(dir, base), (e) => {
      assert.ok(e instanceof ErrorFabrica);
      assert.equal(e.message, `No existe la rama base ${base}`);
      return true;
    });
  }
});

test('leerDiff rechaza un diff vacío', async () => {
  const dir = crearRepo();
  await assert.rejects(leerDiff(dir, 'main'), (e) => {
    assert.ok(e instanceof ErrorFabrica);
    assert.equal(e.message, 'No hay cambios que revisar');
    return true;
  });
});

test('leerDiff rechaza un directorio que no es un repositorio', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fabrica-sin-git-'));
  temporales.push(dir);
  process.env.GIT_CEILING_DIRECTORIES = path.dirname(dir);
  try {
    await assert.rejects(leerDiff(dir, 'main'), (e) => e instanceof ErrorFabrica && /repositorio/u.test(e.message));
  } finally {
    delete process.env.GIT_CEILING_DIRECTORIES;
  }
});

test('leerDiff rechaza un diff por encima de 400 KiB indicando el tamaño', async () => {
  const dir = crearRepo();
  escribir(dir, 'grande.txt', 'x'.repeat(LIMITE_DIFF_BYTES + 10));
  await assert.rejects(leerDiff(dir, 'main'), (e) => {
    assert.ok(e instanceof ErrorFabrica);
    assert.match(e.message, /El diff tiene \d+ bytes y supera el límite de 409600 bytes/u);
    return true;
  });
  const dir2 = crearRepo();
  git(dir2, 'checkout', '-q', '-b', 'trabajo');
  escribir(dir2, 'README.txt', 'y'.repeat(LIMITE_DIFF_BYTES + 10) + '\n');
  await assert.rejects(leerDiff(dir2, 'main'), (e) => e instanceof ErrorFabrica && /supera el límite/u.test(e.message));
});

test('leerDiff rechaza un archivo nuevo de más de 1 MiB', async () => {
  const dir = crearRepo();
  writeFileSync(path.join(dir, 'enorme.bin'), Buffer.alloc(1024 * 1024 + 1, 1));
  await assert.rejects(leerDiff(dir, 'main'), (e) => e instanceof ErrorFabrica && /enorme\.bin/u.test(e.message));
});

test('clasificar: hook en código y documentación', () => {
  const c = clasificar([{ ruta: 'src/x-hook.js', tipo: 'M' }, { ruta: 'docs/a.md', tipo: 'A' }], {});
  assert.deepEqual([...c].sort(), ['codigo', 'docs', 'hooks']);
});

test('clasificar: solo documentación no es código', () => {
  const c = clasificar([{ ruta: 'README.md', tipo: 'M' }, { ruta: 'docs/img/a.png', tipo: 'A' }], {});
  assert.deepEqual([...c], ['docs']);
});

test('clasificar: rutas críticas y calientes con patrones glob', () => {
  const config = { rutasCriticas: ['schemas/**'], rutasCalientes: ['src/nucleo/*.ts'] };
  assert.ok(clasificar([{ ruta: 'schemas/a.json', tipo: 'M' }], config).has('critica'));
  assert.ok(!clasificar([{ ruta: 'otro/a.json', tipo: 'M' }], config).has('critica'));
  const caliente = clasificar([{ ruta: 'src/nucleo/a.ts', tipo: 'M' }], config);
  assert.ok(caliente.has('caliente'));
  assert.ok(!caliente.has('critica'));
  assert.ok(!clasificar([{ ruta: 'src/nucleo/sub/a.ts', tipo: 'M' }], config).has('caliente'));
});

test('clasificar: interfaz, pruebas y hooks', () => {
  for (const ruta of ['a.html', 'x/b.css', 'x/c.scss', 'd.jsx', 'e.tsx', 'f.vue', 'g.svelte', 'h.astro']) {
    assert.ok(clasificar([{ ruta, tipo: 'M' }], {}).has('interfaz'), ruta);
  }
  for (const ruta of ['test/a.js', 'tests/a.js', 'src/__tests__/a.js', 'src/a.test.ts', 'src/a.spec.js']) {
    assert.ok(clasificar([{ ruta, tipo: 'M' }], {}).has('pruebas'), ruta);
  }
  for (const ruta of ['hooks/a.js', 'scripts/pre-tool-guard.sh', 'src/mi-hook.js']) {
    assert.ok(clasificar([{ ruta, tipo: 'M' }], {}).has('hooks'), ruta);
  }
  assert.ok(!clasificar([{ ruta: 'src/latest.js', tipo: 'M' }], {}).has('pruebas'));
  assert.ok(!clasificar([{ ruta: 'src/a.js', tipo: 'M' }], {}).has('interfaz'));
});

test('clasificar: los patrones coinciden también con segmentos que empiezan por punto', () => {
  const critica = (ruta, ...patrones) => clasificar([{ ruta, tipo: 'M' }], { rutasCriticas: patrones }).has('critica');
  assert.ok(critica('schemas/.x/a.json', 'schemas/**'));
  assert.ok(critica('.github/a.yml', '**/*.yml'));
  assert.ok(critica('.github/workflows/ci.yml', '.github/**'));
  assert.ok(critica('.env', '*'));
  assert.ok(critica('.husky/pre-commit', '{src,.husky}/**'));
  assert.ok(critica('src/.cache/x.js', 'src/*/x.js'));
  assert.ok(!critica('.github/a.yml', 'otro/**'));
  assert.ok(!critica('x.github/a.yml', '.github/**'));
});

test('clasificar acepta rutas con separador de Windows', () => {
  const c = clasificar([{ ruta: 'schemas\\a.json', tipo: 'M' }], { rutasCriticas: ['schemas/**'] });
  assert.ok(c.has('critica'));
});

test('cargarConfig devuelve los valores por defecto sin archivo', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fabrica-config-'));
  temporales.push(dir);
  assert.deepEqual(await cargarConfig(dir), { paralelismo: 4 });
});

test('cargarConfig lee .nexakit/fabrica.json', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fabrica-config-'));
  temporales.push(dir);
  escribir(dir, '.nexakit/fabrica.json', JSON.stringify({ rutasCriticas: ['schemas/**'], paralelismo: 2 }));
  assert.deepEqual(await cargarConfig(dir), { rutasCriticas: ['schemas/**'], paralelismo: 2 });
});

test('cargarConfig rechaza un archivo inválido nombrando el campo', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fabrica-config-'));
  temporales.push(dir);
  escribir(dir, '.nexakit/fabrica.json', JSON.stringify({ paralelismo: 99, estaciones: { seguridad: { activa: 'sí' } } }));
  await assert.rejects(cargarConfig(dir), (e) => {
    assert.ok(e instanceof ErrorFabrica);
    assert.match(e.message, /«paralelismo»/u);
    assert.match(e.message, /«estaciones\.seguridad\.activa»/u);
    return true;
  });
  escribir(dir, '.nexakit/fabrica.json', '{ no es json');
  await assert.rejects(cargarConfig(dir), (e) => e instanceof ErrorFabrica && /JSON válido/u.test(e.message));
});
