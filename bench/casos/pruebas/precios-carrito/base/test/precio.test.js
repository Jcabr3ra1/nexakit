import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conIva } from '../dist/precio.js';

test('conIva aplica la tasa por defecto', () => {
  assert.equal(conIva(100), 119);
});

test('conIva acepta una tasa propia', () => {
  assert.equal(conIva(200, 0.05), 210);
});
