import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runRevisionProcess } from '../src/revision-process.js';
const invocation = (code) => ({ executable: process.execPath, args: ['-e', code], env: { ...process.env } });
test('process transmits exact stdin without shell interpretation and keeps nonzero status', async () => {
  const r = await runRevisionProcess(
    invocation("process.stdin.pipe(process.stdout);process.stdin.on('end',()=>process.exitCode=3)"),
    { prompt: 'literal $() `hello`\n' },
  );
  assert.equal(r.stdout, 'literal $() `hello`\n');
  assert.equal(r.status, 3);
  assert.equal(r.timedOut, false);
});
test('process bounds stdout and stderr, handles missing binaries, timeout and pre-abort', async () => {
  await assert.rejects(
    runRevisionProcess(invocation("process.stdout.write('x'.repeat(200))"), {
      prompt: '',
      maxOutputBytes: 100,
    }),
    /salida/,
  );
  await assert.rejects(runRevisionProcess({ executable: '/missing/reviewer', args: [] }, { prompt: '' }));
  const r = await runRevisionProcess(invocation('setInterval(()=>{},1000)'), { prompt: '', timeoutMs: 80 });
  assert.equal(r.timedOut, true);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runRevisionProcess(invocation(''), { prompt: '', signal: controller.signal }), {
    code: 'ABORT_ERR',
  });
});
test('Antigravity input uses event=user and a structured message over stdin', async () => {
  const r = await runRevisionProcess(
    { ...invocation('process.stdin.pipe(process.stdout)'), inputFormat: 'stream-json' },
    { prompt: 'Review the diff' },
  );
  assert.deepEqual(JSON.parse(r.stdout), {
    event: 'user',
    message: { role: 'user', content: 'Review the diff' },
  });
});
test('process cancels an invocation already running', async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 80);
  try {
    await assert.rejects(
      runRevisionProcess(invocation('setInterval(()=>{},1000)'), { prompt: '', signal: controller.signal }),
      { code: 'ABORT_ERR' },
    );
  } finally {
    clearTimeout(timer);
  }
});
