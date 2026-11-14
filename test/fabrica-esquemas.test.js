import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  Hallazgo,
  ConfigFabrica,
  TablaModelos,
  NOMBRES_ESTACION,
  hallazgosJsonSchema,
} from '../dist/fabrica/esquemas.js';
import { ESTACIONES } from '../dist/fabrica/estaciones.js';

const valido = {
  estacion: 'seguridad',
  gravedad: 'alta',
  archivo: 'src/a.ts',
  linea: 10,
  categoria: 'inyeccion',
  hallazgo: 'x',
  evidencia: 'y',
  propuesta: 'z',
  confianza: 'media',
};

test('Hallazgo acepta uno válido y rechaza gravedad crítica', () => {
  assert.deepEqual(Hallazgo.parse(valido), valido);
  assert.deepEqual(Hallazgo.parse({ ...valido, linea: null }).linea, null);
  assert.throws(() => Hallazgo.parse({ ...valido, gravedad: 'critica' }));
});

test('hallazgosJsonSchema describe InformeEstacion', () => {
  const s = hallazgosJsonSchema();
  assert.equal(s.type, 'object');
  assert.ok(s.required.includes('hallazgos'));
});

test('tabla-modelos.json valida y cubre las 7 estaciones', () => {
  const url = new URL('../dist/fabrica/tabla-modelos.json', import.meta.url);
  const tabla = TablaModelos.parse(JSON.parse(readFileSync(url, 'utf8')));
  for (const e of NOMBRES_ESTACION) assert.ok(tabla[e].length > 0, e);
  assert.equal(NOMBRES_ESTACION.length, 7);
});

test('solo pruebas permite órdenes', () => {
  for (const e of NOMBRES_ESTACION) {
    const esperado = e === 'pruebas' ? ['npm test'] : [];
    assert.deepEqual(ESTACIONES[e].ordenesPermitidas, esperado, e);
    assert.ok(ESTACIONES[e].foco && ESTACIONES[e].criterios.length > 0);
  }
});

test('ConfigFabrica: paralelismo fuera de rango falla y vacío usa 4', () => {
  assert.throws(() => ConfigFabrica.parse({ paralelismo: 9 }), /paralelismo/);
  assert.throws(() => ConfigFabrica.parse({ paralelismo: 0 }), /paralelismo/);
  assert.equal(ConfigFabrica.parse({}).paralelismo, 4);
  assert.equal(ConfigFabrica.parse({ estaciones: { codigo: { activa: false } } }).estaciones.codigo.activa, false);
});
