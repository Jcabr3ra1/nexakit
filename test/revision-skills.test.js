import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { getToolkitCommandsGuide } from '../src/toolkit-commands-guide.js';
test('the command guide and package no longer expose the retired skills', async () => {
  const ids = getToolkitCommandsGuide().workflowCommands.map((c) => c.id);
  const retired = ['programar', 'estado', 'spec-driven-development', 'depurar', 'desarrollo-con-pruebas'];
  for (const name of retired) assert.equal(ids.includes(name), false, name);
  assert.ok(ids.includes('revisar'));
  assert.ok(ids.includes('quality-gate'));
  assert.ok(ids.includes('superpowers:systematic-debugging'), 'the process now comes from Superpowers');
  for (const name of retired)
    await assert.rejects(fs.access(new URL(`../skills/${name}/SKILL.md`, import.meta.url)));
});
