import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { rewriteCodexToolInput as rewrite } from '../src/codex-pre-tool.js';
const options = { platform: 'linux', environment: {}, executable: '/usr/bin/node', entrypoint: '/opt/nexakit/bin/nexakit.js' };
const payload = (command, fields = {}) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command, ...fields } });
const output = command => rewrite(payload(command), options);

test('rewrites approved commands synchronously, quoting tokens and preserving input without mutation', () => {
  const input = payload(' npm   run test -- --reporter=dot ', { cwd: '/tmp/project', timeout_ms: 1000, sandbox_permissions: 'use_default', description: 'tests', stdin: 'fixture input' });
  const snapshot = structuredClone(input);
  Object.freeze(input.tool_input); Object.freeze(input);
  const result = rewrite(input, options);
  assert.deepEqual(result, { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: {
    ...snapshot.tool_input, command: "NEXAKIT_CODEX_TEMP_OUTPUT=1 '/usr/bin/node' '/opt/nexakit/bin/nexakit.js' 'codex' 'ejecutar' '--' 'npm' 'run' 'test' '--' '--reporter=dot'",
  } } });
  assert.deepEqual(input, snapshot);
  assert.equal((result.hookSpecificOutput.updatedInput.command.match(/NEXAKIT_CODEX_TEMP_OUTPUT=1/g) ?? []).length, 1);
  assert.doesNotMatch(result.hookSpecificOutput.updatedInput.command, /[;&|<>]/);
  assert.equal(typeof result.then, 'undefined');
  assert.deepEqual(rewrite({ ...input, tool_input: result.hookSpecificOutput.updatedInput }, options), {});
});

test('allows only explicit package tasks and bounded noninteractive node test arguments', () => {
  for (const command of [
    'npm test', 'pnpm test -- --runInBand', 'yarn test', 'bun test test/unit.test.ts',
    'npm run build', 'pnpm run lint', 'bun run check', 'yarn build', 'yarn lint', 'yarn check',
    'node --test', 'node --test test/unit.test.js test/other.mjs',
    'node --test --test-reporter=tap --test-concurrency=1 --test-timeout 5000 test/unit.cjs',
    'node --test --test-name-pattern=works --test-only --test-force-exit test/a.js',
  ]) assert.ok(output(command).hookSpecificOutput, command);
});

test('rejects shell syntax and oversized or malformed inputs without a permission response', () => {
  for (const command of [
    'npm test;pwd', 'npm test && pwd', 'npm test | cat', 'npm test > out', 'npm test < in',
    'npm test &', 'npm test\n', 'npm test\r', 'npm\ttest', 'npm test "a"', "npm test 'a'",
    'npm test $HOME', 'npm test ${HOME}', 'npm test $(pwd)', 'npm test `pwd`',
    'npm test *.js', 'npm test a?.js', 'npm test [ab]', 'npm test {a,b}', 'npm test a\\b',
    'npm test\0', 'npm test café', '', ' '.repeat(20), null, [], {}, 42,
    `npm test ${'a'.repeat(16384)}`,
  ]) assert.deepEqual(output(command), {}, String(command));
  for (const input of [null, undefined, [], {}, { tool_input: null }, { ...payload('npm test'), tool_input: [] }]) {
    assert.deepEqual(rewrite(input, options), {});
  }
  assert.ok(output('npm test ' + 'a'.repeat(16384 - 9)).hookSpecificOutput);
});

test('rejects unapproved programs, tasks, interactive modes and node code-loading flags', () => {
  for (const command of [
    'node script.js', 'node -e code', 'npm exec test', 'npm install', 'npm run dev', 'npm run test:unit',
    'yarn dev', 'pnpm build', '/tmp/npm test', 'env npm test', 'nexakit codex ejecutar -- npm test',
    'npm test --watch', 'npm test --watch=false', 'npm test --watchAll', 'npm test -w',
    'npm test --inspect=9229', 'npm test --interactive', 'npm test --tty', 'npm test --background',
    'npm test -- --mode=watch', 'node --test --watch', 'node --test --inspect-brk',
    'node --test --require test.js', 'node --test --import=test.js', 'node --test -e code',
    'node --test --test-reporter=./reporter.js', 'node --test --test-reporter-destination=out',
    'node --test --unknown', 'node --test script.sh', 'node --test --test-timeout=oops',
    'node --test --test-concurrency', 'node --test --test-timeout 0',
    'npm test --json', 'npm test --json=true', 'npm test --reporter=json',
    'npm test --reporter json', 'npm test --reporters=default,json', 'npm test --reporter=json-summary',
    'NEXAKIT_CODEX_TEMP_OUTPUT=1 node --test test/a.js',
    'node --test --test-reporter=json', 'npm test --ui', 'npm test -i', 'npm test -it',
  ]) assert.deepEqual(output(command), {}, command);
});

test('bypasses other events/tools/platforms, full output and nondefault sandbox or interactive fields', () => {
  for (const event of ['PermissionRequest', 'PostToolUse', undefined]) {
    assert.deepEqual(rewrite({ ...payload('npm test'), hook_event_name: event }, options), {});
  }
  for (const tool_name of ['bash', 'exec_command', undefined]) {
    assert.deepEqual(rewrite({ ...payload('npm test'), tool_name }, options), {});
  }
  for (const mode of ['require_escalated', 'danger-full-access', '', null, false]) {
    assert.deepEqual(rewrite(payload('npm test', { sandbox_permissions: mode }), options), {});
  }
  for (const fields of [{ tty: true }, { interactive: true }, { background: true }, { run_in_background: true }]) {
    assert.deepEqual(rewrite(payload('npm test', fields), options), {});
  }
  assert.deepEqual(rewrite(payload('npm test'), { ...options, platform: 'win32' }), {});
  assert.deepEqual(rewrite(payload('npm test'), { ...options, environment: { NEXAKIT_SALIDA: 'completa' } }), {});
  assert.ok(rewrite(payload('npm test', { tty: false }), { ...options, platform: 'darwin' }).hookSpecificOutput);
});

test('requires safe absolute wrapper paths and quotes spaces and apostrophes literally', () => {
  for (const key of ['executable', 'entrypoint']) {
    for (const value of ['relative.js', '', '/tmp/a\n.js', '/tmp/a\0.js', 42]) {
      assert.deepEqual(rewrite(payload('npm test'), { ...options, [key]: value }), {});
    }
  }
  const result = rewrite(payload('npm test'), { ...options, executable: "/opt/node's bin/node", entrypoint: '/opt/my toolkit/nexakit.js' });
  assert.equal(result.hookSpecificOutput.updatedInput.command,
    "NEXAKIT_CODEX_TEMP_OUTPUT=1 '/opt/node'\"'\"'s bin/node' '/opt/my toolkit/nexakit.js' 'codex' 'ejecutar' '--' 'npm' 'test'");
  const defaults = rewrite(payload('npm test'), { environment: {} });
  if (process.platform !== 'win32') {
    assert.ok(defaults.hookSpecificOutput.updatedInput.command.includes(fileURLToPath(new URL('../bin/nexakit.js', import.meta.url))));
    assert.ok(defaults.hookSpecificOutput.updatedInput.command.startsWith(`NEXAKIT_CODEX_TEMP_OUTPUT=1 '${process.execPath}' `));
  }
});

test('rewritten subprocess runs node tests once in the same cwd, retaining exact original, summary and failing status', { skip: process.platform === 'win32' }, async t => {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'pretool-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, "project's directory");
  await fs.mkdir(cwd);
  await fs.writeFile(path.join(root, 'capture.cjs'), `
    if (process.execArgv.includes('--test')) {
      const fs = require('node:fs');
      for (const stream of [process.stdout, process.stderr]) {
        const write = stream.write;
        stream.write = function(chunk, ...args) {
          fs.appendFileSync(process.env.ORIGINAL_CAPTURE, chunk);
          return write.call(this, chunk, ...args);
        };
      }
    }
  `);
  await fs.writeFile(path.join(cwd, 'verbose.test.cjs'), `
    const fs = require('node:fs');
    const assert = require('node:assert/strict');
    fs.appendFileSync('runs', '1');
    fs.writeFileSync('context.json', JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(1) }));
    require('node:test')('verbose failure', () => {
      for (let i = 0; i < 500; i++) console.log('VERBOSE-' + i + '-' + 'x'.repeat(100));
      assert.equal(1, 2);
    });
  `);
  const command = rewrite(payload('node --test --test-reporter=tap verbose.test.cjs'), { environment: {} }).hookSpecificOutput.updatedInput.command;
  const environment = { ...process.env, TMPDIR: root, NEXAKIT_SALIDA: '', NODE_OPTIONS: `--require=${path.join(root, 'capture.cjs')}`,
    ORIGINAL_CAPTURE: path.join(root, 'original.log'), PATH: `${path.dirname(process.execPath)}:${process.env.PATH}` };
  delete environment.NODE_TEST_CONTEXT;
  const child = spawnSync('/bin/sh', ['-c', command], {
    cwd, encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024,
    env: environment,
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 1, child.stderr);
  assert.equal(await fs.readFile(path.join(cwd, 'runs'), 'utf8'), '1');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(cwd, 'context.json'), 'utf8')), {
    cwd, argv: [path.join(cwd, 'verbose.test.cjs')],
  });
  const folder = path.join(root, `nexakit-codex-${process.getuid()}`, '.nexakit/salidas');
  const names = await fs.readdir(folder);
  assert.equal(names.length, 1);
  const original = await fs.readFile(path.join(root, 'original.log'), 'utf8');
  assert.equal(await fs.readFile(path.join(folder, names[0]), 'utf8'), original);
  assert.match(original, /VERBOSE-250-/);
  assert.match(original, /not ok/);
  assert.match(child.stdout, /omitidas/);
  assert.match(child.stdout, /not ok/);
  assert.ok(child.stdout.length < original.length / 2);
  assert.equal((await fs.stat(path.join(folder, names[0]))).mode & 0o777, 0o600);
});
