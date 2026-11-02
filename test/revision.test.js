import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runRevision, runRevisionCommand } from '../src/revision.js';
test('review refuses uncertified clients and detects writes even after process failure', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'review-run-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const briefFile = path.join(home, 'brief');
  await fs.writeFile(briefFile, 'Check code');
  const opts = {
    client: 'codex',
    model: 'model',
    effort: 'low',
    briefFile,
    start: home,
    homeDirectory: home,
  };
  let executed = 0,
    shot = 0;
  const deps = {
    validateChoice: async () => {},
    collectContext: async () => ({ root: home, base: 'main', diff: 'DIFF', changedFiles: ['code.js'] }),
    buildInvocation: async () => ({ args: [], executable: 'fake' }),
    getVersion: async () => '1',
    checkIsolation: async () => ({ status: 'failed' }),
    snapshot: async () => new Map(),
    runProcess: async () => {
      executed++;
      return { status: 1, stdout: '', stderr: 'failure' };
    },
  };
  assert.equal((await runRevision(opts, deps)).exitCode, 1);
  assert.equal(executed, 0);
  const r = await runRevision(opts, {
    ...deps,
    checkIsolation: async () => ({ status: 'passed' }),
    snapshot: async () => new Map([['code.js', { sha256: String(shot++) }]]),
  });
  assert.equal(r.exitCode, 1);
  assert.deepEqual(r.changedFiles, ['code.js']);
  assert.equal(executed, 1);
});
test('invalid or duplicate command arguments never invoke a review', async () => {
  for (const args of [[], ['--con', 'codex', '--con', 'claude'], ['--con', 'bad']]) {
    let calls = 0;
    assert.equal(
      await runRevisionCommand(
        args,
        { out: () => {}, err: () => {} },
        {
          run: async () => {
            calls++;
          },
        },
      ),
      2,
    );
    assert.equal(calls, 0);
  }
});
test('successful review presents reported usage and does not infer unknown provenance', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'review-success-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const briefFile = path.join(home, 'brief');
  await fs.writeFile(briefFile, 'review');
  const r = await runRevision(
    { client: 'codex', model: 'model', effort: 'low', briefFile, homeDirectory: home },
    {
      validateChoice: async () => {},
      collectContext: async () => ({ root: home, base: 'main', changedFiles: [], diff: '' }),
      buildInvocation: async () => ({ executable: 'fake', args: [] }),
      getVersion: async () => '1',
      checkIsolation: async () => ({ status: 'passed' }),
      snapshot: async () => new Map(),
      runProcess: async () => ({
        status: 0,
        stdout: [
          { type: 'thread.started', thread_id: 'id' },
          { type: 'item.completed', item: { type: 'agent_message', text: 'Review' } },
          { type: 'turn.completed', usage: { input_tokens: 0, output_tokens: 2 } },
        ]
          .map(JSON.stringify)
          .join('\n'),
      }),
      readProvenance: async () => null,
    },
  );
  assert.equal(r.exitCode, 0);
  assert.equal(r.actual, null);
  assert.equal(r.usage.inputTokens, 0);
});
test('command marks an effort mismatch and prints unknown usage without inventing zero', async () => {
  let text = '';
  const code = await runRevisionCommand(
    ['--con', 'codex', '--modelo', 'same', '--esfuerzo', 'low', '--encargo', 'brief'],
    {
      out: (s) => {
        text += s;
      },
      err: () => {},
    },
    {
      run: async () => ({
        exitCode: 0,
        report: 'Review',
        actual: { model: 'same', effort: 'high', source: 'log' },
        usage: {},
        changedFiles: [],
      }),
    },
  );
  assert.equal(code, 0);
  assert.match(text, /! Modelo pedido:/);
  assert.match(text, /entrada no informado/);
});

test('blank report is a failure even when a parser returns success', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'empty-review-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const briefFile = path.join(home, 'brief');
  await fs.writeFile(briefFile, 'review');
  const result = await runRevision(
    { client: 'codex', model: 'x', effort: 'low', homeDirectory: home, briefFile },
    {
      validateChoice: async () => {},
      collectContext: async () => ({ root: home, diff: '', changedFiles: [] }),
      buildInvocation: async () => ({ args: [] }),
      getVersion: async () => '1',
      checkIsolation: async () => ({ status: 'passed' }),
      snapshot: async () => new Map(),
      runProcess: async () => ({ status: 0 }),
      parseOutput: () => ({ report: '  \n' }),
    },
  );
  assert.equal(result.exitCode, 1);
  assert.equal(result.report, 'El revisor no devolvió informe');
});

test('availability is read-only, excludes the principal and uses current-version certificates', async (t) => {
  const { listAvailableReviewers } = await import('../src/revision.js');
  const homeDirectory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'review-list-')));
  t.after(() => fs.rm(homeDirectory, { recursive: true, force: true }));
  await fs.mkdir(path.join(homeDirectory, '.nexakit'));
  const file = path.join(homeDirectory, '.nexakit', 'revisores.json');
  const record = (client, version, status) => ({
    identity: { client, version, platform: process.platform, isolationProfile: 'test' },
    status,
  });
  await fs.writeFile(
    file,
    JSON.stringify({ old: record('codex', 'old', 'passed'), agy: record('antigravity', '3', 'failed') }),
  );
  const before = await fs.readFile(file, 'utf8');
  const queried = [];
  const deps = {
    getVersion: async (client) => {
      queried.push(client);
      return client === 'codex' ? '2' : '3';
    },
  };
  let rows = await listAvailableReviewers({ principal: 'claude', homeDirectory, environment: {} }, deps);
  assert.deepEqual(
    rows.map((r) => [r.client, r.installed, r.certification]),
    [
      ['codex', true, 'pendiente'],
      ['antigravity', true, 'no'],
    ],
  );
  assert.equal(queried.includes('claude'), false);
  assert.equal(await fs.readFile(file, 'utf8'), before);
  await fs.writeFile(file, JSON.stringify({ current: record('codex', '2', 'passed') }));
  rows = await listAvailableReviewers(
    { principal: 'claude', homeDirectory, environment: {} },
    {
      getVersion: async (client) => {
        if (client === 'antigravity') throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        return '2';
      },
    },
  );
  assert.equal(rows[0].certification, 'sí');
  assert.equal(rows[1].installed, false);
  assert.equal(rows[1].certification, 'no');
  let output = '';
  let calls = 0;
  assert.equal(
    await runRevisionCommand(
      ['--disponibles', '--principal', 'claude'],
      { out: (s) => (output += s), err: () => {} },
      {
        options: { homeDirectory, environment: {} },
        list: async (options) => {
          calls++;
          assert.equal(options.principal, 'claude');
          return rows;
        },
        run: () => assert.fail('must not run a model'),
      },
    ),
    0,
  );
  assert.equal(calls, 1);
  assert.equal(JSON.parse(output)[0].client, 'codex');
});
