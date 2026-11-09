import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runLeccionesCommand } from '../src/lecciones-command.js';

const AHORA = 1700000000000;
const DIA = 24 * 60 * 60 * 1000;

async function ejecutar(argv, contenido) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'lecciones-'));
  if (contenido !== undefined) {
    await fs.mkdir(path.join(home, '.nexakit'));
    await fs.writeFile(path.join(home, '.nexakit', 'lecciones.jsonl'), contenido);
  }
  let salida = '';
  let error = '';
  const code = await runLeccionesCommand(
    argv,
    { out: (m) => { salida += m; }, err: (m) => { error += m; } },
    { homeDirectory: home, now: AHORA },
  );
  return { code, salida, error };
}

const ev = (fecha, tipo, texto) => JSON.stringify(texto === undefined ? { fecha, tipo } : { fecha, tipo, texto });
const unir = (...l) => `${l.join('\n')}\n`;

test('sin registro explica que aún no hay datos y que lo escribe nexakit-lecciones', async () => {
  const { code, salida } = await ejecutar([]);
  assert.equal(code, 0);
  assert.match(salida, /Aún no hay lecciones registradas/u);
  assert.match(salida, /nexakit-lecciones/u);
});

test('cuenta eventos mezclados, respeta la ventana de 7 días e ignora líneas inválidas', async () => {
  const { code, salida } = await ejecutar([], unir(
    ev(AHORA - 10 * DIA, 'correccion', 'vieja'),
    ev(AHORA - 10 * DIA, 'freno'),
    'no es json',
    JSON.stringify({ fecha: 'x', tipo: 'freno' }),
    ev(AHORA - DIA, 'correccion', 'reciente'),
    ev(AHORA - DIA, 'guardada'),
    ev(AHORA - DIA, 'freno'),
    ev(AHORA - DIA, 'repeticion'),
    ev(AHORA - DIA, 'avisada'),
  ));
  assert.equal(code, 0);
  assert.match(salida, /Últimos 7 días: 1 correcciones, 1 lecciones guardadas, 1 errores frenados, 1 errores repetidos/u);
  assert.match(salida, /Total: 2 correcciones, 1 lecciones guardadas, 2 errores frenados, 1 errores repetidos/u);
});

test('pendientes son las correcciones posteriores a la última guardada; sin guardada, todas', async () => {
  const a = await ejecutar(['--json'], unir(
    ev(AHORA - 5 * DIA, 'correccion', 'antes'),
    ev(AHORA - 4 * DIA, 'guardada'),
    ev(AHORA - 3 * DIA, 'correccion', 'uno'),
    ev(AHORA - 2 * DIA, 'correccion', 'dos'),
  ));
  assert.deepEqual(JSON.parse(a.salida).pendientes, ['dos', 'uno']);
  const b = await ejecutar(['--json'], unir(ev(AHORA - 3, 'correccion', 'x'), ev(AHORA - 2, 'correccion', 'y')));
  assert.deepEqual(JSON.parse(b.salida).pendientes, ['x', 'y'].reverse());
});

test('el texto lista hasta 5 pendientes y el JSON todos', async () => {
  const filas = Array.from({ length: 7 }, (_, i) => ev(AHORA - (10 - i), 'correccion', `c${i}`));
  const t = await ejecutar([], unir(...filas));
  assert.match(t.salida, /Pendientes: 7/u);
  assert.equal(t.salida.split('\n').filter((l) => l.startsWith('  - ')).length, 5);
  assert.match(t.salida, /- c6/u);
  assert.doesNotMatch(t.salida, /- c1\n/u);
  const j = await ejecutar(['--json'], unir(...filas));
  const r = JSON.parse(j.salida);
  assert.equal(r.pendientes.length, 7);
  assert.equal(r.total.correcciones, 7);
  assert.ok(r.ultimos7Dias);
});

test('un argumento desconocido muestra el uso y devuelve 2', async () => {
  const { code, error } = await ejecutar(['--otro']);
  assert.equal(code, 2);
  assert.match(error, /Uso: nexakit lecciones \[--json\]/u);
});

test('las pendientes se cuentan por orden en el registro, no por hora: dos eventos del mismo milisegundo', async () => {
  // Una guardada seguida de una corrección en el mismo milisegundo deja la corrección pendiente; al revés, resuelta.
  const despues = await ejecutar(['--json'], unir(ev(AHORA, 'guardada'), ev(AHORA, 'correccion', 'posterior')));
  assert.deepEqual(JSON.parse(despues.salida).pendientes, ['posterior']);
  const antes = await ejecutar(['--json'], unir(ev(AHORA, 'correccion', 'anterior'), ev(AHORA, 'guardada')));
  assert.deepEqual(JSON.parse(antes.salida).pendientes, []);
});
