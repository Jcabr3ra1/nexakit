import { LIMITE_ALTO } from '../plugins/nexakit-modelo/hooks/decidir.js';
import { recomendarPorTexto } from '../plugins/nexakit-modelo/hooks/recomendar.js';

const MAX_TASK_BYTES = 16 * 1024;
const CONFIRMATION_RE = /^(?:¡?)(?:s[ií]|ok|okay|dale|listo|vale|perfecto|bien|contin[uú]a|sigue|hazlo|adelante|gracias|de una|claro|no)(?:[\s.!,¡]+(?:s[ií]|ok|okay|dale|listo|vale|perfecto|bien|contin[uú]a|sigue|hazlo|adelante|gracias|de una|claro|no))*[\s.!,]*$/iu;
const EFFORT_SUFFIX_RE = /-(low|medium|high|xhigh|max)$/iu;
const EFFORT_PAREN_RE = /\s*\((low|medium|high|xhigh|max)\)\s*$/iu;
const KNOWN_FAMILY_RE = /\b(flash|hydrogen|argon|carbon|luna|terra|sol|astra|haiku|sonnet|opus)\b/iu;
const SLUG_FAMILY_RE = /^(?:gpt|gemini|claude)-\d+(?:\.\d+)*-([a-z][a-z0-9]*)$/iu;
const VALID_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

const FAMILIES_BY_LEVEL = Object.freeze({
  Ligero: ['flash', 'hydrogen'],
  Normal: ['hydrogen', 'flash'],
  Exigente: ['hydrogen', 'argon', 'flash'],
  Alto: ['carbon', 'argon'],
});

const DEFAULT_FAMILY_BY_LEVEL = Object.freeze({
  Ligero: 'flash',
  Normal: 'hydrogen',
  Exigente: 'hydrogen',
  Alto: 'carbon',
});

const FAMILY_LABELS = Object.freeze({
  flash: 'Flash',
  hydrogen: 'Hydrogen',
  argon: 'Argon',
  carbon: 'Carbon',
});

const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();

/** Extract clean display name, family, and effort from an Antigravity model payload or string. */
export function parseAntigravityModel(model) {
  const rawName = typeof model === 'string'
    ? model.trim()
    : model && typeof model === 'object'
      ? String(model.display_name || model.id || '').trim()
      : '';
  if (!rawName) return { name: 'modelo ?', family: null, effort: null };

  const rawEffort = model && typeof model === 'object' && typeof model.effort === 'string'
    ? model.effort.trim().toLowerCase()
    : null;
  const suffixEffort = rawName.match(EFFORT_SUFFIX_RE)?.[1]?.toLowerCase() ?? null;
  const parenEffort = rawName.match(EFFORT_PAREN_RE)?.[1]?.toLowerCase() ?? null;
  const candidateEffort = rawEffort || parenEffort || suffixEffort;
  const effort = candidateEffort && VALID_EFFORTS.has(candidateEffort) ? candidateEffort : null;

  const cleanName = rawName.replace(EFFORT_PAREN_RE, '').replace(EFFORT_SUFFIX_RE, '').trim() || rawName;
  const family = cleanName.match(KNOWN_FAMILY_RE)?.[1]?.toLowerCase()
    ?? cleanName.match(SLUG_FAMILY_RE)?.[1]?.toLowerCase()
    ?? null;
  return { name: cleanName, family, effort };
}

function resolveCatalogPick(catalog, level, effort) {
  if (!Array.isArray(catalog) || catalog.length === 0) return null;
  const families = FAMILIES_BY_LEVEL[level] ?? [];
  const valid = catalog.filter((entry) => entry && typeof entry.model === 'string' && entry.model.trim());
  for (const family of families) {
    const exact = valid.find((entry) => {
      const parsed = parseAntigravityModel(entry.model);
      const efforts = Array.isArray(entry.efforts) && entry.efforts.length ? entry.efforts : parsed.effort ? [parsed.effort] : [];
      return parsed.family === family && efforts.includes(effort);
    });
    if (exact) return { model: exact.model, family, effort };
  }
  for (const family of families) {
    const fallback = valid.find((entry) => parseAntigravityModel(entry.model).family === family);
    if (fallback) {
      const parsed = parseAntigravityModel(fallback.model);
      const pickedEffort = Array.isArray(fallback.efforts) && fallback.efforts[0] ? fallback.efforts[0] : (parsed.effort ?? effort);
      return { model: fallback.model, family, effort: pickedEffort };
    }
  }
  return null;
}

function classifyToAntigravity(classification, quotaPercent) {
  if (classification.delegar === 'nivel-ligero') {
    return { level: 'Ligero', effort: 'low', delegate: 'nivel-ligero', reason: 'tarea mecánica: mejor delegarla', isDesign: false };
  }
  if (classification.delegar === 'nivel-alto') {
    return { level: 'Alto', effort: 'high', delegate: 'nivel-alto', reason: 'fallo difícil o seguridad', isDesign: false };
  }
  if (classification.model === 'opus') {
    if (typeof quotaPercent === 'number' && Number.isFinite(quotaPercent) && quotaPercent >= LIMITE_ALTO) {
      return {
        level: 'Exigente',
        effort: 'high',
        delegate: null,
        reason: `cuota al ${Math.round(quotaPercent)} %: Hydrogen con más esfuerzo`,
        isDesign: true,
      };
    }
    return { level: 'Alto', effort: 'high', delegate: null, reason: 'diseño o ambigüedad', isDesign: true };
  }
  if (classification.effort === 'high') {
    return { level: 'Exigente', effort: 'high', delegate: null, reason: 'fallo o pruebas: verificar importa', isDesign: false };
  }
  if (classification.effort === 'low') {
    return { level: 'Normal', effort: 'low', delegate: null, reason: 'pregunta breve: respuesta rápida', isDesign: false };
  }
  return { level: 'Normal', effort: 'medium', delegate: null, reason: 'trabajo habitual', isDesign: false };
}

function unavailableResult(reason) {
  return {
    available: false,
    silent: false,
    recommendation: null,
    action: 'unavailable',
    delegate: null,
    reason,
    message: `NexaKit no pudo recomendar para Antigravity: ${reason}.`,
    source: 'family-guide',
    automaticChange: false,
  };
}

/** Classify a task locally for Antigravity CLI without calling any model or network. */
export async function recommendAntigravityTask(text, options = {}) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_TASK_BYTES) {
    return unavailableResult('texto no válido o superior al límite de 16 KiB');
  }
  const trimmed = text.trim();
  const classification = recomendarPorTexto(trimmed);
  if (!trimmed || (classification.reason === 'trabajo habitual' && !classification.delegar && !classification.fallo && trimmed.length < 40 && CONFIRMATION_RE.test(trimmed))) {
    return {
      available: true,
      silent: true,
      recommendation: null,
      action: 'keep',
      delegate: null,
      reason: '',
      message: '',
      source: Array.isArray(options.catalog) && options.catalog.length ? 'agy-models' : 'family-guide',
      automaticChange: false,
    };
  }

  const target = classifyToAntigravity(classification, options.quotaPercent);
  const pick = resolveCatalogPick(options.catalog, target.level, target.effort);
  const source = pick ? 'agy-models' : 'family-guide';
  const family = pick?.family ?? DEFAULT_FAMILY_BY_LEVEL[target.level];
  const effort = pick?.effort ?? target.effort;
  const model = pick?.model ?? null;
  const familyLabel = FAMILY_LABELS[family] ?? capitalize(family);
  const label = `${familyLabel} · ${effort}`;

  const current = parseAntigravityModel(options.currentModel);
  let action = 'model';
  if (target.delegate) {
    action = target.delegate === 'nivel-ligero' && current.family === family && current.effort === effort ? 'keep' : 'delegate';
  } else if (current.family && current.family === family) {
    action = current.effort === effort ? 'keep' : 'effort';
  }

  const proposal = target.delegate
    ? `delegar a ${target.delegate} (${label})`
    : model
      ? `${model} (${label})`
      : label;

  return {
    available: true,
    silent: false,
    recommendation: { level: target.level, family, model, effort, label },
    action,
    delegate: target.delegate,
    reason: target.reason,
    message: `NexaKit recomienda ${proposal}. Razón: ${target.reason}.`,
    source,
    automaticChange: false,
  };
}
