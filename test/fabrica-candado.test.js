import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { tomarCandadoEncargos } from '../dist/fabrica/encargo/candado.js';

const pidMuerto = () => Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout);

function casa(t) {
  const home = mkdtempSync(path.join(tmpdir(), 'nexakit-candado-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(path.join(home, '.nexakit', 'encargos'), { recursive: true, mode: 0o700 });
  return { home, archivo: path.join(home, '.nexakit', 'encargos', '.candado') };
}

const envejecer = (archivo, ms) => {
  const f = new Date(Date.now() - ms);
  utimesSync(archivo, f, f);
};

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
