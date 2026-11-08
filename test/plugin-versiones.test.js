import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { huellasActuales, RUTA_HUELLAS } from '../scripts/plugin-huellas-lib.js';

test('cada plugin que cambia de código sube su versión y queda registrado', () => {
  const registradas = JSON.parse(fs.readFileSync(RUTA_HUELLAS, 'utf8'));
  for (const [nombre, actual] of Object.entries(huellasActuales())) {
    const antes = registradas[nombre];
    assert.ok(antes, `${nombre} no está registrado: ejecuta npm run plugins:huellas`);
    if (antes.huella === actual.huella) continue;
    assert.notEqual(actual.version, antes.version, `${nombre} cambió su código pero sigue en ${actual.version}: sube su "version" (Claude Code no actualiza un plugin con la misma versión) y ejecuta npm run plugins:huellas`);
    assert.fail(`${nombre} subió a ${actual.version}: ejecuta npm run plugins:huellas para registrarlo`);
  }
});
