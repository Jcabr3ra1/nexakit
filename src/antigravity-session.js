import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const SAFE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u;
const MAX_SESSION_BYTES = 16 * 1024;
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;
const PRUNE_THRESHOLD = 50;
const PRUNE_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_MAP_ENTRIES = 32;

function validSessionId(id) {
  return typeof id === 'string' && SAFE_ID_RE.test(id);
}

const cleanText = (value, max = 120) =>
  typeof value === 'string' && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value)
    ? value.slice(0, max)
    : null;

const clampPercent = (v) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(100, Math.max(0, Math.round(v))) : null;

async function resolveSafeDirectory(options, create) {
  const home = path.resolve(options.homeDirectory ?? os.homedir());
  const root = path.parse(home).root;
  const ancestors = home.slice(root.length).split(path.sep).filter(Boolean);
  let current = root;
  for (const [index, segment] of [...ancestors, '.nexakit', 'antigravity', 'sessions'].entries()) {
    current = path.join(current, segment);
    const isPrivate = index >= ancestors.length;
    try {
      if (create && isPrivate) {
        try { await fs.mkdir(current, { mode: 0o700 }); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
      }
      const stat = await fs.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
      if (create && isPrivate) await fs.chmod(current, 0o700);
    } catch {
      return null;
    }
  }
  return current;
}

function sanitizeRecommendation(record) {
  if (!record || typeof record !== 'object') return null;
  const normalized = {
    level: cleanText(record.level, 32),
    family: cleanText(record.family, 32),
    model: cleanText(record.model, 100),
    effort: cleanText(record.effort, 24),
    delegate: cleanText(record.delegate, 40),
    label: cleanText(record.label, 80),
    reason: cleanText(record.reason, 160),
  };
  return Object.values(normalized).some(Boolean) ? normalized : null;
}

function boundedStringMap(obj, maxVal = 400) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
  const entries = Object.entries(obj).slice(-MAX_MAP_ENTRIES);
  const out = {};
  for (const [k, v] of entries) {
    if (typeof k === 'string' && k && typeof v === 'string') out[k.slice(0, 240)] = v.slice(0, maxVal);
  }
  return out;
}

function boundedNumberMap(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
  const entries = Object.entries(obj).slice(-MAX_MAP_ENTRIES);
  const out = {};
  for (const [k, v] of entries) {
    if (typeof k === 'string' && k && typeof v === 'number' && Number.isFinite(v)) out[k.slice(0, 200)] = Math.max(0, Math.round(v));
  }
  return out;
}

function defaultState(now) {
  return {
    version: 2,
    updatedAt: now,
    recommendation: null,
    usage: { contextPercent: null, quotaPercent: null, warnedContextLevel: 0, warnedQuotaLevel: 0 },
    lecciones: { avisoHecho: false, fallidos: {}, errores: {}, pendingRepetitionNotice: null },
  };
}

function normalizeState(parsed, now) {
  if (!parsed || typeof parsed !== 'object' || typeof parsed.updatedAt !== 'number' || !Number.isFinite(parsed.updatedAt)) {
    return null;
  }
  if (parsed.version === 1) {
    return {
      ...defaultState(parsed.updatedAt),
      recommendation: sanitizeRecommendation(parsed),
    };
  }
  if (parsed.version !== 2) return null;
  const usage = parsed.usage && typeof parsed.usage === 'object' ? parsed.usage : {};
  const lec = parsed.lecciones && typeof parsed.lecciones === 'object' ? parsed.lecciones : {};
  return {
    version: 2,
    updatedAt: parsed.updatedAt ?? now,
    recommendation: sanitizeRecommendation(parsed.recommendation),
    usage: {
      contextPercent: clampPercent(usage.contextPercent),
      quotaPercent: clampPercent(usage.quotaPercent),
      warnedContextLevel: Number.isInteger(usage.warnedContextLevel) ? usage.warnedContextLevel : 0,
      warnedQuotaLevel: Number.isInteger(usage.warnedQuotaLevel) ? usage.warnedQuotaLevel : 0,
    },
    lecciones: {
      avisoHecho: lec.avisoHecho === true,
      fallidos: boundedStringMap(lec.fallidos, 400),
      errores: boundedNumberMap(lec.errores),
      pendingRepetitionNotice: cleanText(lec.pendingRepetitionNotice, 360),
    },
  };
}

async function pruneExpiredSessions(dir, now) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    if (entries.length <= PRUNE_THRESHOLD) return;
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const file = path.join(dir, entry.name);
      const stat = await fs.lstat(file).catch(() => null);
      if (stat && stat.isFile() && !stat.isSymbolicLink() && now - stat.mtimeMs > PRUNE_AGE_MS) {
        await fs.rm(file, { force: true }).catch(() => {});
      }
    }
  } catch {
    // Opportunistic cleanup never blocks session writes.
  }
}

async function readSafeJson(target, options) {
  let handle;
  try {
    const before = await fs.lstat(target);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > MAX_SESSION_BYTES) {
      return null;
    }
    handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_SESSION_BYTES || stat.dev !== before.dev || stat.ino !== before.ino) {
      return null;
    }
    const now = typeof options.now === 'number' && Number.isFinite(options.now) ? options.now : Date.now();
    const state = normalizeState(JSON.parse(await handle.readFile('utf8')), now);
    if (!state) return null;
    const maxAgeMs = options.maxAgeMs ?? DEFAULT_TTL_MS;
    if (now - state.updatedAt > maxAgeMs || state.updatedAt > now + 60_000) return null;
    return state;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function writeSafeState(dir, target, state, now) {
  const existing = await fs.lstat(target).catch((error) => (error.code === 'ENOENT' ? null : 'blocked'));
  if (existing === 'blocked' || (existing && (!existing.isFile() || existing.isSymbolicLink()))) return false;
  const sanitized = normalizeState({ ...state, version: 2, updatedAt: now }, now) ?? defaultState(now);
  const payload = JSON.stringify(sanitized) + '\n';
  if (Buffer.byteLength(payload, 'utf8') > MAX_SESSION_BYTES) return false;
  const temp = path.join(dir, `.tmp-${process.pid}-${randomUUID()}.json`);
  try {
    await fs.writeFile(temp, payload, { flag: 'wx', mode: 0o600 });
    await fs.rename(temp, target);
    await pruneExpiredSessions(dir, now);
    return true;
  } catch {
    return false;
  } finally {
    await fs.rm(temp, { force: true }).catch(() => {});
  }
}

/** Read full bounded Antigravity conversation state if safe and fresh. */
export async function readAntigravitySessionState(conversationId, options = {}) {
  if (!validSessionId(conversationId)) return null;
  const dir = await resolveSafeDirectory(options, false);
  if (!dir) return null;
  return readSafeJson(path.join(dir, `${conversationId}.json`), options);
}

/** Read-modify-write conversation state atomically with private permissions and no prompt text. */
export async function mutateAntigravitySessionState(conversationId, updater, options = {}) {
  if (!validSessionId(conversationId) || typeof updater !== 'function') return null;
  const dir = await resolveSafeDirectory(options, true);
  if (!dir) return null;
  const target = path.join(dir, `${conversationId}.json`);
  const now = typeof options.now === 'number' && Number.isFinite(options.now) ? options.now : Date.now();
  const current = (await readSafeJson(target, options)) ?? defaultState(now);
  const next = await updater(structuredClone(current));
  if (!next) return current;
  const ok = await writeSafeState(dir, target, next, now);
  return ok ? normalizeState({ ...next, version: 2, updatedAt: now }, now) : null;
}

const bucketOf = (pct, thresholds) => (pct === null ? 0 : thresholds.filter((t) => pct >= t).length);

/** Record latest context/quota percentages only when crossing thresholds or shifting noticeably. */
export async function updateAntigravitySessionUsage(conversationId, { contextPercent = null, quotaPercent = null } = {}, options = {}) {
  if (!validSessionId(conversationId)) return false;
  const nextCtx = clampPercent(contextPercent);
  const nextQuota = clampPercent(quotaPercent);
  if (nextCtx === null && nextQuota === null) return false;

  const existing = await readAntigravitySessionState(conversationId, options);
  if (existing) {
    const prevCtx = existing.usage.contextPercent;
    const prevQuota = existing.usage.quotaPercent;
    const ctxChanged = nextCtx !== null && (
      prevCtx === null ||
      Math.abs(nextCtx - prevCtx) >= 5 ||
      bucketOf(nextCtx, [60, 80]) !== bucketOf(prevCtx, [60, 80])
    );
    const quotaChanged = nextQuota !== null && (
      prevQuota === null ||
      Math.abs(nextQuota - prevQuota) >= 5 ||
      bucketOf(nextQuota, [70, 90]) !== bucketOf(prevQuota, [70, 90])
    );
    if (!ctxChanged && !quotaChanged) return true;
  }

  const saved = await mutateAntigravitySessionState(conversationId, (state) => {
    if (nextCtx !== null) state.usage.contextPercent = nextCtx;
    if (nextQuota !== null) state.usage.quotaPercent = nextQuota;
    return state;
  }, options);
  return Boolean(saved);
}

/** Persist structured recommendation metadata for an Antigravity conversation without saving prompt text. */
export async function writeAntigravitySessionRecommendation(conversationId, record, options = {}) {
  if (!validSessionId(conversationId) || !record || typeof record !== 'object') return false;
  const rec = sanitizeRecommendation(record);
  if (!rec) return false;
  const saved = await mutateAntigravitySessionState(conversationId, (state) => {
    state.recommendation = rec;
    return state;
  }, options);
  return Boolean(saved);
}

/** Read recommendation metadata once and lazily sync usage thresholds only when needed. */
export async function syncAndReadAntigravityBarraSession(conversationId, { contextPercent = null, quotaPercent = null } = {}, options = {}) {
  if (!validSessionId(conversationId)) return null;
  const state = await readAntigravitySessionState(conversationId, options);
  const nextCtx = clampPercent(contextPercent);
  const nextQuota = clampPercent(quotaPercent);
  if (nextCtx !== null || nextQuota !== null) {
    const needsWrite = !state || (
      nextCtx !== null && (
        state.usage.contextPercent === null ||
        Math.abs(nextCtx - state.usage.contextPercent) >= 5 ||
        bucketOf(nextCtx, [60, 80]) !== bucketOf(state.usage.contextPercent, [60, 80])
      )
    ) || (
      nextQuota !== null && (
        state.usage.quotaPercent === null ||
        Math.abs(nextQuota - state.usage.quotaPercent) >= 5 ||
        bucketOf(nextQuota, [70, 90]) !== bucketOf(state.usage.quotaPercent, [70, 90])
      )
    );
    if (needsWrite) {
      await mutateAntigravitySessionState(conversationId, (draft) => {
        if (nextCtx !== null) draft.usage.contextPercent = nextCtx;
        if (nextQuota !== null) draft.usage.quotaPercent = nextQuota;
        return draft;
      }, options);
    }
  }
  if (!state?.recommendation) return null;
  return { version: 1, updatedAt: state.updatedAt, ...state.recommendation };
}

/** Read structured recommendation metadata for an Antigravity conversation if safe and fresh. */
export async function readAntigravitySessionRecommendation(conversationId, options = {}) {
  const state = await readAntigravitySessionState(conversationId, options);
  if (!state?.recommendation) return null;
  return { version: 1, updatedAt: state.updatedAt, ...state.recommendation };
}
