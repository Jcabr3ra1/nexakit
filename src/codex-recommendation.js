import { inspectModels } from './model-command.js';
import { recomendarPorTexto } from '../plugins/nexakit-modelo/hooks/recomendar.js';

const ROLES = { haiku: 'ligero', sonnet: 'uso diario', opus: 'el más capaz' };
const CONFIRMATION = /^(?:¡?)(?:s[ií]|ok|okay|dale|listo|vale|perfecto|bien|contin[uú]a|sigue|hazlo|adelante|gracias|de una|claro|no)(?:[\s.!,¡]+(?:s[ií]|ok|okay|dale|listo|vale|perfecto|bien|contin[uú]a|sigue|hazlo|adelante|gracias|de una|claro|no))*[\s.!,]*$/iu;
const validModel = (value) => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/u.test(value)
  && !/(?:claude|haiku|sonnet|opus)/iu.test(value);
const validEffort = (value) => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,23}$/u.test(value);

function emptyResult(reason, silent = false) {
  return {
    available: false, silent, recommendation: null, stored: null,
    action: silent ? 'keep' : 'unavailable', delegate: null, command: null, reason,
    message: silent ? '' : `NexaKit recomienda consultar /model: ${reason}.`,
    source: 'local-catalog', automaticChange: false,
  };
}

// Reads local catalog/config only. A saved preference never establishes the active session state.
export async function recommendCodexTask(text, options = {}) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 16 * 1024) {
    return emptyResult('texto no válido o superior al límite de 16 KiB');
  }
  const task = text.trim();
  if (!task || CONFIRMATION.test(task)) return emptyResult('', true);

  const classification = recomendarPorTexto(task);
  const role = ROLES[classification.model];
  let data;
  try {
    data = await inspectModels({ ...options, includeAntigravity: false });
  } catch {
    return emptyResult('catálogo local no disponible o inválido');
  }
  const saved = data.stored.codex;
  const stored = saved && validModel(saved.model) && (saved.effort == null || validEffort(saved.effort))
    ? { model: saved.model, effort: saved.effort ?? null } : null;
  const candidates = data.catalogs.codex
    .filter((item) => item.category === role && validModel(item.model))
    .sort((a, b) => a.priority - b.priority);
  // Routine and design use the model's actual default, not the classifier's effort.
  const useDefault = classification.effort === 'medium';
  let chosen, effort, fallback = '';
  for (const candidate of candidates) {
    const supports = (value) => validEffort(value) && candidate.efforts.includes(value);
    const preferred = useDefault ? candidate.defaultEffort : classification.effort;
    if (supports(preferred)) {
      chosen = candidate;
      effort = preferred;
      break;
    }
    if (supports(candidate.defaultEffort)) {
      chosen = candidate;
      effort = candidate.defaultEffort;
      fallback = `; ${classification.effort} no disponible: defecto soportado`;
      break;
    }
    // Design can still use medium when that effort is explicitly offered.
    if (useDefault && role === 'el más capaz' && supports('medium')) {
      chosen = candidate;
      effort = 'medium';
      fallback = '; defecto no disponible: medium soportado';
      break;
    }
  }
  if (!chosen) {
    return { ...emptyResult('sin modelo y esfuerzo soportados para esta tarea en el catálogo local'), stored };
  }

  const delegate = classification.delegar === 'nivel-ligero' ? 'nivel_ligero'
    : classification.delegar === 'nivel-alto' ? 'nivel_alto' : null;
  let reason = delegate === 'nivel_ligero' ? 'tarea mecánica'
    : delegate === 'nivel_alto' ? 'fallo difícil o seguridad'
    : role === 'el más capaz' ? 'diseño o ambigüedad'
    : classification.effort === 'high' ? 'fallo o pruebas: verificar importa'
    : classification.effort === 'low' ? 'pregunta breve'
    : 'trabajo habitual: esfuerzo por defecto del catálogo';
  reason += fallback;
  const recommendation = { model: chosen.model, effort };
  const command = `/model ${chosen.model} --reasoning=${effort}`;
  const action = delegate ? 'delegate' : stored?.model !== chosen.model ? 'model'
    : stored.effort !== effort ? 'effort' : 'keep';
  const savedLabel = stored ? ` Guardado: ${stored.model} / ${stored.effort ?? 'sin esfuerzo'}.` : ' Guardado: no comprobable.';
  const proposal = delegate
    ? `delegar a ${delegate}; conserva el principal. Alternativa: ${command}`
    : command;
  return {
    available: true, silent: false, recommendation, stored, action, delegate, command, reason,
    message: `NexaKit recomienda ${proposal}. Razón: ${reason}.${savedLabel}`,
    source: 'local-catalog', automaticChange: false,
  };
}
