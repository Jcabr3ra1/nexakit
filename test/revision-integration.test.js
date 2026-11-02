import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { writeReviewFixtureCli } from '../test-support/fake-clis.js';
import { runRevision } from '../src/revision.js';
import { buildRevisionInvocation } from '../src/revision-adapters.js';

test('three reviewers complete certification and review via real child processes in a temporary HOME', async (t) => {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'review-integration-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo'),
    homeDirectory = path.join(base, 'home');
  await fs.mkdir(root);
  await fs.mkdir(path.join(homeDirectory, '.codex'), { recursive: true });
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Test');
  await fs.writeFile(path.join(root, 'code.js'), 'old');
  git('add', '.');
  git('commit', '-qm', 'base');
  await fs.writeFile(path.join(root, 'code.js'), 'new');
  await fs.writeFile(
    path.join(homeDirectory, '.codex', 'models_cache.json'),
    JSON.stringify({ models: [{ slug: 'fixture', supported_reasoning_levels: [{ effort: 'low' }] }] }),
  );
  const script = writeReviewFixtureCli(base),
    briefFile = path.join(base, 'brief');
  await fs.writeFile(briefFile, 'Revisa el cambio.');
  for (const [client, model] of [
    ['claude', 'haiku'],
    ['codex', 'fixture'],
    ['antigravity', 'gemini-fixture-low'],
  ]) {
    const result = await runRevision(
      {
        client,
        model,
        effort: 'low',
        start: root,
        homeDirectory,
        environment: {},
        briefFile,
        runCommand: async () => ({ status: 0, stdout: 'gemini-fixture-low\tFixture\n' }),
      },
      {
        getVersion: async () => 'fixture-v1',
        buildInvocation: (options) =>
          buildRevisionInvocation({
            ...options,
            resolve: async () => ({ executable: process.execPath, argsPrefix: [script, client] }),
          }),
      },
    );
    assert.equal(result.exitCode, 0, result.report);
    assert.match(result.report, /Informe de prueba/);
    assert.equal(result.usage.outputTokens, 2);
    assert.deepEqual(result.changedFiles, []);
  }
});
