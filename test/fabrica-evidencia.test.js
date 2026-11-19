import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ErrorFabrica } from '../dist/fabrica/errores.js';
import { actualizar, caducada, cargar, cuantil05, evidenciaVacia, guardar } from '../dist/fabrica/evidencia.js';
import { fileSymlinkSkipReason } from '../testing/symlink-capability.js';

const SIN_ENLACES = process.platform === 'win32' || fileSymlinkSkipReason();
const DIA = 24 * 60 * 60 * 1000;
const AHORA = new Date('2026-11-15T12:00:00.000Z');

const temporal = () => realpathSync(mkdtempSync(path.join(tmpdir(), 'fab-evidencia-')));
const carpeta = (home) => path.join(home, '.nexakit', 'fabrica');
const archivo = (home) => path.join(carpeta(home), 'evidencia.json');
const modo = (ruta) => statSync(ruta).mode & 0o777;
const clave = (extra = {}) => ({ ia: 'codex', modelo: 'gpt-6.1-sol', esfuerzo: 'high', estacion: 'seguridad', ...extra });
const datos = (extra = {}) => ({ aciertos: 0, fallos: 0, tokens: 0, segundos: 0, fuente: 'banco', ...extra });

// Referencia independiente: para parámetros enteros, I_x(a, b) es la cola de una binomial B(a+b-1, x) desde a.
function colaBinomial(x, a, b) {
  const n = a + b - 1;
  let suma = 0;
  let coef = 1; // C(n, k), con k desde 0
  for (let k = 0; k <= n; k += 1) {
    if (k >= a) suma += coef * x ** k * (1 - x) ** (n - k);
    coef = (coef * (n - k)) / (k + 1);
  }
  return suma;
}

function cuantilPorBinomial(a, b, p = 0.05) {
  let bajo = 0;
  let alto = 1;
  for (let i = 0; i < 200; i += 1) {
    const medio = (bajo + alto) / 2;
    if (colaBinomial(medio, a, b) < p) bajo = medio;
    else alto = medio;
  }
  return (bajo + alto) / 2;
}

// Referencia independiente 2: integración de Simpson de la densidad de una Beta entera, I_x(a, b) = ∫₀ˣ f.
function cdfPorSimpson(x, a, b) {
  const factorial = (n) => (n <= 1 ? 1 : n * factorial(n - 1));
  const constante = factorial(a + b - 1) / (factorial(a - 1) * factorial(b - 1));
  const f = (t) => constante * t ** (a - 1) * (1 - t) ** (b - 1);
  const pasos = 20_000;
  const h = x / pasos;
  let suma = f(0) + f(x);
  for (let i = 1; i < pasos; i += 1) suma += f(i * h) * (i % 2 === 0 ? 2 : 4);
  return (suma * h) / 3;
}

test('cuantil05(41, 11) es mayor que cuantil05(2, 1)', () => {
  assert.ok(cuantil05(41, 11) > cuantil05(2, 1));
});

test('cuantil05 coincide con la referencia binomial y con la integración numérica en parámetros enteros', () => {
  for (const [a, b] of [
    [1, 1],
    [2, 1],
    [1, 3],
    [2, 8],
    [10, 10],
    [41, 11],
    [5, 30],
    [60, 4],
  ]) {
    const q = cuantil05(a, b);
    assert.ok(Math.abs(q - cuantilPorBinomial(a, b)) < 1e-9, `Beta(${a},${b}): ${q}`);
    assert.ok(Math.abs(cdfPorSimpson(q, a, b) - 0.05) < 1e-6, `Beta(${a},${b}) por Simpson`);
  }
});

test('cuantil05: valores de referencia fijos', () => {
  assert.ok(Math.abs(cuantil05(1, 1) - 0.05) < 1e-9);
  assert.ok(Math.abs(cuantil05(2, 8) - 0.0410232) < 1e-6);
  assert.ok(Math.abs(cuantil05(10, 10) - 0.3200865) < 1e-6);
  assert.ok(Math.abs(cuantil05(41, 11) - 0.6901357) < 1e-6);
});

test('cuantil05: casos con fórmula cerrada y parámetros no enteros', () => {
  // Beta(2, 1): F(x) = x²
  assert.ok(Math.abs(cuantil05(2, 1) - Math.sqrt(0.05)) < 1e-9);
  // Beta(1.5, 1): F(x) = x^1,5
  assert.ok(Math.abs(cuantil05(1.5, 1) - 0.05 ** (1 / 1.5)) < 1e-9);
  // Beta(1, 2.5): F(x) = 1 - (1-x)^2,5
  assert.ok(Math.abs(cuantil05(1, 2.5) - (1 - 0.95 ** (1 / 2.5))) < 1e-9);
  // Beta(0,5; 0,5) (arcoseno): F(x) = (2/π)·asin(√x)
  assert.ok(Math.abs(cuantil05(0.5, 0.5) - Math.sin((Math.PI * 0.05) / 2) ** 2) < 1e-9);
});

test('cuantil05: parámetros muy grandes y muy pequeños siguen siendo precisos y estables', () => {
  assert.ok(Math.abs(cuantil05(1, 1000) - (1 - 0.95 ** (1 / 1000))) < 1e-9);
  assert.ok(Math.abs(cuantil05(1000, 1000) - 0.4816139) < 1e-6);
  const q = cuantil05(0.3, 7.7);
  assert.ok(q > 0 && q < 1e-3);
});

test('cuantil05 sube con los aciertos y baja con los fallos', () => {
  assert.ok(cuantil05(20, 3) > cuantil05(10, 3));
  assert.ok(cuantil05(10, 6) < cuantil05(10, 3));
  // Con la misma media, menos datos dan un límite inferior más bajo.
  assert.ok(cuantil05(3, 1) < cuantil05(30, 10));
});

test('cuantil05 rechaza parámetros que no sean positivos y finitos, o fuera de 1e-6 a 1e9', () => {
  for (const [a, b] of [
    [1e300, 1],
    [1, 1e300],
    [Number.MIN_VALUE, 1],
    [1, Number.MIN_VALUE],
    [1e-7, 1],
    [1e9 + 1, 1],
    [1, 2e9],
    [0, 1],
    [1, 0],
    [-1, 2],
    [Number.NaN, 1],
    [1, Number.POSITIVE_INFINITY],
  ]) {
    assert.throws(() => cuantil05(a, b), ErrorFabrica);
  }
});

test('actualizar: una fila nueva parte de Beta(1,1) y el banco suma 1 por observación', () => {
  const ev = actualizar(
    evidenciaVacia(AHORA),
    clave(),
    datos({ aciertos: 8, fallos: 2, tokens: 1000, segundos: 20, ahora: AHORA }),
  );
  assert.equal(ev.filas.length, 1);
  assert.deepEqual(ev.filas[0], {
    ia: 'codex',
    modelo: 'gpt-6.1-sol',
    esfuerzo: 'high',
    estacion: 'seguridad',
    alfa: 9,
    beta: 3,
    tokensMedios: 1000,
    segundosMedios: 20,
    banco: 10,
    real: 0,
    muestrasTokens: 1,
    muestrasSegundos: 1,
  });
});

test('actualizar: con fuente real los aciertos y fallos pesan 2', () => {
  const ev = actualizar(evidenciaVacia(AHORA), clave(), datos({ aciertos: 3, fallos: 1, tokens: 500, segundos: 10, fuente: 'real' }));
  const fila = ev.filas[0];
  assert.equal(fila.alfa, 1 + 6);
  assert.equal(fila.beta, 1 + 2);
  assert.equal(fila.real, 4);
  assert.equal(fila.banco, 0);
});

test('actualizar: banco y real se acumulan sobre la misma fila', () => {
  let ev = actualizar(evidenciaVacia(AHORA), clave(), datos({ aciertos: 4, fallos: 0, tokens: 100, segundos: 10 }));
  ev = actualizar(ev, clave(), datos({ aciertos: 1, fallos: 1, tokens: 100, segundos: 10, fuente: 'real' }));
  assert.equal(ev.filas.length, 1);
  assert.equal(ev.filas[0].alfa, 1 + 4 + 2);
  assert.equal(ev.filas[0].beta, 1 + 2);
  assert.equal(ev.filas[0].banco, 4);
  assert.equal(ev.filas[0].real, 2);
});

test('actualizar: tokens y segundos son medias por llamada, no por observación', () => {
  let ev = actualizar(evidenciaVacia(AHORA), clave(), datos({ aciertos: 3, fallos: 1, tokens: 1000, segundos: 10 }));
  ev = actualizar(ev, clave(), datos({ aciertos: 1, fallos: 0, tokens: 2000, segundos: 30, fuente: 'real' }));
  // Dos llamadas: (1000 + 2000) / 2 y (10 + 30) / 2, sin importar cuántos aciertos y fallos trajo cada una.
  assert.equal(ev.filas[0].tokensMedios, 1500);
  assert.equal(ev.filas[0].segundosMedios, 20);
  assert.equal(ev.filas[0].muestrasTokens, 2);
  // Una observación sin tokens no es una muestra.
  ev = actualizar(ev, clave(), datos({ aciertos: 5, fallos: 0 }));
  assert.equal(ev.filas[0].tokensMedios, 1500);
  assert.equal(ev.filas[0].muestrasTokens, 2);
  ev = actualizar(ev, clave(), datos({ aciertos: 1, fallos: 0, tokens: 3000 }));
  assert.equal(ev.filas[0].tokensMedios, 2000);
  assert.equal(ev.filas[0].muestrasTokens, 3);
});

test('actualizar: la primera medida que sustituye un 0 no hereda el peso de las observaciones previas', () => {
  // Veinte veredictos sin tokens y luego dos medidas: la media es la de esas dos llamadas.
  let ev = actualizar(evidenciaVacia(AHORA), clave(), datos({ aciertos: 20, fallos: 0, fuente: 'real' }));
  assert.equal(ev.filas[0].tokensMedios, 0);
  ev = actualizar(ev, clave(), datos({ aciertos: 1, fallos: 0, tokens: 10_000 }));
  ev = actualizar(ev, clave(), datos({ aciertos: 1, fallos: 0, tokens: 50_000 }));
  assert.equal(ev.filas[0].tokensMedios, 30_000);
  assert.equal(ev.filas[0].muestrasTokens, 2);
});

test('actualizar: una fila guardada sin contador de muestras pesa como una sola muestra', () => {
  const vieja = { ...clave(), alfa: 11, beta: 1, tokensMedios: 1000, segundosMedios: 10, banco: 10, real: 0 };
  const ev = actualizar({ ...evidenciaVacia(AHORA), filas: [vieja] }, clave(), datos({ aciertos: 1, fallos: 0, tokens: 3000, segundos: 30 }));
  assert.deepEqual([ev.filas[0].tokensMedios, ev.filas[0].muestrasTokens, ev.filas[0].segundosMedios], [2000, 2, 20]);
});

test('actualizar: una fila se identifica por (ia, modelo, esfuerzo, estación); Antigravity usa esfuerzo null', () => {
  let ev = evidenciaVacia(AHORA);
  ev = actualizar(ev, clave(), datos({ aciertos: 1, tokens: 1, segundos: 1 }));
  ev = actualizar(ev, clave({ esfuerzo: 'low' }), datos({ aciertos: 1, tokens: 1, segundos: 1 }));
  ev = actualizar(ev, clave({ estacion: 'pruebas' }), datos({ aciertos: 1, tokens: 1, segundos: 1 }));
  ev = actualizar(ev, clave({ ia: 'antigravity', modelo: 'gemini-4-argon-high', esfuerzo: null }), datos({ aciertos: 1, tokens: 1, segundos: 1 }));
  ev = actualizar(ev, clave({ ia: 'antigravity', modelo: 'gemini-4-argon-high', esfuerzo: null }), datos({ fallos: 1, tokens: 1, segundos: 1 }));
  assert.equal(ev.filas.length, 4);
  const agy = ev.filas.find((f) => f.ia === 'antigravity');
  assert.equal(agy.esfuerzo, null);
  assert.equal(agy.alfa, 2);
  assert.equal(agy.beta, 2);
});

test('actualizar no modifica la evidencia recibida', () => {
  const original = actualizar(evidenciaVacia(AHORA), clave(), datos({ aciertos: 2, tokens: 10, segundos: 1 }));
  const copia = structuredClone(original);
  actualizar(original, clave(), datos({ aciertos: 5, fallos: 5, tokens: 99, segundos: 9 }));
  assert.deepEqual(original, copia);
});

test('actualizar: el banco registra el modelo en el catálogo medido y renueva la fecha; lo real no', () => {
  const antes = new Date(AHORA.getTime() - 40 * DIA);
  let ev = evidenciaVacia(antes);
  ev = actualizar(ev, clave(), datos({ aciertos: 1, tokens: 1, segundos: 1, fuente: 'real', ahora: AHORA }));
  assert.deepEqual(ev.catalogo.codex, []);
  assert.equal(ev.actualizada, antes.toISOString());
  ev = actualizar(ev, clave(), datos({ aciertos: 1, tokens: 1, segundos: 1, ahora: AHORA }));
  ev = actualizar(ev, clave({ esfuerzo: 'low' }), datos({ aciertos: 1, tokens: 1, segundos: 1, ahora: AHORA }));
  assert.deepEqual(ev.catalogo.codex, ['gpt-6.1-sol']);
  assert.equal(ev.actualizada, AHORA.toISOString());
});

test('actualizar rechaza datos que no tienen sentido', () => {
  const vacia = evidenciaVacia(AHORA);
  assert.throws(() => actualizar(vacia, clave(), datos({ aciertos: -1 })), ErrorFabrica);
  assert.throws(() => actualizar(vacia, clave(), datos({ fallos: Number.NaN })), ErrorFabrica);
  assert.throws(() => actualizar(vacia, clave(), datos({ aciertos: 1.5 })), ErrorFabrica);
  assert.throws(() => actualizar(vacia, clave(), datos({ aciertos: 1, tokens: -5 })), ErrorFabrica);
  assert.throws(() => actualizar(vacia, clave(), datos({ aciertos: 1, fuente: 'otra' })), ErrorFabrica);
  assert.throws(() => actualizar(vacia, clave({ modelo: '' }), datos({ aciertos: 1 })), ErrorFabrica);
  assert.throws(() => actualizar(vacia, clave({ estacion: 'inventada' }), datos({ aciertos: 1 })), ErrorFabrica);
});

test('actualizar sin observaciones deja la evidencia como estaba', () => {
  const ev = actualizar(evidenciaVacia(AHORA), clave(), datos({ tokens: 5, segundos: 5 }));
  assert.deepEqual(ev, evidenciaVacia(AHORA));
});

test('caducada: detecta los 31 días y no los 30', () => {
  const ev = evidenciaVacia(new Date(AHORA.getTime() - 31 * DIA));
  const resultado = caducada(ev, { codex: [], antigravity: [], claude: [] }, AHORA);
  assert.equal(resultado.caducada, true);
  assert.deepEqual(resultado.motivos, ['la evidencia tiene 31 días']);

  const justa = evidenciaVacia(new Date(AHORA.getTime() - 30 * DIA));
  assert.deepEqual(caducada(justa, { codex: [], antigravity: [], claude: [] }, AHORA), { caducada: false, motivos: [] });
});

test('caducada: detecta un modelo nuevo en el catálogo vivo', () => {
  let ev = evidenciaVacia(AHORA);
  ev = actualizar(ev, clave(), datos({ aciertos: 1, tokens: 1, segundos: 1, ahora: AHORA }));
  const vivos = { codex: ['gpt-6.1-sol', 'gpt-7-nova', 'gpt-7-luna'], antigravity: [], claude: [] };
  const resultado = caducada(ev, vivos, AHORA);
  assert.equal(resultado.caducada, true);
  assert.deepEqual(resultado.motivos, ['modelos sin medir: gpt-7-nova, gpt-7-luna']);
});

test('caducada: junta los dos motivos y no avisa si todo está al día', () => {
  let ev = evidenciaVacia(new Date(AHORA.getTime() - 45 * DIA));
  ev = actualizar(ev, clave(), datos({ aciertos: 1, tokens: 1, segundos: 1, ahora: new Date(AHORA.getTime() - 45 * DIA) }));
  const vivos = { codex: ['gpt-6.1-sol'], antigravity: ['gemini-4-argon-high'], claude: [] };
  assert.deepEqual(caducada(ev, vivos, AHORA).motivos, ['la evidencia tiene 45 días', 'modelos sin medir: gemini-4-argon-high']);

  const alDia = actualizar(evidenciaVacia(AHORA), clave(), datos({ aciertos: 1, tokens: 1, segundos: 1, ahora: AHORA }));
  assert.deepEqual(caducada(alDia, { codex: ['gpt-6.1-sol'], antigravity: [], claude: [] }, AHORA), { caducada: false, motivos: [] });
});

test('caducada: un modelo que ya no está en el catálogo vivo no caduca nada, y un catálogo sin alguna IA se tolera', () => {
  const ev = actualizar(evidenciaVacia(AHORA), clave(), datos({ aciertos: 1, tokens: 1, segundos: 1, ahora: AHORA }));
  assert.equal(caducada(ev, { codex: [] }, AHORA).caducada, false);
});

test('guardar y cargar ida y vuelta, con carpeta 0o700 y archivo 0o600', async () => {
  const home = temporal();
  const ev = actualizar(evidenciaVacia(AHORA), clave(), datos({ aciertos: 8, fallos: 2, tokens: 1000, segundos: 20, ahora: AHORA }));
  await guardar(home, ev);
  if (process.platform !== 'win32') assert.equal(modo(carpeta(home)), 0o700);
  if (process.platform !== 'win32') assert.equal(modo(archivo(home)), 0o600);
  const { evidencia, aviso } = await cargar(home);
  assert.equal(aviso, null);
  assert.deepEqual(evidencia, ev);
  assert.deepEqual(
    readdirSync(carpeta(home)).filter((n) => n.endsWith('.tmp')),
    [],
  );
});

test('cargar sin archivo da evidencia vacía sin aviso y no crea nada', async () => {
  const home = temporal();
  const { evidencia, aviso } = await cargar(home);
  assert.equal(aviso, null);
  assert.equal(evidencia.version, 1);
  assert.deepEqual(evidencia.filas, []);
  assert.deepEqual(evidencia.catalogo, { codex: [], antigravity: [], claude: [] });
  assert.throws(() => statSync(carpeta(home)), { code: 'ENOENT' });
});

test('un JSON corrupto da evidencia vacía con aviso, sin lanzar y sin tocar el archivo hasta guardar', async () => {
  const home = temporal();
  mkdirSync(carpeta(home), { recursive: true });
  writeFileSync(archivo(home), '{ esto no es json');
  const { evidencia, aviso } = await cargar(home);
  assert.deepEqual(evidencia.filas, []);
  assert.match(aviso, /evidencia/u);
  assert.match(aviso, /corrupt|no se pudo leer/iu);
  assert.equal(readFileSync(archivo(home), 'utf8'), '{ esto no es json');

  await guardar(home, evidencia);
  const otra = await cargar(home);
  assert.equal(otra.aviso, null);
});

test('una versión desconocida da evidencia vacía con aviso y no se sobrescribe sola', async () => {
  const home = temporal();
  mkdirSync(carpeta(home), { recursive: true });
  const texto = JSON.stringify({ version: 2, actualizada: AHORA.toISOString(), catalogo: {}, filas: [] });
  writeFileSync(archivo(home), texto);
  const { evidencia, aviso } = await cargar(home);
  assert.deepEqual(evidencia.filas, []);
  assert.match(aviso, /versión/u);
  assert.equal(readFileSync(archivo(home), 'utf8'), texto);
});

test('una forma inválida (alfa negativa, estación inventada, duplicados) cuenta como corrupta', async () => {
  const fila = { ...clave(), alfa: 2, beta: 2, tokensMedios: 1, segundosMedios: 1, banco: 1, real: 0 };
  const base = { version: 1, actualizada: AHORA.toISOString(), catalogo: { codex: [], antigravity: [], claude: [] }, filas: [fila] };
  const casos = [
    { ...base, filas: [{ ...fila, alfa: -1 }] },
    { ...base, filas: [{ ...fila, estacion: 'inventada' }] },
    { ...base, filas: [{ ...fila, ia: 'otra' }] },
    { ...base, filas: [{ ...fila, banco: 1.5 }] },
    { ...base, filas: [fila, fila] },
    { ...base, actualizada: 'ayer' },
    { ...base, catalogo: { codex: [] } },
    [],
    null,
  ];
  for (const caso of casos) {
    const home = temporal();
    mkdirSync(carpeta(home), { recursive: true });
    writeFileSync(archivo(home), JSON.stringify(caso));
    const { evidencia, aviso } = await cargar(home);
    assert.deepEqual(evidencia.filas, [], JSON.stringify(caso));
    assert.notEqual(aviso, null, JSON.stringify(caso));
  }
});

test('un archivo válido escrito a mano se carga tal cual', async () => {
  const home = temporal();
  mkdirSync(carpeta(home), { recursive: true });
  const valida = {
    version: 1,
    actualizada: AHORA.toISOString(),
    catalogo: { codex: ['gpt-6.1-sol'], antigravity: [], claude: [] },
    filas: [{ ...clave(), alfa: 5, beta: 2, tokensMedios: 10, segundosMedios: 3, banco: 5, real: 0 }],
  };
  writeFileSync(archivo(home), JSON.stringify(valida));
  const { evidencia, aviso } = await cargar(home);
  assert.equal(aviso, null);
  assert.deepEqual(evidencia, valida);
});

test('guardar rechaza una evidencia con forma inválida sin escribir nada', async () => {
  const home = temporal();
  const mala = { ...evidenciaVacia(AHORA), filas: [{ ...clave(), alfa: 0, beta: 1, tokensMedios: 0, segundosMedios: 0, banco: 0, real: 0 }] };
  await assert.rejects(guardar(home, mala), ErrorFabrica);
  assert.throws(() => statSync(archivo(home)), { code: 'ENOENT' });
});

test('guardar reemplaza el archivo y corrige un modo flojo', async () => {
  const home = temporal();
  await guardar(home, evidenciaVacia(AHORA));
  chmodSync(archivo(home), 0o644);
  const ev = actualizar(evidenciaVacia(AHORA), clave(), datos({ aciertos: 1, tokens: 1, segundos: 1 }));
  await guardar(home, ev);
  if (process.platform !== 'win32') assert.equal(modo(archivo(home)), 0o600);
  assert.deepEqual((await cargar(home)).evidencia, ev);
});

test('cargar no sigue un enlace simbólico y guardar lo reemplaza sin tocar su destino', { skip: SIN_ENLACES }, async () => {
  const home = temporal();
  mkdirSync(carpeta(home), { recursive: true });
  const ajeno = path.join(home, 'ajeno.json');
  const texto = JSON.stringify(evidenciaVacia(AHORA));
  writeFileSync(ajeno, texto);
  symlinkSync(ajeno, archivo(home));
  const { evidencia, aviso } = await cargar(home);
  assert.deepEqual(evidencia.filas, []);
  assert.notEqual(aviso, null);

  await guardar(home, actualizar(evidenciaVacia(AHORA), clave(), datos({ aciertos: 1, tokens: 1, segundos: 1 })));
  assert.equal(readFileSync(ajeno, 'utf8'), texto);
  assert.equal((await cargar(home)).evidencia.filas.length, 1);
});

test('si la carpeta fabrica es un enlace, cargar da aviso y guardar falla', { skip: SIN_ENLACES }, async () => {
  const home = temporal();
  const destino = path.join(home, 'destino');
  mkdirSync(destino);
  mkdirSync(path.join(home, '.nexakit'));
  symlinkSync(destino, carpeta(home));
  const { evidencia, aviso } = await cargar(home);
  assert.deepEqual(evidencia.filas, []);
  assert.notEqual(aviso, null);
  await assert.rejects(guardar(home, evidenciaVacia(AHORA)), ErrorFabrica);
  assert.deepEqual(readdirSync(destino), []);
});

test('un archivo desmesurado no se lee: evidencia vacía con aviso', async () => {
  const home = temporal();
  mkdirSync(carpeta(home), { recursive: true });
  writeFileSync(archivo(home), ' '.repeat(2 * 1024 * 1024));
  const { evidencia, aviso } = await cargar(home);
  assert.deepEqual(evidencia.filas, []);
  assert.match(aviso, /demasiado grande/u);
});

test('cuantil05 acepta los extremos del rango (1e9 y 1e-6) con valores correctos', () => {
  // Normal: media 0,5 y desviación √(0,25 / 2e9) = 1,118e-5; el 5 % cae 1,645 desviaciones por debajo.
  assert.ok(Math.abs(cuantil05(1e9, 1e9) - 0.4999816) < 1e-6);
  assert.ok(Math.abs(cuantil05(1, 1e9) - 5.1293e-11) < 1e-14);
  const q = cuantil05(1e-6, 1);
  assert.ok(q >= 0 && q < 1e-6);
});

test('el esquema de guardar rechaza alfa o beta por encima de 1e9', async () => {
  const home = temporal();
  const mala = { ...evidenciaVacia(AHORA), filas: [{ ...clave(), alfa: 1e300, beta: 1, tokensMedios: 0, segundosMedios: 0, banco: 0, real: 0 }] };
  await assert.rejects(guardar(home, mala), ErrorFabrica);
  const minima = { ...evidenciaVacia(AHORA), filas: [{ ...clave(), alfa: Number.MIN_VALUE, beta: 1, tokensMedios: 0, segundosMedios: 0, banco: 0, real: 0 }] };
  await assert.rejects(guardar(home, minima), ErrorFabrica);
});

test('actualizar y caducada con un ahora inválido dan ErrorFabrica, no RangeError', () => {
  const invalida = new Date('no es una fecha');
  assert.throws(() => actualizar(evidenciaVacia(AHORA), clave(), datos({ aciertos: 1, ahora: invalida })), ErrorFabrica);
  assert.throws(() => actualizar(evidenciaVacia(AHORA), clave(), datos({ aciertos: 1, ahora: '2026-11-15' })), ErrorFabrica);
  assert.throws(() => caducada(evidenciaVacia(AHORA), {}, invalida), ErrorFabrica);
  assert.throws(() => evidenciaVacia(invalida), ErrorFabrica);
});

test('caducada cuenta días completos: 30,5 días no caduca', () => {
  const ev = evidenciaVacia(new Date(AHORA.getTime() - 30.5 * DIA));
  assert.deepEqual(caducada(ev, {}, AHORA), { caducada: false, motivos: [] });
});

test('guardar conserva un JSON truncado como evidencia.json.corrupto-<fecha> (0o600) y avisa', async () => {
  const home = temporal();
  mkdirSync(carpeta(home), { recursive: true });
  const truncado = '{"version":1,"actualizada":"2026-11-1';
  writeFileSync(archivo(home), truncado);
  chmodSync(archivo(home), 0o644);

  const { evidencia } = await cargar(home);
  const nueva = actualizar(evidencia, clave(), datos({ aciertos: 1, tokens: 1, segundos: 1 }));
  const { aviso } = await guardar(home, nueva, AHORA);

  const copia = path.join(carpeta(home), 'evidencia.json.corrupto-20261115T120000Z');
  assert.equal(readFileSync(copia, 'utf8'), truncado);
  if (process.platform !== 'win32') assert.equal(modo(copia), 0o600);
  assert.match(aviso, /JSON corrupto/u);
  assert.match(aviso, /evidencia\.json\.corrupto-20261115T120000Z/u);
  assert.deepEqual((await cargar(home)).evidencia, nueva);
  if (process.platform !== 'win32') assert.equal(modo(archivo(home)), 0o600);
});

test('guardar con un archivo legible no crea copia ni aviso', async () => {
  const home = temporal();
  await guardar(home, evidenciaVacia(AHORA));
  const { aviso } = await guardar(home, evidenciaVacia(AHORA));
  assert.equal(aviso, null);
  assert.deepEqual(readdirSync(carpeta(home)), ['evidencia.json']);
});

test('guardar conserva también una versión desconocida y no pisa una copia anterior de la misma marca', async () => {
  const home = temporal();
  mkdirSync(carpeta(home), { recursive: true });
  writeFileSync(archivo(home), JSON.stringify({ version: 2, futuro: true }));
  await guardar(home, evidenciaVacia(AHORA), AHORA);
  writeFileSync(archivo(home), 'roto otra vez');
  const { aviso } = await guardar(home, evidenciaVacia(AHORA), AHORA);
  const copias = readdirSync(carpeta(home)).filter((n) => n.includes('.corrupto-')).sort();
  assert.deepEqual(copias, ['evidencia.json.corrupto-20261115T120000Z', 'evidencia.json.corrupto-20261115T120000Z-1']);
  assert.equal(readFileSync(path.join(carpeta(home), copias[0]), 'utf8'), JSON.stringify({ version: 2, futuro: true }));
  assert.equal(readFileSync(path.join(carpeta(home), copias[1]), 'utf8'), 'roto otra vez');
  assert.match(aviso, /-1\./u);
});

test('guardar aparta un enlace simbólico sin tocar su destino', { skip: SIN_ENLACES }, async () => {
  const home = temporal();
  mkdirSync(carpeta(home), { recursive: true });
  const ajeno = path.join(home, 'ajeno.json');
  writeFileSync(ajeno, 'dato ajeno');
  chmodSync(ajeno, 0o644);
  symlinkSync(ajeno, archivo(home));
  await guardar(home, evidenciaVacia(AHORA), AHORA);
  assert.equal(readFileSync(ajeno, 'utf8'), 'dato ajeno');
  assert.equal(modo(ajeno), 0o644);
  assert.ok(readdirSync(carpeta(home)).includes('evidencia.json.corrupto-20261115T120000Z'));
  assert.equal(statSync(archivo(home)).isFile(), true);
});

test('guardar con un ahora inválido da ErrorFabrica sin escribir', async () => {
  const home = temporal();
  await assert.rejects(guardar(home, evidenciaVacia(AHORA), new Date('x')), ErrorFabrica);
  assert.throws(() => statSync(archivo(home)), { code: 'ENOENT' });
});
