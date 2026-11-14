import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('la fábrica compilada expone VERSION_FABRICA', async () => {
  const modulo = await import('../dist/fabrica/indice.js');
  assert.equal(modulo.VERSION_FABRICA, '1');
});

test('package.json publica dist/', () => {
  const paquete = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(paquete.files.includes('dist/'));
});
