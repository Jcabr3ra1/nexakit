import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lutimesSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GRACIA_ILEGIBLE_MS, publicarCandado, tomarCandadoEncargos } from '../dist/fabrica/encargo/candado.js';

const pidMuerto = () => Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout);

function casa(t) {
  const home = mkdtempSync(path.join(tmpdir(), 'nexakit-candado-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(path.join(home, '.nexakit', 'encargos'), { recursive: true, mode: 0o700 });
  const carpeta = path.join(home, '.nexakit', 'encargos');
  return { home, carpeta, archivo: path.join(carpeta, '.candado') };
}

const envejecer = (archivo, ms) => {
  const f = new Date(Date.now() - ms);
  utimesSync(archivo, f, f);
};

/** Como `envejecer`, pero sobre el propio enlace simbólico. */
const envejecerEnlace = (archivo, ms) => {
  const f = new Date(Date.now() - ms);
  lutimesSync(archivo, f, f);
};

const vivo = () => JSON.stringify({ pid: process.pid, id: 'otro', fecha: '2026-01-01T00:00:00.000Z' });

test('carrera sobre un candado muerto: solo uno lo obtiene y el vivo no se pierde', async (t) => {
  const { home, archivo } = casa(t);
  for (let ronda = 0; ronda < 5; ronda += 1) {
    writeFileSync(archivo, JSON.stringify({ pid: pidMuerto(), id: null, fecha: '2020-01-01T00:00:00.000Z' }));
    const r = await Promise.allSettled(Array.from({ length: 8 }, () => tomarCandadoEncargos(home)));
    assert.equal(r.filter((x) => x.status === 'fulfilled').length, 1, 'solo uno gana');
    for (const x of r.filter((y) => y.status === 'rejected')) assert.match(String(x.reason.message), /encargo/u);
    assert.equal(JSON.parse(readFileSync(archivo, 'utf8')).pid, process.pid, 'el candado vivo sigue ahí');
    await r.find((x) => x.status === 'fulfilled').value.liberar();
    assert.equal(existsSync(archivo), false);
  }
});

test('un candado vacío reciente no se roba; uno vacío viejo sí', async (t) => {
  const { home, archivo } = casa(t);
  writeFileSync(archivo, '');
  await assert.rejects(tomarCandadoEncargos(home), /otro encargo en marcha/u);
  assert.equal(existsSync(archivo), true, 'el candado reciente sigue en su sitio');
  envejecer(archivo, 120_000);
  const c = await tomarCandadoEncargos(home);
  assert.equal(JSON.parse(readFileSync(archivo, 'utf8')).pid, process.pid);
  await c.liberar();
});

test('un candado ilegible reciente no se roba; viejo sí', async (t) => {
  const { home, archivo } = casa(t);
  writeFileSync(archivo, 'basura');
  await assert.rejects(tomarCandadoEncargos(home), /otro encargo en marcha/u);
  envejecer(archivo, 120_000);
  await (await tomarCandadoEncargos(home)).liberar();
  assert.equal(existsSync(archivo), false);
});

test('el umbral de gracia es de 30 s exactos: 25 s no se roba y 31 s sí', async (t) => {
  assert.equal(GRACIA_ILEGIBLE_MS, 30_000);
  const { home, archivo } = casa(t);
  writeFileSync(archivo, '');
  envejecer(archivo, GRACIA_ILEGIBLE_MS - 5_000);
  await assert.rejects(tomarCandadoEncargos(home), /otro encargo en marcha/u);
  assert.equal(readFileSync(archivo, 'utf8'), '', 'el candado de 25 s sigue intacto');
  envejecer(archivo, GRACIA_ILEGIBLE_MS + 1_000);
  const c = await tomarCandadoEncargos(home);
  assert.equal(JSON.parse(readFileSync(archivo, 'utf8')).pid, process.pid);
  await c.liberar();
});

test('otro proceso sustituye el candado muerto por uno vivo entre la inspección y el robo: el vivo queda intacto', async (t) => {
  const { home, carpeta, archivo } = casa(t);
  writeFileSync(archivo, JSON.stringify({ pid: pidMuerto(), id: null, fecha: '2020-01-01T00:00:00.000Z' }));
  let llamadas = 0;
  await assert.rejects(
    tomarCandadoEncargos(home, {
      alAntesDeRobar: () => {
        llamadas += 1;
        unlinkSync(archivo);
        writeFileSync(archivo, vivo());
      },
    }),
    /otro encargo en marcha/u,
  );
  assert.equal(llamadas, 1);
  assert.equal(readFileSync(archivo, 'utf8'), vivo(), 'el candado vivo no se toca');
  assert.deepEqual(readdirSync(carpeta), ['.candado'], 'sin temporales ni auxiliar de robo');
});

test('un candado vacío viejo sustituido por uno vacío reciente no se roba (solo lo evita el mtime)', async (t) => {
  const { home, carpeta, archivo } = casa(t);
  writeFileSync(archivo, '');
  envejecer(archivo, 120_000);
  await assert.rejects(
    tomarCandadoEncargos(home, { alAntesDeRobar: () => { unlinkSync(archivo); writeFileSync(archivo, ''); } }),
    /otro encargo en marcha/u,
  );
  assert.equal(existsSync(archivo), true);
  assert.equal(readFileSync(archivo, 'utf8'), '');
  assert.deepEqual(readdirSync(carpeta), ['.candado']);
});

test('un enlace simbólico como candado no se sigue: se juzga por sí mismo y no se toca el destino', async (t) => {
  const { home, carpeta, archivo } = casa(t);
  const destino = path.join(home, 'destino.txt');
  writeFileSync(destino, 'no me toques');
  symlinkSync(destino, archivo);
  await assert.rejects(tomarCandadoEncargos(home), /otro encargo en marcha/u);
  assert.equal(readFileSync(destino, 'utf8'), 'no me toques');
  envejecerEnlace(archivo, 120_000);
  const c = await tomarCandadoEncargos(home);
  assert.equal(readFileSync(destino, 'utf8'), 'no me toques', 'el destino sigue igual');
  assert.equal(statSync(archivo).isFile(), true);
  assert.equal(JSON.parse(readFileSync(archivo, 'utf8')).pid, process.pid);
  await c.liberar();
  assert.deepEqual(readdirSync(carpeta), []);
});

test('un candado de más de 4096 bytes es ilegible: reciente no se roba, viejo sí', async (t) => {
  const { home, archivo } = casa(t);
  writeFileSync(archivo, JSON.stringify({ pid: pidMuerto(), id: null, fecha: 'x'.repeat(5000) }));
  await assert.rejects(tomarCandadoEncargos(home), /otro encargo en marcha/u);
  envejecer(archivo, 120_000);
  await (await tomarCandadoEncargos(home)).liberar();
  assert.equal(existsSync(archivo), false);
});

test('un JSON sin pid numérico es ilegible: reciente no se roba, viejo sí', async (t) => {
  const { home, archivo } = casa(t);
  for (const texto of ['{}', '{"pid":"123"}', '[1]', 'null']) {
    writeFileSync(archivo, texto);
    await assert.rejects(tomarCandadoEncargos(home), /otro encargo en marcha/u, texto);
    assert.equal(readFileSync(archivo, 'utf8'), texto);
    envejecer(archivo, 120_000);
    await (await tomarCandadoEncargos(home)).liberar();
    assert.equal(existsSync(archivo), false);
  }
});

test('el auxiliar .candado.robo: reciente bloquea; abandonado (más de 30 s) se recupera', async (t) => {
  const { home, carpeta, archivo } = casa(t);
  const robo = `${archivo}.robo`;
  writeFileSync(archivo, JSON.stringify({ pid: pidMuerto(), id: null, fecha: '2020-01-01T00:00:00.000Z' }));
  mkdirSync(robo, { mode: 0o700 });
  await assert.rejects(tomarCandadoEncargos(home), /otro encargo en marcha/u);
  assert.equal(existsSync(robo), true, 'el auxiliar reciente de otro no se toca');
  assert.equal(JSON.parse(readFileSync(archivo, 'utf8')).id, null, 'el candado muerto sigue donde estaba');
  envejecer(robo, GRACIA_ILEGIBLE_MS + 1_000);
  const c = await tomarCandadoEncargos(home);
  assert.equal(JSON.parse(readFileSync(archivo, 'utf8')).pid, process.pid);
  assert.equal(existsSync(robo), false);
  await c.liberar();
  assert.deepEqual(readdirSync(carpeta), []);
});

test('un .candado.robo abandonado que es un enlace simbólico se quita sin seguirlo', async (t) => {
  const { home, archivo } = casa(t);
  const robo = `${archivo}.robo`;
  const ajena = path.join(home, 'ajena');
  mkdirSync(ajena);
  writeFileSync(path.join(ajena, 'dentro.txt'), 'intacto');
  writeFileSync(archivo, JSON.stringify({ pid: pidMuerto(), id: null, fecha: '2020-01-01T00:00:00.000Z' }));
  symlinkSync(ajena, robo);
  envejecerEnlace(robo, GRACIA_ILEGIBLE_MS + 1_000);
  await (await tomarCandadoEncargos(home)).liberar();
  assert.equal(readFileSync(path.join(ajena, 'dentro.txt'), 'utf8'), 'intacto');
  assert.equal(existsSync(robo), false);
});

test('al tomar el candado se borran los temporales con más de 30 s y se respetan los recientes', async (t) => {
  const { home, carpeta } = casa(t);
  const ajeno = path.join(home, 'ajeno.txt');
  writeFileSync(ajeno, 'intacto');
  const viejos = ['.candado.aaaa.tmp', '.candado.bbbb.muerto'];
  for (const n of viejos) {
    writeFileSync(path.join(carpeta, n), 'x');
    envejecer(path.join(carpeta, n), GRACIA_ILEGIBLE_MS + 1_000);
  }
  symlinkSync(ajeno, path.join(carpeta, '.candado.cccc.tmp'));
  envejecerEnlace(path.join(carpeta, '.candado.cccc.tmp'), GRACIA_ILEGIBLE_MS + 1_000);
  writeFileSync(path.join(carpeta, '.candado.dddd.tmp'), 'x');
  envejecer(path.join(carpeta, '.candado.dddd.tmp'), GRACIA_ILEGIBLE_MS - 5_000);
  writeFileSync(path.join(carpeta, 'otro.tmp'), 'x');
  envejecer(path.join(carpeta, 'otro.tmp'), 120_000);
  const c = await tomarCandadoEncargos(home);
  assert.deepEqual(readdirSync(carpeta).sort(), ['.candado', '.candado.dddd.tmp', 'otro.tmp']);
  assert.equal(readFileSync(ajeno, 'utf8'), 'intacto', 'el destino del enlace no se toca');
  await c.liberar();
});

test('publicarCandado recurre a wx ante cualquier error de link distinto de EEXIST y no deja temporales', async (t) => {
  for (const codigo of ['EPERM', 'ENOTSUP', 'EXDEV', 'ENOSYS', 'EIO', 'EACCES']) {
    const { carpeta, archivo } = casa(t);
    const enlazar = async () => { throw Object.assign(new Error('sin enlaces'), { code: codigo }); };
    await publicarCandado(archivo, 'hola\n', enlazar);
    assert.equal(readFileSync(archivo, 'utf8'), 'hola\n', codigo);
    if (process.platform !== 'win32') assert.equal(statSync(archivo).mode & 0o777, 0o600, codigo);
    assert.deepEqual(readdirSync(carpeta), ['.candado'], codigo);
  }
});

test('publicarCandado: EEXIST de link se propaga sin sobrescribir; con fallback, el candado ajeno tampoco se pisa', async (t) => {
  const { carpeta, archivo } = casa(t);
  writeFileSync(archivo, 'ajeno');
  const eexist = async () => { throw Object.assign(new Error('existe'), { code: 'EEXIST' }); };
  await assert.rejects(publicarCandado(archivo, 'mio', eexist), { code: 'EEXIST' });
  const eperm = async () => { throw Object.assign(new Error('no'), { code: 'EPERM' }); };
  await assert.rejects(publicarCandado(archivo, 'mio', eperm), { code: 'EEXIST' });
  assert.equal(readFileSync(archivo, 'utf8'), 'ajeno');
  assert.deepEqual(readdirSync(carpeta), ['.candado']);
});

test('publicarCandado con link real publica el candado completo y quita el temporal', async (t) => {
  const { carpeta, archivo } = casa(t);
  await publicarCandado(archivo, 'completo\n');
  assert.equal(readFileSync(archivo, 'utf8'), 'completo\n');
  assert.equal(statSync(archivo).nlink, 1);
  assert.deepEqual(readdirSync(carpeta), ['.candado']);
});

test('liberar deja la carpeta de encargos vacía', async (t) => {
  const { home, carpeta } = casa(t);
  await (await tomarCandadoEncargos(home)).liberar();
  assert.deepEqual(readdirSync(carpeta), []);
});
