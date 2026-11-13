import { recordCodexUsage } from './codex-usage.js';

const SESSION_GUIDANCE = 'Configura y ordena la barra nativa con /statusline; una terminal estrecha puede truncarla. Los avisos de recomendación local de NexaKit aparecen al enviar tareas, separados del pie y sin cambios automáticos: usa /model para elegir y /status para consultar la sesión. Consulta los hilos del equipo con /subagents. Los perfiles instalados se cargan al abrir sesión; usa solo los registrados en tus herramientas. El principal orquesta, decide e integra; resuelve tareas pequeñas directamente y delega las de más de 1–2 pasos con un encargo acotado y verifica el informe; no cambies modelo ni esfuerzo sin autorización. Para salidas voluminosas usa explícitamente nexakit codex ejecutar -- programa argumentos. Mantén breves las salidas y reutiliza el contexto ya disponible.';
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
      case 'PreToolUse': {
        const { rewriteCodexToolInput } = await import('./codex-pre-tool.js');
        return rewriteCodexToolInput(payload, options);
      }
      case 'SubagentStart':
      case 'SubagentStop': {
        const { recordCodexAgentEvent } = await import('./codex-events.js');
        await recordCodexAgentEvent(payload, options);
        return {};
      }
      case 'PostToolUse': {
        const { compactCodexToolOutput } = await import('./codex-auto-output.js');
        return await compactCodexToolOutput(payload, options);
      }
      case 'PostModelRequest':
        await recordCodexUsage(payload, options);
        return {};
      case 'SessionStart': {
        let context = SESSION_GUIDANCE;
        try {
          const { installedTeam } = await import('./codex-team.js');
          const names = await installedTeam(options);
          if (names.length) context += ` Equipo instalado: ${names.join(', ')}.`;
        } catch { /* Optional inspection must not suppress session guidance. */ }
        return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } };
      }
      case 'PreCompact':
      case 'PostCompact':
        return { systemMessage: COMPACT_GUIDANCE };
      // No official context occupancy counter is available in this contract.
      // Accumulated request tokens cannot measure the current context window.
      case 'UserPromptSubmit': {
        const { recommendCodexTask } = await import('./codex-recommendation.js');
        const result = await recommendCodexTask(payload.prompt ?? '', { ...options, includeAntigravity: false });
        if (result.silent) return {};
        const response = { systemMessage: result.message };
        try {
          const { installedTeam } = await import('./codex-team.js');
          const { routeCodexTask } = await import('./codex-routing.js');
          const { context } = routeCodexTask(payload.prompt, { installedNames: await installedTeam(options) });
          if (context) response.hookSpecificOutput = { hookEventName: 'UserPromptSubmit', additionalContext: context };
        } catch {
          try { process.stderr.write('NexaKit: no se pudo orientar el equipo Codex.\n'); } catch { /* fail open */ }
        }
        return response;
      }
      default:
        return {};
    }
  } catch {
    try { process.stderr.write('NexaKit: no se pudo procesar el evento Codex.\n'); } catch { /* fail open */ }
    return {};
  }
}
