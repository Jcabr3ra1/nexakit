import { test } from 'node:test';
import assert from 'node:assert/strict';
import { esFinDeSemana } from '../src/fechas.js';

test('esFinDeSemana reconoce sábado y domingo', () => {
  assert.equal(esFinDeSemana(new Date('2026-01-03T12:00:00Z')), true);
  assert.equal(esFinDeSemana(new Date('2026-01-04T12:00:00Z')), true);
});

test('esFinDeSemana rechaza los días laborables', () => {
  assert.equal(esFinDeSemana(new Date('2026-01-05T12:00:00Z')), false);
  assert.equal(esFinDeSemana(new Date('2026-01-02T12:00:00Z')), false);
});
