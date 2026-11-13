import test from 'node:test';
import assert from 'node:assert/strict';
const measurement = (values = {}) => ({ id: 'call-1', agent: 'codex', phase: 'implementation', model: 'fixture-model', source: 'client-reported', totalTokens: 100, ...values });
const sample = (values = {}, measurements = [measurement()]) => ({ task: 'same-task', quality: { passed: true }, measurements, ...values });
const compare = async (...args) => (await import('../src/codex-compare.js')).compareCodexSamples(...args);

test('compares complete counters and preserves negative savings', async () => {
  const result = await compare(sample(), sample({}, [measurement({ totalTokens: 120 })]));
  assert.equal(result.comparable, true);
  assert.equal(result.counters.totalTokens.saved, -20);
  assert.equal(result.counters.totalTokens.percent, -20);
  assert.equal(result.before.calls, 1);
});
test('partial counters expose coverage without claiming percentages', async () => {
  const result = await compare(sample({}, [measurement(), measurement({ id: 'call-2', totalTokens: null, inputTokens: 10 })]), sample());
  assert.equal(result.counters.totalTokens.percent, null);
  assert.equal(result.counters.totalTokens.saved, null);
  assert.equal(result.before.counters.totalTokens.missing, 1);
});
test('rejects quality regressions, unequal tasks, invalid and duplicate measurements', async () => {
  for (const after of [sample({ quality: { passed: false } }), sample({ task: 'other' }), sample({}, [measurement({ totalTokens: -1 })]), sample({}, [measurement(), measurement()])]) {
    await assert.rejects(compare(sample(), after));
  }
});
test('model/source/phase changes and unknown coverage cannot establish savings', async () => {
  for (const values of [{ model: 'other' }, { source: 'manual' }, { phase: 'review' }]) {
    const result = await compare(sample(), sample({}, [measurement(values)]));
    assert.equal(result.comparable, false);
    assert.equal(result.counters.totalTokens.percent, null);
  }
  const empty = await compare(sample({}, []), sample({}, []));
  assert.equal(empty.comparable, false);
  const zero = await compare(sample({}, [measurement({ totalTokens: 0 })]), sample());
  assert.equal(zero.counters.totalTokens.percent, null);
});

test('sample reader rejects oversized files and symlink ancestors', async t => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { readCodexSample } = await import('../src/codex-compare.js');
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'codex-sample-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const oversized = path.join(root, 'large.json');
  await fs.writeFile(oversized, ' '.repeat(1024 * 1024 + 1));
  await assert.rejects(readCodexSample(oversized));
  const directory = path.join(root, 'data');
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, 'sample.json'), JSON.stringify(sample()));
  const linked = path.join(root, 'link');
  try { await fs.symlink(directory, linked, 'dir'); }
  catch (error) { if (process.platform === 'win32' && error.code === 'EPERM') { t.skip('Symlink permission unavailable'); return; } throw error; }
  await assert.rejects(readCodexSample(path.join(linked, 'sample.json')));
  await fs.symlink(path.join(directory, 'sample.json'), path.join(root, 'sample-link.json'), 'file');
  await assert.rejects(readCodexSample(path.join(root, 'sample-link.json')));
});
