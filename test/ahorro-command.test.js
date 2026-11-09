import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runAhorroCommand } from '../src/ahorro-command.js';

const AHORA = 1700000000000;
const DIA = 24 * 60 * 60 * 1000;

async function ejecutar(argv, contenido) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ahorro-'));
  if (contenido !== undefined) {
    await fs.mkdir(path.join(home, '.nexakit'));
    await fs.writeFile(path.join(home, '.nexakit', 'ahorro.jsonl'), contenido);
  }
  let salida = '';
  let error = '';
  const code = await runAhorroCommand(
    argv,
    { out: (m) => { salida += m; }, err: (m) => { error += m; } },
    { homeDirectory: home, now: AHORA },
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
