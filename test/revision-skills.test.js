import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { getToolkitCommandsGuide } from '../src/toolkit-commands-guide.js';
test('the command guide and package no longer expose programar or estado', async () => {
  const ids = getToolkitCommandsGuide().workflowCommands.map((c) => c.id);
  assert.equal(ids.includes('programar'), false);
  assert.equal(ids.includes('estado'), false);
  assert.ok(ids.includes('revisar'));
  for (const name of ['programar', 'estado'])
    await assert.rejects(fs.access(new URL(`../skills/${name}/SKILL.md`, import.meta.url)));
});
