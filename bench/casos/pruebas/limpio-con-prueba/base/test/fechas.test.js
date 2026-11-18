import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diasEntre } from '../src/fechas.js';

test('diasEntre cuenta días completos', () => {
  assert.equal(diasEntre(new Date('2026-01-01'), new Date('2026-01-11')), 10);
});
