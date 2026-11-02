import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  planReviewInstructions,
  applyReviewInstructions,
  removeReviewInstructions,
} from '../src/review-instructions.js';
test('instructions preserve user content, are idempotent and detach only the managed block', async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'review-instructions-'));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  await fs.writeFile(path.join(projectRoot, 'AGENTS.md'), 'USER RULES\n');
  const lock = { assertHeld: async () => {} };
  const plan = await planReviewInstructions({ projectRoot });
  assert.equal(plan.items.length, 3);
  await applyReviewInstructions(plan, lock);
  assert.ok((await fs.readFile(path.join(projectRoot, 'AGENTS.md'), 'utf8')).startsWith('USER RULES\n'));
  assert.ok((await planReviewInstructions({ projectRoot })).items.every((i) => i.state === 'ready'));
  await removeReviewInstructions(projectRoot, lock);
  assert.equal(await fs.readFile(path.join(projectRoot, 'AGENTS.md'), 'utf8'), 'USER RULES\n');
  await assert.rejects(fs.access(path.join(projectRoot, 'CLAUDE.md')));
});
test('instructions reject a file changed after confirmation and preserve it', async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'review-race-'));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  const plan = await planReviewInstructions({ projectRoot });
  await fs.writeFile(path.join(projectRoot, 'AGENTS.md'), 'changed');
  await assert.rejects(applyReviewInstructions(plan, { assertHeld: async () => {} }), /cambió/);
  assert.equal(await fs.readFile(path.join(projectRoot, 'AGENTS.md'), 'utf8'), 'changed');
});

test('edited managed rules are left alone during uninstall', async t => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'review-edit-'));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  const lock = { assertHeld: async () => {} };
  await applyReviewInstructions(await planReviewInstructions({ projectRoot }), lock);
  const target = path.join(projectRoot, 'CLAUDE.md');
  const edited = (await fs.readFile(target, 'utf8')).replace('Método de trabajo', 'Reglas propias');
  await fs.writeFile(target, edited);
  await removeReviewInstructions(projectRoot, lock);
  assert.equal(await fs.readFile(target, 'utf8'), edited);
});
