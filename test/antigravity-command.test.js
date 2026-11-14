import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';

const cmdUrl = new URL('../src/antigravity-command.js', import.meta.url);

async function run(argv, options = {}, stdin = '') {
  let stdout = '';
  let stderr = '';
  const { runAntigravityCommand } = await import(cmdUrl);
  const code = await runAntigravityCommand(
    argv,
    {
      out: (s) => { stdout += s; },
      err: (s) => { stderr += s; },
      input: Readable.from(stdin === '' ? [] : [stdin]),
    },
    options,
  );
  return { code, stdout, stderr };
}

test('strict argument parsing rejects invalid subcommands, duplicate or missing flags', async () => {
  for (const argv of [
    [],
    ['bogus'],
    ['barra', '--json', '--json'],
    ['barra', '--unknown'],
    ['preparar', '--salida'],
    ['preparar', '--apply', '--apply'],
    ['recomendar'],
    ['recomendar', '--tarea'],
    ['recomendar', '--tarea', '   '],
    ['hook', '--json'],
    ['barra', 'extra'],
  ]) {
    assert.equal((await run(argv)).code, 2, argv.join(' '));
  }
  const help = await run(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /nexakit antigravity barra/u);
});

test('barra reads statusLine JSON, merges stored session recommendation, and fails open on invalid stdin', async (t) => {
  const homeDirectory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agy-cli-barra-')));
  t.after(() => fs.rm(homeDirectory, { recursive: true, force: true }));

  const hookRes = await run(
    ['hook'],
    { homeDirectory, now: 1_700_000_000_000 },
    JSON.stringify({
      hookEventName: 'PreInvocation',
      conversationId: 'conv-42',
      modelName: 'auto',
      lastUserInput: 'Diseña la arquitectura de caché',
    }),
  );
  assert.equal(hookRes.code, 0);
  assert.equal(JSON.parse(hookRes.stdout).injectSteps.length, 1);

  const payload = JSON.stringify({
    conversation_id: 'conv-42',
    model: { id: 'Gemini 4 Hydrogen (Medium)', display_name: 'Gemini 4 Hydrogen (Medium)', effort: 'medium' },
    context_window: { used_percentage: 35 },
    quota: { default: { remaining_fraction: 0.8 } },
    subagents: [{ name: 'investigador', role: 'lee docs', status: 'running' }],
  });

  const bar = await run(['barra', '--sin-color'], { homeDirectory, now: 1_700_000_005_000 }, payload);
  assert.equal(bar.code, 0);
  assert.equal(bar.stderr, '');
  assert.match(bar.stdout, /^Gemini 4 Hydrogen · medium  → Carbon · high/u);
  assert.match(bar.stdout, /ctx ▰▰▰▰▱▱▱▱▱▱ 35%/u);
  assert.match(bar.stdout, /cuota 20%/u);
  assert.match(bar.stdout, /↳ investigador/u);

  const jsonBar = await run(['barra', '--json'], { homeDirectory, now: 1_700_000_005_000 }, payload);
  assert.equal(jsonBar.code, 0);
  const parsed = JSON.parse(jsonBar.stdout);
  assert.equal(Array.isArray(parsed.segments), true);
  assert.equal(parsed.subagents.length, 1);

  for (const bad of ['', 'SECRET bad json', 'SECRET' + 'x'.repeat(1024 * 1024 + 5)]) {
    const failedOpen = await run(['barra'], { homeDirectory }, bad);
    assert.equal(failedOpen.code, 0);
    assert.equal(failedOpen.stdout, '');
    assert.doesNotMatch(failedOpen.stderr, /SECRET/);
  }
});

test('hook fails open on malformed or oversized stdin and leaks nothing to stderr', async () => {
  for (const bad of ['', 'SECRET invalid', 'SECRET' + 'x'.repeat(1024 * 1024 + 5)]) {
    const res = await run(['hook'], {}, bad);
    assert.equal(res.code, 0);
    assert.deepEqual(JSON.parse(res.stdout), {});
    assert.doesNotMatch(res.stdout + res.stderr, /SECRET/);
  }
});

test('recomendar and preparar work through CLI and real bin/nexakit.js entrypoint without touching personal files', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agy-cli-e2e-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const rec = await run(['recomendar', '--tarea', 'Corrige el bug de login', '--json']);
  assert.equal(rec.code, 0);
  assert.equal(JSON.parse(rec.stdout).recommendation.level, 'Exigente');

  const preview = spawnSync(
    process.execPath,
    ['bin/nexakit.js', 'antigravity', 'preparar', '--json'],
    { encoding: 'utf8', env: { ...process.env, HOME: root } },
  );
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(JSON.parse(preview.stdout).applied, false);
  assert.deepEqual(await fs.readdir(root), []);

  const outDir = path.join(root, 'antigravity-pack');
  const apply = spawnSync(
    process.execPath,
    ['bin/nexakit.js', 'antigravity', 'preparar', '--salida', outDir, '--apply', '--json'],
    { encoding: 'utf8', env: { ...process.env, HOME: root } },
  );
  assert.equal(apply.status, 0, apply.stderr);
  assert.equal(JSON.parse(apply.stdout).applied, true);
  assert.deepEqual((await fs.readdir(outDir)).sort(), ['README.md', 'agents', 'hooks.json', 'plugin.json', 'settings.statusline.json']);

  const agentsPreview = await run(['antigravity', 'agentes', '--json'].slice(1), { homeDirectory: root });
  assert.equal(agentsPreview.code, 0);
  assert.equal(JSON.parse(agentsPreview.stdout).files.length, 10);

  const agentsApply = await run(['agentes', '--apply', '--json'], { homeDirectory: root });
  assert.equal(agentsApply.code, 0);
  assert.equal((await fs.readdir(path.join(root, '.gemini', 'config', 'agents'))).length, 10);

  const execRes = await run(
    ['ejecutar', '--', process.execPath, '-e', "console.log('line\\n'.repeat(200))"],
    { homeDirectory: root },
  );
  assert.equal(execRes.code, 0);
  assert.match(execRes.stdout, /nexakit: \d+ líneas omitidas/u);

  const tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agy-tmp-ahorro-')));
  t.after(() => fs.rm(tmpRoot, { recursive: true, force: true }));
  const execTemp = await run(
    ['ejecutar', '--', process.execPath, '-e', "console.log('line\\n'.repeat(200))"],
    { homeDirectory: root, tempDirectory: tmpRoot, env: { ...process.env, NEXAKIT_ANTIGRAVITY_TEMP_OUTPUT: '1' } },
  );
  assert.equal(execTemp.code, 0);
  const { runAhorroCommand } = await import('../src/ahorro-command.js');
  let ahorroJson = '';
  const ahorroCode = await runAhorroCommand(
    ['--json'],
    { out: (s) => { ahorroJson += s; }, err: () => {} },
    { homeDirectory: root, tempDirectory: tmpRoot },
  );
  assert.equal(ahorroCode, 0);
  assert.equal(JSON.parse(ahorroJson).total.recortes, 2);
});
