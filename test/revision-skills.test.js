import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
test('the retired skills no longer exist in the package', async () => {
  const retired = ['programar', 'estado', 'spec-driven-development', 'depurar', 'desarrollo-con-pruebas'];
  for (const name of retired)
    await assert.rejects(fs.access(new URL(`../skills/${name}/SKILL.md`, import.meta.url)));
});
