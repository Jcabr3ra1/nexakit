import { test } from 'node:test';
import assert from 'node:assert/strict';
import { esFinDeSemana } from '../src/fechas.js';

test('esFinDeSemana devuelve un valor para cualquier fecha', () => {
  const resultado = esFinDeSemana(new Date('2026-01-03'));
  assert.ok(resultado !== undefined);
  assert.equal(typeof resultado, 'boolean');
});
