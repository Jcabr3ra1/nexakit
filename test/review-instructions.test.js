import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  planReviewInstructions,
  applyReviewInstructions,
  removeReviewInstructions,
} from '../src/review-instructions.js';
test('instructions preserve user content, are idempotent and detach only the managed block', async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'review-instructions-'));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(projectRoot, '.codex'));
  await fs.writeFile(path.join(projectRoot, '.codex', 'AGENTS.md'), 'USER RULES\n');
  const lock = { assertHeld: async () => {} };
  const plan = await planReviewInstructions({ homeDirectory: projectRoot });
  assert.equal(plan.items.length, 3);
  await applyReviewInstructions(plan, lock);
  assert.ok(
    (await fs.readFile(path.join(projectRoot, '.codex', 'AGENTS.md'), 'utf8')).startsWith('USER RULES\n'),
  );
  assert.ok(
    (await planReviewInstructions({ homeDirectory: projectRoot })).items.every((i) => i.state === 'ready'),
  );
  await removeReviewInstructions({ homeDirectory: projectRoot }, lock);
  assert.equal(await fs.readFile(path.join(projectRoot, '.codex', 'AGENTS.md'), 'utf8'), 'USER RULES\n');
  await assert.rejects(fs.access(path.join(projectRoot, '.claude', 'CLAUDE.md')));
});
test('instructions reject a file changed after confirmation and preserve it', async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'review-race-'));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  const plan = await planReviewInstructions({ homeDirectory: projectRoot });
  await fs.mkdir(path.join(projectRoot, '.codex'));
  await fs.writeFile(path.join(projectRoot, '.codex', 'AGENTS.md'), 'changed');
  await assert.rejects(applyReviewInstructions(plan, { assertHeld: async () => {} }), /cambió/);
  assert.equal(await fs.readFile(path.join(projectRoot, '.codex', 'AGENTS.md'), 'utf8'), 'changed');
});

test('edited managed rules are left alone during uninstall', async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'review-edit-'));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  const lock = { assertHeld: async () => {} };
  await applyReviewInstructions(await planReviewInstructions({ homeDirectory: projectRoot }), lock);
  const target = path.join(projectRoot, '.claude', 'CLAUDE.md');
  const edited = (await fs.readFile(target, 'utf8')).replace('Método de trabajo', 'Reglas propias');
  await fs.writeFile(target, edited);
  await removeReviewInstructions({ homeDirectory: projectRoot }, lock);
  assert.equal(await fs.readFile(target, 'utf8'), edited);
});

test('global instructions respect CODEX_HOME and never alter project files', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'review-global-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const homeDirectory = path.join(root, 'home'),
    projectRoot = path.join(root, 'project');
  await fs.mkdir(homeDirectory);
  await fs.mkdir(projectRoot);
  for (const name of ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md'])
    await fs.writeFile(path.join(projectRoot, name), 'PROJECT RULES\n');
  execFileSync('git', ['init', '-q', projectRoot]);
  execFileSync('git', ['-C', projectRoot, 'add', '.']);
  const trackedBefore = execFileSync('git', ['-C', projectRoot, 'diff', '--cached'], { encoding: 'utf8' });
  const environment = { CODEX_HOME: path.join(root, 'custom-codex') };
  const plan = await planReviewInstructions({ homeDirectory, projectRoot, environment });
  const lock = { assertHeld: async () => {} };
  await applyReviewInstructions(plan, lock);
  assert.ok(
    (await fs.readFile(path.join(environment.CODEX_HOME, 'AGENTS.md'), 'utf8')).includes(
      'Si el usuario dice',
    ),
  );
  assert.ok(
    (await fs.readFile(path.join(homeDirectory, '.claude', 'CLAUDE.md'), 'utf8')).includes('nexakit'),
  );
  assert.ok(
    (await fs.readFile(path.join(homeDirectory, '.gemini', 'GEMINI.md'), 'utf8')).includes('nexakit'),
  );
  assert.ok((await fs.stat(path.join(homeDirectory, '.nexakit', 'review-instructions.json'))).isFile());
  for (const name of ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md'])
    assert.equal(await fs.readFile(path.join(projectRoot, name), 'utf8'), 'PROJECT RULES\n');
  assert.deepEqual(
    (await fs.readdir(projectRoot)).filter((name) => name !== '.git'),
    ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'],
  );
  assert.equal(
    execFileSync('git', ['-C', projectRoot, 'diff', '--cached'], { encoding: 'utf8' }),
    trackedBefore,
  );
  assert.equal(execFileSync('git', ['-C', projectRoot, 'diff'], { encoding: 'utf8' }), '');
});
