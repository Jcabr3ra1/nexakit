import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactarSalida, LIMITE_LINEAS } from '../plugins/nexakit-ahorro/hooks/compactar.js';

const lineas = (n, f = (i) => `línea ${i}`) => Array.from({ length: n }, (_, i) => f(i)).join('\n');

test('una salida corta pasa intacta', () => {
  const corta = lineas(LIMITE_LINEAS);
  assert.deepEqual(compactarSalida(corta), { texto: corta, omitidas: 0 });
  assert.deepEqual(compactarSalida(''), { texto: '', omitidas: 0 });
});

test('una salida larga conserva cabeza, cola y todas las líneas de error, y dice dónde está completa', () => {
  const larga = lineas(5000, (i) => (i === 2500 ? 'not ok 2500 - falla el cálculo' : i === 3000 ? 'Error: no se encontró el módulo' : `ok ${i}`));
  const { texto, omitidas } = compactarSalida(larga, { ruta: '/tmp/x.log' });
  assert.ok(omitidas > 4000);
  assert.match(texto, /^ok 0$/mu);
  assert.match(texto, /^ok 4999$/mu);
  assert.match(texto, /not ok 2500 - falla el cálculo/u);
  assert.match(texto, /Error: no se encontró el módulo/u);
  assert.match(texto, /\/tmp\/x\.log/u);
  assert.ok(texto.split('\n').length < 120);
});

test('quita los códigos de color y limita las líneas de error repetidas', () => {
  const conColor = lineas(400, (i) => `\u001b[31mwarning: repetido ${i % 3}\u001b[0m`);
  const { texto } = compactarSalida(conColor);
  assert.doesNotMatch(texto, /\u001b\[/u);
  assert.ok(texto.split('\n').length < 120);
});

test('una sola línea gigante también se recorta', () => {
  const { texto, omitidas } = compactarSalida('x'.repeat(200000));
  assert.ok(texto.length < 20000);
  assert.ok(omitidas > 0);
});

test('el mod recorta Bash, guarda la salida completa y respeta la salida completa pedida', async () => {
  const { register } = await import('../plugins/nexakit-ahorro/hooks/register.js');
  const hooks = new Map();
  register((event, matcher, hook) => hooks.set(event, hook ?? matcher));
  const escritos = new Map();
  const api = { env: { get: async () => '/casa' }, clock: { now: async () => 1700000000000 }, fs: { write: async (p, t) => { escritos.set(p, t); } } };
  const larga = lineas(3000);
  const next = async () => ({ ref: 'r', text: 'core', result: { stdout: larga, stderr: '', interrupted: false } });
  const r = await hooks.get('tool.call')(api, { tool: 'Bash', command: 'npm test' }, next);
  assert.equal(r.ref, undefined, 'sin ref, el motor vuelve a presentar el resultado recortado');
  assert.ok(r.result.stdout.length < larga.length / 5);
  const [ruta, completo] = [...escritos][0];
  assert.match(ruta, /^\/casa\/\.nexakit\/salidas\/.+\.log$/u);
  assert.equal(completo, larga);
  assert.match(r.result.stdout, new RegExp(ruta.replaceAll('.', '\\.')));
  const intacta = await hooks.get('tool.call')(api, { tool: 'Bash', command: 'NEXAKIT_SALIDA=completa npm test' }, next);
  assert.equal(intacta.ref, 'r');
  const corta = async () => ({ ref: 'c', result: { stdout: 'hola', stderr: '', interrupted: false } });
  assert.equal((await hooks.get('tool.call')(api, { tool: 'Bash', command: 'echo hola' }, corta)).ref, 'c');
  const fondo = async () => ({ ref: 'f', result: { stdout: larga, stderr: '', interrupted: false, backgroundTaskId: 'b1' } });
  assert.equal((await hooks.get('tool.call')(api, { tool: 'Bash', command: 'servidor' }, fondo)).ref, 'f');
});

test('cada recorte añade una línea con cifras a ahorro.jsonl y un fallo al registrar no rompe el recorte', async () => {
  const { register } = await import('../plugins/nexakit-ahorro/hooks/register.js');
  const hooks = new Map();
  register((event, matcher, hook) => hooks.set(event, hook ?? matcher));
  const archivos = new Map();
  const api = {
    env: { get: async () => '/casa' },
    clock: { now: async () => 1700000000000 },
    fs: {
      write: async (p, t) => { archivos.set(p, t); },
      exists: async (p) => archivos.has(p),
      read: async (p) => archivos.get(p),
    },
  };
  const larga = lineas(3000);
  const next = async () => ({ ref: 'r', result: { stdout: larga, stderr: '', interrupted: false } });
  const r1 = await hooks.get('tool.call')(api, { tool: 'Bash', command: 'secreto --token abc' }, next);
  await hooks.get('tool.call')(api, { tool: 'Bash', command: 'otro' }, next);
  const registro = archivos.get('/casa/.nexakit/ahorro.jsonl');
  const filas = registro.trim().split('\n').map((f) => JSON.parse(f));
  assert.equal(filas.length, 2);
  assert.deepEqual(Object.keys(filas[0]).sort(), ['antes', 'despues', 'fecha', 'lineasAntes', 'lineasDespues']);
  assert.equal(filas[0].fecha, 1700000000000);
  assert.equal(filas[0].antes, larga.length);
  assert.equal(filas[0].despues, r1.result.stdout.length);
  assert.ok(filas[0].lineasDespues < filas[0].lineasAntes);
  assert.doesNotMatch(registro, /secreto|token|ok 1/u);

  const roto = { ...api, fs: { ...api.fs, write: async (p) => { if (p.endsWith('.jsonl')) throw new Error('disco'); } } };
  const r2 = await hooks.get('tool.call')(roto, { tool: 'Bash', command: 'npm test' }, next);
  assert.equal(r2.ref, undefined);
  assert.ok(r2.result.stdout.length < larga.length / 5);
});
