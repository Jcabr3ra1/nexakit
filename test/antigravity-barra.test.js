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

test('Antigravity pinta las estaciones de la fábrica y lee activo.json sin seguir enlaces', async () => {
  const { formatAntigravityStatusLine, leerActivoDeFabrica } = await mod();
  const { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const home = mkdtempSync(join(tmpdir(), 'nexakit-barra-'));
  try {
    const now = Date.parse('2026-11-15T10:00:00Z');
    const activo = {
      pid: process.pid, id: 'r', repo: 'x', actualizado: '2026-11-15T09:59:00Z',
      estaciones: [
        { estacion: 'implementar', ia: 'codex', modelo: 'gpt-5.5', esfuerzo: 'high', estado: 'en-curso', tokens: 900 },
        { estacion: 'revisar', ia: 'antigravity', modelo: 'Gemini 4', esfuerzo: 'low', estado: 'fallida', tokens: 0 },
      ],
    };
    assert.equal(leerActivoDeFabrica(home), null, 'ausente');
    const base = join(home, '.nexakit', 'fabrica');
    mkdirSync(base, { recursive: true });
    writeFileSync(join(base, 'activo.json'), JSON.stringify(activo));
    const leido = leerActivoDeFabrica(home);
    assert.equal(leido.estaciones.length, 2);
    const lineas = formatAntigravityStatusLine({}, { color: false, now, fabrica: leido }).split('\n');
    assert.equal(lineas.length, 3);
    assert.match(lineas[1], /↳ implementar +codex gpt-5\.5 high +● +900 tokens/u);
    assert.match(lineas[2], /↳ revisar +agy Gemini 4 low +✗/u);

    writeFileSync(join(base, 'activo.json'), JSON.stringify({ ...activo, pid: 2 ** 22 + 7 }));
    assert.equal(leerActivoDeFabrica(home), null, 'proceso muerto');
    writeFileSync(join(base, 'activo.json'), `{"estaciones":[],"x":"${'a'.repeat(70 * 1024)}"}`);
    assert.equal(leerActivoDeFabrica(home), null, 'más de 64 KiB');
    writeFileSync(join(base, 'activo.json'), '{roto');
    assert.equal(leerActivoDeFabrica(home), null, 'inválido');
    rmSync(join(base, 'activo.json'));
    writeFileSync(join(home, 'otro.json'), JSON.stringify(activo));
    symlinkSync(join(home, 'otro.json'), join(base, 'activo.json'));
    assert.equal(leerActivoDeFabrica(home), null, 'enlace simbólico');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('Antigravity limpia el texto de la fábrica y alinea sus filas con las de los subagentes', async () => {
  const { formatAntigravityStatusLine } = await mod();
  const now = Date.parse('2026-11-15T10:00:00Z');
  const fabrica = {
    actualizado: '2026-11-15T10:00:00Z',
    estaciones: [
      { estacion: 'x\x1b]0;t\x07y', ia: 'codex', modelo: '\x1b[2Jm', esfuerzo: 'low', estado: 'ok', tokens: 0 },
      { estacion: 'mala', ia: 'constructor', modelo: 'm', esfuerzo: null, estado: 'ok', tokens: 0 },
    ],
  };
  const payload = { subagents: [{ name: 'niveles:nivel-normal', role: 'implementar', status: 'running' }] };
  const out = formatAntigravityStatusLine(payload, { color: true, now, fabrica });
  assert.doesNotMatch(out.replace(/\x1b\[[0-9;]*m/gu, ''), /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u);
  const [, a, b, ...resto] = formatAntigravityStatusLine(payload, { color: false, now, fabrica }).split('\n');
  assert.equal(resto.length, 0);
  assert.match(a, /●$/u);
  assert.match(b, /✓$/u);
  assert.equal(a.length, b.length, 'el icono queda en la misma columna');
});
