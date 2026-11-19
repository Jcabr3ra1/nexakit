import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cargarCasos, SEPARACION_MINIMA, validarCaso } from '../dist/fabrica/banco/casos.js';
import { NOMBRES_ESTACION } from '../dist/fabrica/esquemas.js';
import { ErrorFabrica } from '../dist/fabrica/errores.js';
import { fileSymlinkSkipReason } from '../testing/symlink-capability.js';

const SIN_ENLACES = process.platform === 'win32' || fileSymlinkSkipReason();

const EXTERNAS = ['seguridad', 'arquitectura', 'pruebas', 'rendimiento', 'documentacion'];

/** Crea un caso mínimo en un directorio temporal y devuelve su ruta. */
function crearCaso(esperado, { base = { 'a.js': 'uno\ndos\ntres\n' }, cambio = { 'a.js': 'uno\ndos\ntres\ncuatro\n' } } = {}, estacion = 'seguridad') {
  const raiz = mkdtempSync(path.join(tmpdir(), 'banco-'));
  const dir = path.join(raiz, estacion, 'caso');
  for (const [carpeta, archivos] of [['base', base], ['cambio', cambio]]) {
    for (const [ruta, contenido] of Object.entries(archivos)) {
      mkdirSync(path.dirname(path.join(dir, carpeta, ruta)), { recursive: true });
      writeFileSync(path.join(dir, carpeta, ruta), contenido);
    }
  }
  writeFileSync(path.join(dir, 'esperado.json'), JSON.stringify(esperado));
  return { raiz, dir };
}

const valido = (extra = {}) => ({
  estacion: 'seguridad',
  base: { archivos: ['a.js'] },
  cambio: { archivos: ['a.js'] },
  fallos: [{ archivo: 'a.js', lineas: [2, 4], categoria: 'inyeccion', descripcion: 'Algo falla.' }],
  ...extra,
});

test('todos los casos del banco validan y cubren las estaciones externas', () => {
  const casos = cargarCasos();
  for (const estacion of EXTERNAS) {
    const de = casos.filter((c) => c.estacion === estacion);
    assert.ok(de.filter((c) => c.fallos.length > 0).length >= 2, `${estacion}: faltan casos con fallo`);
    assert.ok(de.filter((c) => c.fallos.length === 0).length >= 1, `${estacion}: falta un caso limpio`);
  }
  for (const c of casos) assert.ok(NOMBRES_ESTACION.includes(c.estacion));
  const claves = casos.map((c) => `${c.estacion}/${c.nombre}`);
  assert.deepEqual(claves, [...claves].sort());
});

test('cada caso con fallo siembra al menos 5 fallos de su estación', () => {
  // Con 2 casos de 5 fallos y 1 limpio, una medición perfecta da Beta(12, 1): su cuantil del 5 % (0,779) supera el
  // umbral del riesgo medio (0,75). Con 1 fallo por caso se quedaría en Beta(4, 1), con 0,47.
  const conFallos = cargarCasos().filter((c) => c.fallos.length > 0);
  assert.ok(conFallos.length >= 10);
  for (const c of conFallos) assert.ok(c.fallos.length >= 5, `${c.estacion}/${c.nombre} tiene ${c.fallos.length} fallos`);
});

/** Archivo de 40 líneas para probar la separación entre fallos. */
const CUARENTA = Array.from({ length: 40 }, (_, i) => `const v${i + 1} = ${i + 1};`).join('\n') + '\n';
const fallo = (lineas, archivo = 'a.js') => ({ archivo, lineas, categoria: 'inyeccion', descripcion: 'd' });
const conFallos = (fallos, archivos = ['a.js']) =>
  crearCaso(valido({ base: { archivos }, cambio: { archivos }, fallos }), {
    base: Object.fromEntries(archivos.map((a) => [a, CUARENTA])),
    cambio: Object.fromEntries(archivos.map((a) => [a, CUARENTA])),
  }).dir;

test('los fallos del mismo archivo deben separarse al menos 7 líneas', () => {
  assert.equal(SEPARACION_MINIMA, 7);
  // Del final de uno al principio del siguiente hay 7 líneas: con margen ±3 ningún hallazgo casa con los dos.
  assert.deepEqual(validarCaso(conFallos([fallo([2, 4]), fallo([11, 12]), fallo([19, 19])])), []);
  // 6 líneas ya no bastan, también si los fallos vienen desordenados.
  assert.match(validarCaso(conFallos([fallo([10, 10]), fallo([2, 4])])).join('\n'), /fallos\[0\] y fallos\[1\].*separarse al menos 7/u);
  // Ni los rangos que se solapan o se contienen.
  for (const par of [[[2, 8], [5, 9]], [[2, 20], [6, 7]]]) {
    assert.match(validarCaso(conFallos(par.map((l) => fallo(l)))).join('\n'), /separarse/u, JSON.stringify(par));
  }
});

test('la separación solo cuenta dentro del mismo archivo', () => {
  assert.deepEqual(validarCaso(conFallos([fallo([3, 3], 'a.js'), fallo([3, 4], 'b.js')], ['a.js', 'b.js'])), []);
});

test('un fallo repetido se rechaza', () => {
  const errores = validarCaso(conFallos([fallo([5, 6]), fallo([20, 20]), { ...fallo([5, 6]), categoria: 'otra' }]));
  assert.match(errores.join('\n'), /fallos\[2\] repite el archivo y las líneas de fallos\[0\]/u);
});

test('un caso limpio tiene fallos vacíos', () => {
  const { dir } = crearCaso(valido({ fallos: [] }));
  assert.deepEqual(validarCaso(dir), []);
});

test('un caso correcto no da errores', () => {
  assert.deepEqual(validarCaso(crearCaso(valido()).dir), []);
});

test('un rango de líneas fuera del archivo se rechaza', () => {
  for (const lineas of [[1, 5], [0, 2], [3, 2], [5, 5]]) {
    const { dir } = crearCaso(valido({ fallos: [{ archivo: 'a.js', lineas, categoria: 'x', descripcion: 'd' }] }));
    const errores = validarCaso(dir);
    assert.ok(errores.length > 0, `debía rechazar ${lineas}`);
    assert.match(errores.join('\n'), /líneas/);
  }
});

test('las líneas cuentan sobre la versión de cambio', () => {
  // cambio tiene 4 líneas; base solo 3.
  const { dir } = crearCaso(valido({ fallos: [{ archivo: 'a.js', lineas: [4, 4], categoria: 'x', descripcion: 'd' }] }));
  assert.deepEqual(validarCaso(dir), []);
});

test('rechaza rutas absolutas, con .. y archivos inexistentes', () => {
  for (const ruta of ['/etc/passwd', '../fuera.js', 'a/../../b.js', 'no-existe.js']) {
    const { dir } = crearCaso(valido({ base: { archivos: [ruta] }, fallos: [] }));
    assert.ok(validarCaso(dir).length > 0, ruta);
  }
});

test('rechaza enlaces simbólicos', { skip: SIN_ENLACES }, () => {
  const { dir } = crearCaso(valido({ fallos: [] }));
  writeFileSync(path.join(dir, 'secreto.txt'), 'x');
  symlinkSync(path.join(dir, 'secreto.txt'), path.join(dir, 'cambio', 'enlace.js'));
  const e = valido({ fallos: [] });
  e.cambio.archivos.push('enlace.js');
  writeFileSync(path.join(dir, 'esperado.json'), JSON.stringify(e));
  assert.match(validarCaso(dir).join('\n'), /enlace simbólico/);
});

test('el archivo del fallo debe estar en cambio.archivos', () => {
  const { dir } = crearCaso(valido({ cambio: { archivos: ['b.js'] } }), {
    cambio: { 'a.js': 'x\n', 'b.js': 'y\n' },
  });
  assert.match(validarCaso(dir).join('\n'), /cambio\.archivos/);
});

test('la estación debe coincidir con la carpeta y ser conocida', () => {
  assert.ok(validarCaso(crearCaso(valido({ estacion: 'pruebas' })).dir).length > 0);
  const { dir } = crearCaso(valido({ estacion: 'inventada', fallos: [] }), undefined, 'inventada');
  assert.ok(validarCaso(dir).length > 0);
});

test('categoría y descripción se validan', () => {
  for (const f of [
    { categoria: 'con espacios', descripcion: 'd' },
    { categoria: '', descripcion: 'd' },
    { categoria: 'x'.repeat(33), descripcion: 'd' },
    { categoria: 'ok', descripcion: '   ' },
  ]) {
    const { dir } = crearCaso(valido({ fallos: [{ archivo: 'a.js', lineas: [1, 1], ...f }] }));
    assert.ok(validarCaso(dir).length > 0, JSON.stringify(f));
  }
  const { dir } = crearCaso(valido({ fallos: [{ archivo: 'a.js', lineas: [1, 1], categoria: 'inyección_2-b', descripcion: 'd' }] }));
  assert.deepEqual(validarCaso(dir), []);
});

test('un esperado.json ilegible o con campos de más da error, no excepción', () => {
  const { dir } = crearCaso(valido());
  writeFileSync(path.join(dir, 'esperado.json'), '{no es json');
  assert.ok(validarCaso(dir).length > 0);
  writeFileSync(path.join(dir, 'esperado.json'), JSON.stringify({ ...valido(), sobra: 1 }));
  assert.ok(validarCaso(dir).length > 0);
});

test('cargarCasos lanza ErrorFabrica si un caso es inválido', () => {
  const { raiz } = crearCaso(valido({ fallos: [{ archivo: 'a.js', lineas: [9, 9], categoria: 'x', descripcion: 'd' }] }));
  assert.throws(() => cargarCasos(raiz), (e) => e instanceof ErrorFabrica && /seguridad\/caso/.test(e.message));
  rmSync(raiz, { recursive: true, force: true });
});

test('cargarCasos ordena por estación y caso', () => {
  const { raiz } = crearCaso(valido({ fallos: [] }));
  const otro = path.join(raiz, 'seguridad', 'abc');
  mkdirSync(path.join(otro, 'base'), { recursive: true });
  mkdirSync(path.join(otro, 'cambio'), { recursive: true });
  writeFileSync(path.join(otro, 'base', 'a.js'), 'x\n');
  writeFileSync(path.join(otro, 'cambio', 'a.js'), 'y\n');
  writeFileSync(path.join(otro, 'esperado.json'), JSON.stringify(valido({ fallos: [] })));
  assert.deepEqual(cargarCasos(raiz).map((c) => c.nombre), ['abc', 'caso']);
});
