import { test } from 'node:test';
import assert from 'node:assert/strict';

const barraUrl = new URL('../src/antigravity-barra.js', import.meta.url);
const mod = async () => import(barraUrl);

test('formatAntigravityStatusLine renders Claude-style bar with model, effort, context gauge, cache, and quota', async () => {
  const { formatAntigravityStatusLine } = await mod();
  const now = Date.parse('2026-11-14T10:00:00Z');
  const out = formatAntigravityStatusLine({
    model: { id: 'Gemini 4 Hydrogen (High)', display_name: 'Gemini 4 Hydrogen (High)', effort: 'high' },
    context_window: {
      used_percentage: 42,
      current_usage: { input_tokens: 1000, cache_read_input_tokens: 9000 },
    },
    quota: {
      pro: { remaining_fraction: 0.72, reset_in_seconds: 3600 },
    },
    cycle_mode: 'plan',
    sandbox: { enabled: true },
  }, { color: false, now });

  assert.match(out, /^Gemini 4 Hydrogen · high/u);
  assert.match(out, /caché 90%/u);
  assert.match(out, /ctx ▰▰▰▰▰▱▱▱▱▱ 42%/u);
  assert.match(out, /cuota 28%/u);
  assert.doesNotMatch(out, /↻/u, 'reset time should not appear when quota is below 60%');
  assert.match(out, /\bplan\b/u);
  assert.match(out, /\bsandbox\b/u);
});

test('shows quota reset time in local format when quota usage reaches warning threshold', async () => {
  const { formatAntigravityStatusLine } = await mod();
  const now = new Date(2026, 10, 14, 10, 0, 0).getTime();
  const laterToday = new Date(2026, 10, 14, 15, 30, 0).toISOString();
  const out = formatAntigravityStatusLine({
    model: { id: 'gemini-4-carbon-high', effort: 'high' },
    context_window: { used_percentage: 85 },
    quota: {
      low: { remaining_fraction: 0.9, reset_time: laterToday },
      tight: { remaining_fraction: 0.15, reset_time: laterToday },
      ignored: { remaining_fraction: 0.0, disabled: true },
    },
  }, { color: false, now });

  assert.match(out, /cuota 85% ↻ 15:30/u);
  assert.match(out, /ctx ▰▰▰▰▰▰▰▰▰▱ 85%/u);
});

test('renders recommendation state (checkmark or arrow) and up to 4 subagent rows', async () => {
  const { formatAntigravityStatusLine } = await mod();
  const match = formatAntigravityStatusLine({
    model: { display_name: 'Gemini 4 Hydrogen (Medium)', effort: 'medium' },
  }, {
    color: false,
    recommendation: { level: 'Normal', family: 'hydrogen', effort: 'medium', label: 'Hydrogen · medium' },
  });
  assert.match(match, /Gemini 4 Hydrogen · medium  ✓/u);

  const change = formatAntigravityStatusLine({
    model: { display_name: 'Gemini 4 Hydrogen (Medium)', effort: 'medium' },
    subagents: [
      { name: 'a1', role: 'extra', status: 'completed' },
      { name: 'niveles:nivel-ligero', role: 'busca archivos', status: 'completed' },
      { name: 'niveles:revisor-de-calidad', role: 'revisa diff', status: 'running' },
      { name: 'investigador', role: 'lee docs oficiales', status: 'running' },
      { name: 'cazador', role: 'revisa ci', status: 'failed' },
    ],
  }, {
    color: false,
    recommendation: { level: 'Ligero', family: 'flash', effort: 'low', delegate: 'nivel-ligero', label: 'Flash · low' },
  });

  const lines = change.split('\n');
  assert.equal(lines.length, 5, 'main line plus last 4 subagents');
  assert.match(lines[0], /→ delega: nivel-ligero/u);
  assert.doesNotMatch(change, /\ba1\b/u, 'oldest subagent trimmed when > 4');
  assert.match(lines[1], /^  ↳ ligero\s+busca archivos\s+✓$/u);
  assert.match(lines[2], /^  ↳ revisor-de-calidad\s+revisa diff\s+●$/u);
  assert.match(lines[4], /^  ↳ cazador\s+revisa ci\s+✗$/u);
});

test('handles empty, null, zero-window, single-effort models, and Gemini cache counters safely', async () => {
  const { formatAntigravityStatusLine } = await mod();
  const empty = formatAntigravityStatusLine({}, { color: false });
  assert.equal(empty, 'modelo ?');

  const singleEffort = formatAntigravityStatusLine({
    model: { display_name: 'Gemini 3.7 Flash' },
    context_window: {
      used_percentage: 25,
      current_usage: { prompt_token_count: 2000, cached_content_token_count: 8000 },
    },
  }, { color: false });
  assert.match(singleEffort, /^Gemini 3\.7 Flash\s+caché 80%\s+ctx ▰▰▰▱▱▱▱▱▱▱ 25%$/u);
  assert.doesNotMatch(singleEffort, /esfuerzo \?/u);

  const zeroCtx = formatAntigravityStatusLine({
    model: null,
    context_window: { context_window_size: 0, total_input_tokens: 100, current_usage: null },
    quota: { a: { disabled: true, remaining_fraction: 0.1 } },
  }, { color: false });
  assert.equal(zeroCtx, 'modelo ?');
  assert.doesNotMatch(zeroCtx, /NaN|Infinity|caché|cuota|ctx/u);

  const colored = formatAntigravityStatusLine({
    model: { display_name: 'Gemini 4 Flash', effort: 'low' },
    context_window: { used_percentage: 20 },
  }, { color: true });
  assert.match(colored, /\x1b\[/u);
});
