import { recordCodexUsage } from './codex-usage.js';

const SESSION_GUIDANCE = 'Configura y ordena la barra nativa con /statusline; una terminal estrecha puede truncarla. Los avisos de recomendación local de NexaKit aparecen al enviar tareas, separados del pie y sin cambios automáticos: usa /model para elegir y /status para consultar la sesión. Delega tareas independientes con un encargo acotado y verifica sus resultados; no cambies modelo ni esfuerzo sin autorización. Para salidas voluminosas usa explícitamente nexakit codex ejecutar -- programa argumentos. Mantén breves las salidas y reutiliza el contexto ya disponible.';
const COMPACT_GUIDANCE = 'Retoma el trabajo ya autorizado; conserva rama, objetivo, restricciones, decisiones confirmadas, archivos modificados, pruebas y siguiente paso. No inicies tareas nuevas ni escribas memoria del proyecto sin autorización.';

/** Returns the JSON object the caller serializes to stdout. Never logs payloads
 * or provider errors. Guidance uses the hooks systemMessage/additionalContext
 * envelopes; client/version support must be verified when installing hooks.
 */
export async function runCodexHook(payload, options = {}) {
  try {
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload) || typeof payload.hook_event_name !== 'string') {
      throw new TypeError('Evento inválido.');
    }
    switch (payload.hook_event_name) {
      case 'PostModelRequest':
        await recordCodexUsage(payload, options);
        return {};
      case 'SessionStart':
        return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: SESSION_GUIDANCE } };
      case 'PreCompact':
      case 'PostCompact':
        return { systemMessage: COMPACT_GUIDANCE };
      // No official context occupancy counter is available in this contract.
      // Accumulated request tokens cannot measure the current context window.
      case 'UserPromptSubmit': {
        const { recommendCodexTask } = await import('./codex-recommendation.js');
        const result = await recommendCodexTask(payload.prompt ?? '', { ...options, includeAntigravity: false });
        return result.silent ? {} : { systemMessage: result.message };
      }
      default:
        return {};
    }
  } catch {
    try { process.stderr.write('NexaKit: no se pudo procesar el evento Codex.\n'); } catch { /* fail open */ }
    return {};
  }
}
