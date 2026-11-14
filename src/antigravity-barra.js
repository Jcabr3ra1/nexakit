import { etiquetaDeAgente, formatoReinicio, medidor, tono, tonoCache } from '../plugins/nexakit-modelo/hooks/barra.js';
import { LIMITE_ALTO } from '../plugins/nexakit-modelo/hooks/decidir.js';
import { parseAntigravityModel } from './antigravity-recommendation.js';

const MAX_FILAS = 4;
const MIN_ETIQUETA = 8;
const MAX_ETIQUETA = 18;
const MAX_ROL = 36;

const ICONO = Object.freeze({
  pending: ['●', 'warning'],
  running: ['●', 'warning'],
  waiting: ['●', 'warning'],
  idle: ['✓', 'success'],
  completed: ['✓', 'success'],
  failed: ['✗', 'error'],
  error: ['✗', 'error'],
  killed: ['✗', 'error'],
});

const ANSI = Object.freeze({
  antigravity: '36',
  success: '32',
  warning: '33',
  error: '31',
  suggestion: '35',
});

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const clampPercent = (v) => Math.min(100, Math.max(0, v));
const fitText = (text, width) => (text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width));

/** Extract highest active quota bucket usage percentage and ISO reset timestamp. */
export function extractQuotaSummary(quota, now = Date.now()) {
  if (!quota || typeof quota !== 'object' || Array.isArray(quota)) return null;
  let best = null;
  for (const bucket of Object.values(quota)) {
    if (!bucket || typeof bucket !== 'object' || bucket.disabled === true) continue;
    if (!isNum(bucket.remaining_fraction)) continue;
    const percentUsed = clampPercent((1 - bucket.remaining_fraction) * 100);
    let resetsAt = null;
    if (typeof bucket.reset_time === 'string') {
      resetsAt = bucket.reset_time;
    } else if (isNum(bucket.reset_in_seconds) && bucket.reset_in_seconds > 0) {
      resetsAt = new Date(now + bucket.reset_in_seconds * 1000).toISOString();
    }
    if (!best || percentUsed > best.percentUsed) best = { percentUsed, resetsAt };
  }
  return best;
}

/** Extract cache hit percentage only when current_usage reports explicit cache read tokens. */
export function extractCachePercent(contextWindow) {
  const usage = contextWindow?.current_usage;
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;
  const read = isNum(usage.cache_read_input_tokens)
    ? usage.cache_read_input_tokens
    : isNum(usage.cached_content_token_count)
      ? usage.cached_content_token_count
      : null;
  if (read === null || read < 0) return null;
  const creation = isNum(usage.cache_creation_input_tokens) && usage.cache_creation_input_tokens > 0
    ? usage.cache_creation_input_tokens
    : 0;
  const input = isNum(usage.input_tokens) && usage.input_tokens > 0
    ? usage.input_tokens
    : isNum(usage.prompt_token_count) && usage.prompt_token_count > 0
      ? usage.prompt_token_count
      : 0;
  const total = read + creation + input;
  return total > 0 ? clampPercent((read / total) * 100) : null;
}

/** Extract context window used percentage without inventing values on unknown/zero windows. */
export function extractContextPercent(contextWindow) {
  if (!contextWindow || typeof contextWindow !== 'object' || Array.isArray(contextWindow)) return null;
  if (isNum(contextWindow.used_percentage)) return clampPercent(contextWindow.used_percentage);
  if (isNum(contextWindow.remaining_percentage)) return clampPercent(100 - contextWindow.remaining_percentage);
  if (isNum(contextWindow.context_window_size) && contextWindow.context_window_size > 0 && isNum(contextWindow.total_input_tokens)) {
    return clampPercent((contextWindow.total_input_tokens / contextWindow.context_window_size) * 100);
  }
  return null;
}

function recommendationSegment(recommendation, current, quotaPercent) {
  if (!recommendation || typeof recommendation !== 'object') return null;
  if (recommendation.delegate === 'nivel-ligero' && current.family === recommendation.family && current.effort === recommendation.effort) {
    return { text: '  ✓', color: 'success' };
  }
  if (recommendation.delegate) {
    return { text: `  → delega: ${recommendation.delegate}`, color: 'suggestion' };
  }
  if (current.family && current.family === recommendation.family) {
    return current.effort === recommendation.effort
      ? { text: '  ✓', color: 'success' }
      : { text: `  → ${recommendation.label}`, color: 'suggestion' };
  }
  if (recommendation.level === 'Alto' && isNum(quotaPercent) && quotaPercent >= LIMITE_ALTO) {
    return { text: `  → Hydrogen · high (cuota ${Math.round(quotaPercent)} %)`, color: 'suggestion' };
  }
  return recommendation.label ? { text: `  → ${recommendation.label}`, color: 'suggestion' } : null;
}

function buildSubagentRows(subagents) {
  if (!Array.isArray(subagents) || subagents.length === 0) return [];
  const recent = subagents.slice(-MAX_FILAS);
  const labels = recent.map((entry) => etiquetaDeAgente(entry?.name));
  const roles = recent.map((entry) => (typeof entry?.role === 'string' ? entry.role.trim() : ''));
  const column = Math.min(MAX_ETIQUETA, Math.max(MIN_ETIQUETA, ...labels.map((label) => label.length))) + 2;
  const roleWidth = Math.min(MAX_ROL, Math.max(0, ...roles.map((role) => role.length)));
  return recent.map((entry, index) => {
    const label = labels[index].length > MAX_ETIQUETA ? `${labels[index].slice(0, MAX_ETIQUETA - 1)}…` : labels[index];
    const role = roles[index];
    const statusKey = typeof entry?.status === 'string' ? entry.status.toLowerCase() : '';
    const [icon, color] = ICONO[statusKey] ?? ['?', undefined];
    return [
      { text: `  ↳ ${label.padEnd(column)}`, dim: true },
      ...(roleWidth > 0 ? [{ text: `${fitText(role, roleWidth)}  ` }] : []),
      { text: icon, color },
    ];
  });
}

/** Build structured bar segments and subagent rows from an Antigravity statusLine payload. */
export function buildAntigravityStatusSegments(payload, { recommendation = null, now = Date.now() } = {}) {
  const safe = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const model = parseAntigravityModel(safe.model);
  const segments = [
    { text: model.name, color: model.name === 'modelo ?' ? undefined : 'antigravity', bold: model.name !== 'modelo ?' },
    ...(model.effort ? [{ text: ` · ${model.effort}` }] : []),
  ];

  const quota = extractQuotaSummary(safe.quota, now);
  const advice = recommendationSegment(recommendation, model, quota?.percentUsed);
  if (advice) segments.push(advice);

  const cache = extractCachePercent(safe.context_window);
  if (cache !== null) {
    segments.push({ text: '   caché ', dim: true }, { text: `${Math.round(cache)}%`, color: tonoCache(cache) });
  }

  const ctx = extractContextPercent(safe.context_window);
  if (ctx !== null) {
    segments.push({ text: '    ctx ', dim: true }, { text: medidor(ctx), color: tono(ctx) }, { text: ` ${Math.round(ctx)}%` });
  }

  if (quota !== null) {
    const quotaColor = tono(quota.percentUsed);
    segments.push({ text: '   cuota ', dim: true }, { text: `${Math.round(quota.percentUsed)}%`, color: quotaColor });
    const resetLabel = quotaColor === 'success' ? null : formatoReinicio(quota.resetsAt, now);
    if (resetLabel) segments.push({ text: ` ↻ ${resetLabel}`, dim: true });
  }

  if (typeof safe.cycle_mode === 'string' && safe.cycle_mode.trim()) {
    segments.push({ text: `   ${safe.cycle_mode.trim()}`, dim: true });
  }
  if (safe.sandbox?.enabled === true) {
    segments.push({ text: '   sandbox', dim: true });
  }

  return { segments, subagents: buildSubagentRows(safe.subagents) };
}

function renderSegment(segment, color) {
  if (!color) return segment.text;
  const codes = [];
  if (segment.bold) codes.push('1');
  if (segment.dim) codes.push('2');
  if (segment.color && ANSI[segment.color]) codes.push(ANSI[segment.color]);
  return codes.length ? `\x1b[${codes.join(';')}m${segment.text}\x1b[0m` : segment.text;
}

/** Render Antigravity statusLine payload as ANSI or plain text lines. */
export function formatAntigravityStatusLine(payload, { recommendation = null, now = Date.now(), color = true } = {}) {
  const { segments, subagents } = buildAntigravityStatusSegments(payload, { recommendation, now });
  const renderRow = (row) => row.map((segment) => renderSegment(segment, color)).join('');
  return [renderRow(segments), ...subagents.map(renderRow)].join('\n');
}
