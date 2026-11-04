import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { stripVTControlCharacters } from 'node:util';
import { ANCHO } from '../plugins/nexakit-panel/hooks/lienzo.js';
import { ejemplo } from '../plugins/nexakit-panel/hooks/panel.js';
import { INACTIVA_MS, leerCodex, leerFoto, marcoDelPanel } from '../src/panel-cli.js';
import { runToolkitCli } from '../src/toolkit-cli.js';
import { cellWidth } from '../src/terminal-text.js';

const AHORA = 1_800_000_000_000;
const USO = { context: { window: 1000000, percent: 55 }, rateLimits: [{ kind: 'five_hour', percentUsed: 14 }, { kind: 'seven_day', percentUsed: 79 }] };
const foto = (extra = {}) => ({ version: 1, sesion: 's1', actualizado: AHORA - 1000, carpeta: 'app', asesorModelo: null, uso: USO, estado: ejemplo(AHORA), ...extra });
const lineas = (texto) => stripVTControlCharacters(texto).split('\n');

async function casa(t) {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'panel-cli-')));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  return home;
}
async function escribirFoto(home, contenido) {
  const dir = path.join(home, '.nexakit', 'panel');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'actual.json'), typeof contenido === 'string' ? contenido : JSON.stringify(contenido));
}

test('leerFoto devuelve la última foto válida y nada si falta, está dañada o es de otra versión', async (t) => {
  const home = await casa(t);
  assert.equal(await leerFoto(home), null);
  await escribirFoto(home, '{ no es json');
  assert.equal(await leerFoto(home), null);
  await escribirFoto(home, { version: 99, estado: {} });
  assert.equal(await leerFoto(home), null);
  await escribirFoto(home, foto());
  assert.equal((await leerFoto(home)).sesion, 's1');
});

test('con la foto dibuja el diagrama completo, centrado y sin pasarse del ancho', () => {
  const texto = marcoDelPanel({ foto: foto(), columnas: 120, filas: 60, nivel: 'none', ahora: AHORA });
  const l = lineas(texto);
  assert.ok(l.some((x) => x.includes('DELEGACIÓN · subagentes')));
  assert.ok(l.some((x) => x.includes('search') && x.includes('grep') && x.includes('audit')));
  assert.ok(l.some((x) => /contexto .*55 %/.test(x)));
  for (const x of l) assert.ok(cellWidth(x) <= 120, `«${x}»`);
  assert.ok(l.find((x) => x.includes('┌')).startsWith(' '.repeat(Math.floor((120 - ANCHO) / 2))), 'centrado');
});

test('en una terminal estrecha avisa de cuánto ancho necesita', () => {
  const l = lineas(marcoDelPanel({ foto: foto(), columnas: 80, filas: 40, nivel: 'none', ahora: AHORA }));
  assert.ok(l.some((x) => x.includes(`necesita ${ANCHO} columnas (ahora 80)`)));
  for (const x of l) assert.ok(cellWidth(x) <= 80, `«${x}»`);
});

test('sin foto espera a Claude Code y explica cómo se llena', () => {
  const texto = lineas(marcoDelPanel({ foto: null, columnas: 120, filas: 40, nivel: 'none', ahora: AHORA })).join('\n');
  assert.match(texto, /Esperando actividad de Claude Code/u);
  assert.match(texto, /nexakit-panel/u);
});

test('si la sesión lleva rato quieta lo dice, y el ejemplo se marca como ficticio', () => {
  const quieta = lineas(marcoDelPanel({ foto: foto({ actualizado: AHORA - INACTIVA_MS - 1 }), columnas: 120, filas: 60, nivel: 'none', ahora: AHORA })).join('\n');
  assert.match(quieta, /sin actividad desde \d\d:\d\d:\d\d/u);
  const demo = lineas(marcoDelPanel({ foto: null, columnas: 120, filas: 60, nivel: 'none', ahora: AHORA, demo: true })).join('\n');
  assert.match(demo, /EJEMPLO · datos ficticios/u);
});

test('con color pinta en 24 bits y sin color no deja ni un escape', () => {
  assert.match(marcoDelPanel({ foto: foto(), columnas: 120, filas: 60, nivel: 'truecolor', ahora: AHORA }), /38;2;/u);
  assert.doesNotMatch(marcoDelPanel({ foto: foto(), columnas: 120, filas: 60, nivel: 'none', ahora: AHORA }), /\x1b/u);
});

test('nexakit panel --una-vez dibuja una vez y sale; los argumentos desconocidos se rechazan', async (t) => {
  const home = await casa(t);
  await escribirFoto(home, foto({ actualizado: Date.now() }));
  const correr = async (argv) => {
    let out = '', err = '';
    const code = await runToolkitCli(argv, { out: (x) => { out += x; }, err: (x) => { err += x; }, isTTY: false, options: { homeDirectory: home } });
    return { code, out, err };
  };
  const una = await correr(['panel', '--una-vez']);
  assert.equal(una.code, 0, una.err);
  assert.match(una.out, /search/u);
  const demo = await correr(['panel', '--una-vez', '--demo']);
  assert.match(demo.out, /EJEMPLO/u);
  assert.equal((await correr(['panel', '--raro'])).code, 2);
});

test('la ayuda general menciona nexakit panel', async () => {
  let out = '';
  await runToolkitCli(['--help'], { out: (x) => { out += x; }, err: (x) => { out += x; } });
  assert.match(out, /nexakit panel/u);
});

async function sesionCodex(codexHome, nombre, lineas, mtimeMs) {
  const dir = path.join(codexHome, 'sessions', '2026', '11', '02');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, nombre);
  await fs.writeFile(file, lineas.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  if (mtimeMs) await fs.utimes(file, mtimeMs / 1000, mtimeMs / 1000);
  return file;
}
const turno = (model, effort) => ({ timestamp: '2026-11-02T20:00:00Z', type: 'turn_context', payload: { model, effort } });
const cuenta = (input, cached, output, p5, psem) => ({ timestamp: '2026-11-02T20:33:29.933Z', type: 'event_msg', payload: { type: 'token_count',
  info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } },
  rate_limits: { primary: { used_percent: p5, window_minutes: 300 }, secondary: { used_percent: psem, window_minutes: 10080 } } } });

test('leerCodex toma la sesión más reciente de Codex y saca modelo, tokens y límites', async (t) => {
  const home = await casa(t);
  const codexHome = path.join(home, '.codex');
  assert.equal(await leerCodex(codexHome), null);
  await sesionCodex(codexHome, 'vieja.jsonl', [turno('gpt-5.6-sol', 'low'), cuenta(10, 0, 1, 50, 50)], Date.now() - 3_600_000);
  await sesionCodex(codexHome, 'nueva.jsonl', ['{ línea rota', turno('gpt-6.1-sol', 'low'), cuenta(372693, 323584, 3899, 1, 14)], Date.now());
  const codex = await leerCodex(codexHome);
  assert.deepEqual({ ...codex, actualizado: typeof codex.actualizado },
    { modelo: 'gpt-6.1-sol', esfuerzo: 'low', leidos: 372693, cache: 323584, escritos: 3899, limite5h: 1, limiteSemana: 14, actualizado: 'number' });
});

test('leerCodex no inventa nada si la sesión no trae cifras', async (t) => {
  const home = await casa(t);
  await sesionCodex(path.join(home, '.codex'), 'sin.jsonl', [turno('gpt-6.1-sol', 'low')], Date.now());
  assert.equal(await leerCodex(path.join(home, '.codex')), null);
});

test('nexakit panel enseña también el uso de Codex cuando lo hay', async (t) => {
  const home = await casa(t);
  await escribirFoto(home, foto({ actualizado: Date.now() }));
  await sesionCodex(path.join(home, '.codex'), 'nueva.jsonl', [turno('gpt-6.1-sol', 'low'), cuenta(372693, 323584, 3899, 1, 14)], Date.now());
  let out = '';
  const code = await runToolkitCli(['panel', '--una-vez'], { out: (x) => { out += x; }, err: (x) => { out += x; }, isTTY: false, options: { homeDirectory: home, environment: {} } });
  assert.equal(code, 0, out);
  assert.match(out, /codex gpt-6\.1-sol/u);
});
