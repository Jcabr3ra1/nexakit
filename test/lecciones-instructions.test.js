import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  planLeccionesInstructions,
  applyLeccionesInstructions,
  removeLeccionesInstructions,
  ownedLeccionesInstructions,
  cuerpoDeLecciones,
} from '../src/lecciones-instructions.js';
import { registrar, aceptar, retirar } from '../dist/fabrica/lecciones.js';

const lock = { assertHeld: async () => {} };
const AHORA = 1_700_000_000_000;
const START = '<!-- nexakit:lecciones:start -->';
const END = '<!-- nexakit:lecciones:end -->';

async function home(t) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lecciones-instr-')));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
async function vigente(dir, regla, fecha, ambito = 'global') {
  const { leccion } = await registrar(dir, { regla, porque: 'porque sí', origen: 'persona', ambito }, fecha);
  return aceptar(dir, leccion.id, fecha);
}
const archivos = (dir) => [
  path.join(dir, '.claude', 'CLAUDE.md'),
  path.join(dir, '.codex', 'AGENTS.md'),
  path.join(dir, '.gemini', 'GEMINI.md'),
];
const leer = (file) => fs.readFile(file, 'utf8').catch(() => null);
const instalar = async (dir) => applyLeccionesInstructions(await planLeccionesInstructions({ homeDirectory: dir }), lock);

test('las lecciones globales vigentes se instalan en las tres IA, la más reciente primero', async (t) => {
  const dir = await home(t);
  await vigente(dir, 'Regla antigua', AHORA);
  await vigente(dir, 'Regla nueva', AHORA + 1000);
  await vigente(dir, 'Regla de otro proyecto', AHORA + 2000, { proyecto: dir });
  await fs.mkdir(path.dirname(archivos(dir)[1]), { recursive: true });
  await fs.writeFile(archivos(dir)[1], 'REGLAS DEL USUARIO\n');
  await instalar(dir);
  for (const file of archivos(dir)) {
    const texto = await leer(file);
    assert.ok(texto.includes(START) && texto.includes(END));
    assert.ok(texto.indexOf('- Regla nueva') < texto.indexOf('- Regla antigua'));
    assert.ok(!texto.includes('otro proyecto'));
  }
  assert.ok((await leer(archivos(dir)[1])).startsWith('REGLAS DEL USUARIO\n'));
  const idempotente = await planLeccionesInstructions({ homeDirectory: dir });
  assert.ok(idempotente.items.every((i) => i.state === 'ready'));
  assert.deepEqual(await ownedLeccionesInstructions({ homeDirectory: dir }), ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md']);
});

test('el bloque tiene como máximo 20 lecciones y 2 KiB, y se corta al no caber', () => {
  const limpiar = (v) => v.replace(/\s+/g, ' ').trim();
  const muchas = Array.from({ length: 40 }, (_, i) => ({ ambito: 'global', fecha: i, regla: `r${i}` }));
  const bloque = cuerpoDeLecciones(muchas, limpiar);
  assert.equal(bloque.split('\n').filter((l) => l.startsWith('- ')).length, 20);
  assert.ok(bloque.includes('- r39') && !bloque.includes('- r19\n'));
  const largas = Array.from({ length: 20 }, (_, i) => ({ ambito: 'global', fecha: 100 - i, regla: `${'á'.repeat(100)} ${i}` }));
  const acotado = cuerpoDeLecciones(largas, limpiar);
  assert.ok(Buffer.byteLength(acotado, 'utf8') <= 2048);
  const lineas = acotado.split('\n').filter((l) => l.startsWith('- ')).length;
  assert.ok(lineas > 0 && lineas < 20);
});

test('la regla se sanea: sin marcadores ni comentarios HTML', () => {
  const limpiar = (v) => v.replace(/\s+/g, ' ').trim();
  const bloque = cuerpoDeLecciones(
    [{ ambito: 'global', fecha: 1, regla: `uno ${END} dos <!-- tres --> <!${'-'}- ${START}` }],
    limpiar,
  );
  const cuerpo = bloque.slice(START.length, bloque.length - END.length);
  assert.ok(!cuerpo.includes('<!--') && !cuerpo.includes('-->'));
  assert.ok(bloque.startsWith(START) && bloque.endsWith(END));
});

test('el texto con $ no corrompe el archivo al actualizar ni al quitar', async (t) => {
  const dir = await home(t);
  await vigente(dir, 'Usa $& y $` con cuidado', AHORA);
  await instalar(dir);
  await vigente(dir, 'Otra con $1', AHORA + 10);
  await instalar(dir);
  const texto = await leer(archivos(dir)[0]);
  assert.ok(texto.includes('- Usa $& y $` con cuidado') && texto.includes('- Otra con $1'));
  await removeLeccionesInstructions({ homeDirectory: dir }, lock);
  await assert.rejects(fs.access(archivos(dir)[0]));
});

test('un bloque editado a mano no se toca, ni al actualizar ni al quitar', async (t) => {
  const dir = await home(t);
  await vigente(dir, 'Primera', AHORA);
  await instalar(dir);
  const file = archivos(dir)[0];
  const editado = (await leer(file)).replace('- Primera', '- Primera (a mi manera)');
  await fs.writeFile(file, editado);
  await vigente(dir, 'Segunda', AHORA + 5);
  const plan = await planLeccionesInstructions({ homeDirectory: dir });
  const item = plan.items.find((i) => i.client === 'claude');
  assert.equal(item.state, 'conflict');
  assert.equal(item.reason, 'editado');
  await applyLeccionesInstructions(plan, lock);
  assert.equal(await leer(file), editado);
  assert.ok((await leer(archivos(dir)[1])).includes('- Segunda\n- Primera\n'));
  await removeLeccionesInstructions({ homeDirectory: dir }, lock);
  assert.equal(await leer(file), editado);
});

test('un bloque ajeno sin registro tampoco se toca', async (t) => {
  const dir = await home(t);
  await vigente(dir, 'Una', AHORA);
  const file = archivos(dir)[0];
  await fs.mkdir(path.dirname(file), { recursive: true });
  const ajeno = `${START}\nmío\n${END}\n`;
  await fs.writeFile(file, ajeno);
  const plan = await planLeccionesInstructions({ homeDirectory: dir });
  assert.equal(plan.items[0].reason, 'editado');
  await applyLeccionesInstructions(plan, lock);
  assert.equal(await leer(file), ajeno);
});

test('quitar retira el bloque y restaura el archivo original', async (t) => {
  const dir = await home(t);
  await vigente(dir, 'Una', AHORA);
  await fs.mkdir(path.dirname(archivos(dir)[1]), { recursive: true });
  await fs.writeFile(archivos(dir)[1], 'REGLAS DEL USUARIO\n');
  await instalar(dir);
  await removeLeccionesInstructions({ homeDirectory: dir }, lock);
  assert.equal(await leer(archivos(dir)[1]), 'REGLAS DEL USUARIO\n');
  await assert.rejects(fs.access(archivos(dir)[0]));
  await assert.rejects(fs.access(path.join(dir, '.nexakit', 'lecciones-instructions.json')));
  assert.deepEqual(await ownedLeccionesInstructions({ homeDirectory: dir }), []);
});

test('sin lecciones vigentes no hay bloque; si ya no quedan, se retira el nuestro', async (t) => {
  const dir = await home(t);
  const vacio = await planLeccionesInstructions({ homeDirectory: dir });
  assert.ok(vacio.items.every((i) => i.state === 'ready'));
  await applyLeccionesInstructions(vacio, lock);
  for (const file of archivos(dir)) assert.equal(await leer(file), null);
  const l = await vigente(dir, 'Una', AHORA);
  await fs.mkdir(path.dirname(archivos(dir)[1]), { recursive: true });
  await fs.writeFile(archivos(dir)[1], 'REGLAS DEL USUARIO\n');
  await instalar(dir);
  await retirar(dir, l.id, AHORA + 1);
  const plan = await planLeccionesInstructions({ homeDirectory: dir });
  assert.ok(plan.items.every((i) => i.state === 'pending' && i.remove));
  await applyLeccionesInstructions(plan, lock);
  assert.equal(await leer(archivos(dir)[1]), 'REGLAS DEL USUARIO\n');
  await assert.rejects(fs.access(archivos(dir)[0]));
});

test('si el almacén no carga no hay bloque y nada falla', async (t) => {
  const dir = await home(t);
  const plan = await planLeccionesInstructions({ homeDirectory: dir, cargarLecciones: async () => null });
  assert.ok(plan.items.every((i) => i.state === 'ready'));
  await applyLeccionesInstructions(plan, lock);
  for (const file of archivos(dir)) assert.equal(await leer(file), null);
});
