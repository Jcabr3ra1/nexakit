import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const hookUrl = new URL('../src/antigravity-hook.js', import.meta.url);
const sessUrl = new URL('../src/antigravity-session.js', import.meta.url);

const runHook = async (...args) => (await import(hookUrl)).runAntigravityHook(...args);
const readSession = async (...args) => (await import(sessUrl)).readAntigravitySessionRecommendation(...args);

test('SessionStart injects concise Antigravity guidance', async () => {
  const res = await runHook({ hookEventName: 'SessionStart', conversationId: 'conv-1' });
  assert.equal(Array.isArray(res.injectSteps), true);
  assert.match(res.injectSteps[0].systemMessage.systemMessage, /\/statusline/u);
  assert.match(res.injectSteps[0].systemMessage.systemMessage, /\/model/u);
});

test('PreInvocation stores recommendation without prompt text and shows user_markdown when action is needed', async (t) => {
  const homeDirectory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agy-hook-')));
  t.after(() => fs.rm(homeDirectory, { recursive: true, force: true }));

  const res = await runHook({
    hookEventName: 'PreInvocation',
    conversationId: 'conv-abc',
    modelName: 'auto',
    lastUserInput: 'Diseña la arquitectura de pagos SECRET_PROMPT $(whoami)',
  }, { homeDirectory, now: 1_700_000_000_000 });

  assert.equal(res.injectSteps.length, 1);
  const step = res.injectSteps[0].systemMessage;
  assert.equal(step.systemMessage, '', 'must not send extra tokens to the model');
  assert.match(step.metadata.user_markdown, /^NexaKit:/u);
  assert.doesNotMatch(JSON.stringify(res), /SECRET_PROMPT|whoami/u);

  const saved = await readSession('conv-abc', { homeDirectory, now: 1_700_000_005_000 });
  assert.equal(saved.level, 'Alto');
  assert.equal(saved.family, 'carbon');
});

test('PreInvocation suppresses chat notice on matching model or pure confirmations and fails open on bad payloads', async (t) => {
  const homeDirectory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agy-hook-keep-')));
  t.after(() => fs.rm(homeDirectory, { recursive: true, force: true }));

  const keep = await runHook({
    hookEventName: 'PreInvocation',
    conversationId: 'conv-keep',
    modelName: 'Gemini 4 Hydrogen (Medium)',
    lastUserInput: 'Implementa el botón de exportar',
  }, { homeDirectory, now: 1_700_000_000_000 });
  assert.deepEqual(keep, {});
  assert.equal((await readSession('conv-keep', { homeDirectory, now: 1_700_000_001_000 })).family, 'hydrogen');

  const confirm = await runHook({
    hookEventName: 'PreInvocation',
    conversationId: 'conv-keep',
    modelName: 'auto',
    lastUserInput: 'ok, listo',
  }, { homeDirectory });
  assert.deepEqual(confirm, {});

  for (const bad of [null, [], 'raw', { hookEventName: 'Unknown' }, { hookEventName: 123 }]) {
    assert.deepEqual(await runHook(bad, { homeDirectory }), {});
  }
});

test('SessionStart and PreInvocation handle lecciones corrections, pending reminders, and sesion thresholds once per level', async (t) => {
  const homeDirectory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agy-hook-full-')));
  t.after(() => fs.rm(homeDirectory, { recursive: true, force: true }));

  // 1. Pre-seed an older unreminded correction in lecciones.jsonl.
  await fs.mkdir(path.join(homeDirectory, '.nexakit'), { recursive: true });
  await fs.writeFile(
    path.join(homeDirectory, '.nexakit', 'lecciones.jsonl'),
    JSON.stringify({ fecha: 1_699_999_000_000, tipo: 'correccion', texto: 'no me respondas en inglés' }) + '\n',
  );

  // SessionStart reminds pending corrections once.
  const start = await runHook({ hookEventName: 'SessionStart', conversationId: 'conv-full' }, { homeDirectory, now: 1_700_000_000_000 });
  const startText = start.injectSteps.map((s) => s.systemMessage.systemMessage).join('\n');
  assert.match(startText, /1 corrección tuya sin guardar/u);
  assert.match(startText, /nivel-ligero/u);

  // Correction on PreInvocation gets logged and injects NOTA_CORRECCION.
  const corr = await runHook({
    hookEventName: 'PreInvocation',
    conversationId: 'conv-full',
    modelName: 'auto',
    lastUserInput: 'te dije que no borres comentarios',
  }, { homeDirectory, now: 1_700_000_001_000 });
  const corrText = corr.injectSteps.map((s) => s.systemMessage.systemMessage).join('\n');
  assert.match(corrText, /parece una corrección/u);

  // Writing a memory note resolves pending corrections in PostToolUse.
  await runHook({
    hookEventName: 'PostToolUse',
    conversationId: 'conv-full',
    toolCall: { id: 'm1', name: 'write_file', args: { Path: path.join(homeDirectory, 'vault', 'memory', 'feedback.md'), Content: 'lección' } },
  }, { homeDirectory, now: 1_700_000_002_000 });
  const ledger = await fs.readFile(path.join(homeDirectory, '.nexakit', 'lecciones.jsonl'), 'utf8');
  assert.match(ledger, /"tipo":"avisada"/u);
  assert.match(ledger, /"tipo":"correccion"/u);
  assert.match(ledger, /"tipo":"guardada"/u);

  // Context 65% and quota 75% recorded via barra trigger sesion warnings once per threshold.
  const { updateAntigravitySessionUsage } = await import(sessUrl);
  await updateAntigravitySessionUsage('conv-full', { contextPercent: 65, quotaPercent: 75 }, { homeDirectory, now: 1_700_000_003_000 });
  const warn1 = await runHook({
    hookEventName: 'PreInvocation',
    conversationId: 'conv-full',
    modelName: 'Gemini 4 Hydrogen (Medium)',
    lastUserInput: 'implementa el botón',
  }, { homeDirectory, now: 1_700_000_004_000 });
  const warn1Text = warn1.injectSteps.map((s) => s.systemMessage.systemMessage).join('\n');
  assert.match(warn1Text, /Contexto al 65 %/u);
  assert.match(warn1Text, /cuota de 5 h al 75 %/u);

  // Repeating at same level does not re-emit the session threshold warnings.
  const repeatSame = await runHook({
    hookEventName: 'PreInvocation',
    conversationId: 'conv-full',
    modelName: 'Gemini 4 Hydrogen (Medium)',
    lastUserInput: 'implementa otro botón',
  }, { homeDirectory, now: 1_700_000_005_000 });
  assert.deepEqual(repeatSame, {});
});
