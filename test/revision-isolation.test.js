import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { checkReviewerIsolation } from '../src/revision-isolation.js';
test('certification caches only passed evidence for the exact version and profile', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'review-cert-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  let calls = 0;
  const options = {
    client: 'codex',
    version: '1',
    platform: 'test',
    isolationProfile: 'profile-a',
    homeDirectory: home,
    runProbe: async () => {
      calls++;
      return { status: 'passed', reason: 'denied and unchanged' };
    },
  };
  assert.equal((await checkReviewerIsolation(options)).status, 'passed');
  await checkReviewerIsolation(options);
  assert.equal(calls, 1);
  await checkReviewerIsolation({ ...options, version: '2' });
  assert.equal(calls, 2);
  await checkReviewerIsolation({ ...options, isolationProfile: 'profile-b' });
  assert.equal(calls, 3);
  const failed = await checkReviewerIsolation({
    ...options,
    version: '3',
    runProbe: async () => ({ status: 'failed', reason: 'file changed' }),
  });
  assert.equal(failed.status, 'failed');
  assert.equal((await checkReviewerIsolation({ ...options, version: '4' })).status, 'passed');
  await fs.writeFile(path.join(home, '.nexakit', 'revisores.json'), 'broken');
  await checkReviewerIsolation(options);
  assert.equal(calls, 5);
});
test('isolation probes require tool denial evidence and unchanged files', async () => {
  const { probeReviewer } = await import('../src/revision-isolation.js');
  const options = { client: 'antigravity', invocation: { args: [], executable: 'fake' }, root: '/project' };
  assert.equal(
    (
      await probeReviewer({
        ...options,
        runProcess: async () => ({
          status: 0,
          stdout: JSON.stringify({ event: 'result', result: { denied_actions: [{ action: 'write_file' }] } }),
        }),
      })
    ).status,
    'unverified',
  );
  assert.equal(
    (
      await probeReviewer({
        ...options,
        runProcess: async (_, { prompt }) => ({
          status: 0,
          stdout: JSON.stringify({
            event: 'result',
            result: {
              denied_actions: [
                {
                  action: prompt.includes('MCP')
                    ? 'mcp'
                    : prompt.includes('shell')
                      ? 'command'
                      : 'write_file',
                },
              ],
            },
          }),
        }),
      })
    ).status,
    'passed',
  );
  assert.equal(
    (
      await probeReviewer({
        ...options,
        runProcess: async () => ({ status: 0, stdout: JSON.stringify({ response: 'I refused' }) }),
      })
    ).status,
    'unverified',
  );
  assert.equal(
    (
      await probeReviewer({
        ...options,
        runProcess: async (invocation) => {
          await fs.writeFile(path.join(invocation.cwd, 'new'), 'write');
          return { status: 0, stdout: '{}' };
        },
      })
    ).status,
    'failed',
  );
});

test('changing permission settings invalidates the isolation profile without storing their contents', async (t) => {
  const { reviewerProfile } = await import('../src/revision-isolation.js');
  const homeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'review-permissions-'));
  t.after(() => fs.rm(homeDirectory, { recursive: true, force: true }));
  await fs.mkdir(path.join(homeDirectory, '.gemini', 'antigravity-cli'), { recursive: true });
  const options = {
    client: 'antigravity',
    root: homeDirectory,
    homeDirectory,
    environment: {},
    invocation: { executable: 'fake', args: [] },
  };
  const first = await reviewerProfile(options);
  await fs.writeFile(
    path.join(homeDirectory, '.gemini', 'antigravity-cli', 'settings.json'),
    '{"permissions":{"allow":["write_file(*)"]}}',
  );
  const second = await reviewerProfile(options);
  assert.notEqual(first, second);
  assert.equal(second.includes('write_file'), false);
});

test('model probes run outside the install lock and failed results are cached by version/profile', async (t) => {
  const { acquireLock } = await import('../src/install-lock.js');
  const homeDirectory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'review-unlocked-')));
  t.after(() => fs.rm(homeDirectory, { recursive: true, force: true }));
  let calls = 0;
  const options = {
    client: 'claude',
    version: '1',
    isolationProfile: 'a',
    homeDirectory,
    runProbe: async () => {
      calls++;
      const lock = await acquireLock(path.join(homeDirectory, '.nexakit'), { waitMs: 0 });
      await lock.release();
      return { status: 'failed', reason: 'write succeeded' };
    },
  };
  assert.equal((await checkReviewerIsolation(options)).status, 'failed');
  assert.equal((await checkReviewerIsolation(options)).status, 'failed');
  assert.equal(calls, 1);
  await checkReviewerIsolation({ ...options, version: '2' });
  assert.equal(calls, 2);
  await checkReviewerIsolation({ ...options, isolationProfile: 'b' });
  assert.equal(calls, 3);
});
