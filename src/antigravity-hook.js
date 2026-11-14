import {
  avisoPendientes,
  esCorreccion,
  NOTA_CORRECCION,
  pendientes,
  textoSeguro,
} from '../plugins/nexakit-lecciones/hooks/lecciones.js';
import {
  avisoDeContexto,
  CUOTA_CRITICA,
  CUOTA_SERIE,
  mensajeDeAviso,
  notaDeCuota,
} from '../plugins/nexakit-sesion/hooks/aviso.js';
import { recommendAntigravityTask } from './antigravity-recommendation.js';
import { mutateAntigravitySessionState } from './antigravity-session.js';

const SESSION_GUIDANCE =
  'Usa /statusline para ver o configurar la barra de estado y /model para cambiar modelo o esfuerzo. ' +
  'Las recomendaciones locales de NexaKit son orientativas y nunca cambian el modelo automáticamente. ' +
  'Para delegar tareas de más de 1–2 pasos usa subagentes (nivel-ligero, nivel-normal, nivel-exigente, nivel-alto o especialistas) sin autorizar cambios ni memoria por tu cuenta.';

const quotaLevelOf = (percent) =>
  typeof percent !== 'number' || !Number.isFinite(percent)
    ? 0
    : percent >= CUOTA_CRITICA
      ? 2
      : percent >= CUOTA_SERIE
        ? 1
        : 0;

/** Handle Antigravity lifecycle hooks (`SessionStart`, `PreInvocation`, `PreToolUse`, `PostToolUse`). */
export async function runAntigravityHook(payload, options = {}) {
  try {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof payload.hookEventName !== 'string') {
      return {};
    }

    if (payload.hookEventName === 'PreToolUse') {
      const { handleAntigravityPreToolUse } = await import('./antigravity-pre-tool.js');
      return await handleAntigravityPreToolUse(payload, options);
    }

    if (payload.hookEventName === 'PostToolUse') {
      const { handleAntigravityPostToolUse } = await import('./antigravity-pre-tool.js');
      return await handleAntigravityPostToolUse(payload, options);
    }

    if (payload.hookEventName === 'SessionStart') {
      let message = SESSION_GUIDANCE;
      const { appendAntigravityLesson, readAntigravityLessons } = await import('./antigravity-pre-tool.js');
      const unreminded = pendientes(await readAntigravityLessons(options));
      if (unreminded.length > 0) {
        message += `\n${avisoPendientes(unreminded)}`;
        await appendAntigravityLesson({ tipo: 'avisada' }, options);
      }
      if (typeof payload.conversationId === 'string') {
        await mutateAntigravitySessionState(payload.conversationId, (state) => {
          state.lecciones.avisoHecho = true;
          return state;
        }, options);
      }
      return {
        injectSteps: [{ systemMessage: { systemMessage: message } }],
      };
    }

    if (payload.hookEventName === 'PreInvocation') {
      const userInput = typeof payload.lastUserInput === 'string' ? payload.lastUserInput : '';
      const currentModel = typeof payload.modelName === 'string' && payload.modelName.toLowerCase() !== 'auto'
        ? payload.modelName
        : null;
      const result = await recommendAntigravityTask(userInput, {
        currentModel,
        catalog: options.catalog,
      });

      const systemNotes = [];
      let needsPendingCheck = false;
      const correction = esCorreccion(userInput);

      if (typeof payload.conversationId === 'string') {
        const updatedState = await mutateAntigravitySessionState(payload.conversationId, (state) => {
          if (result.available && !result.silent && result.recommendation) {
            state.recommendation = {
              ...result.recommendation,
              delegate: result.delegate,
              reason: result.reason,
            };
          }
          if (!state.lecciones.avisoHecho) {
            needsPendingCheck = true;
            state.lecciones.avisoHecho = true;
          }
          if (state.lecciones.pendingRepetitionNotice) {
            systemNotes.push(state.lecciones.pendingRepetitionNotice);
            state.lecciones.pendingRepetitionNotice = null;
          }
          const ctxLevel = avisoDeContexto(state.usage.contextPercent);
          if (ctxLevel > state.usage.warnedContextLevel) {
            state.usage.warnedContextLevel = ctxLevel;
            const warn = mensajeDeAviso(ctxLevel, state.usage.contextPercent);
            if (warn) systemNotes.push(`[nexakit: ${warn}]`);
          }
          const quotaLevel = quotaLevelOf(state.usage.quotaPercent);
          if (quotaLevel > state.usage.warnedQuotaLevel) {
            state.usage.warnedQuotaLevel = quotaLevel;
            const warn = notaDeCuota(quotaLevel, state.usage.quotaPercent);
            if (warn) systemNotes.push(warn);
          }
          return state;
        }, options);

        if (needsPendingCheck || correction) {
          const { appendAntigravityLesson, readAntigravityLessons } = await import('./antigravity-pre-tool.js');
          if (needsPendingCheck) {
            const unreminded = pendientes(await readAntigravityLessons(options));
            if (unreminded.length > 0) {
              systemNotes.push(avisoPendientes(unreminded));
              await appendAntigravityLesson({ tipo: 'avisada' }, options);
            }
          }
          if (correction) {
            await appendAntigravityLesson({ tipo: 'correccion', texto: textoSeguro(userInput) }, options);
            systemNotes.push(NOTA_CORRECCION);
          }
        }
        void updatedState;
      } else if (correction) {
        systemNotes.push(NOTA_CORRECCION);
      }

      const injectSteps = [];
      if (result.available && !result.silent && result.recommendation && result.action !== 'keep') {
        const notice = result.delegate
          ? `NexaKit: → delega a ${result.delegate} (${result.recommendation.label}) · ${result.reason}`
          : `NexaKit: → ${result.recommendation.label} · ${result.reason} (usa /model)`;
        injectSteps.push({
          systemMessage: {
            systemMessage: '',
            metadata: { user_markdown: notice },
          },
        });
      }
      if (systemNotes.length > 0) {
        injectSteps.push({
          systemMessage: {
            systemMessage: systemNotes.join('\n'),
          },
        });
      }
      return injectSteps.length > 0 ? { injectSteps } : {};
    }

    return {};
  } catch {
    return {};
  }
}
