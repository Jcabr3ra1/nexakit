import { modelStatus } from './status.js';
async function redraw($, observed, recommendation) {
  const model = await $.session.model();
  $.ui.status(modelStatus(model, observed?.model === model ? observed.effort : null, recommendation));
}

export function register(on) {
  let recommendation = null;
  let observed = null;
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'nexakit_recomendacion',
      description: 'Registra una recomendación de modelo y esfuerzo para mostrarla, sin cambiar la sesión.',
      inputSchema: {
        type: 'object',
        properties: { model: { type: 'string' }, effort: { type: 'string' }, reason: { type: 'string' } },
        required: ['model', 'effort', 'reason'],
        additionalProperties: false,
      },
    });
    await redraw($, observed, recommendation);
    return next(e);
  });
  on('tool.call', { tool: 'mcp__nexakit-modelo__nexakit_recomendacion' }, async ($, e) => {
    recommendation = { model: e.model, effort: e.effort, reason: e.reason };
    await redraw($, observed, recommendation);
    return { result: 'Recomendación mostrada; no se cambió el modelo ni el esfuerzo.' };
  });
  on('turn.step', async function* ($, e, next) {
    if (!e.agentId) {
      observed = { model: e.model, effort: e.effort ?? null };
      await redraw($, observed, recommendation);
    }
    yield* next(e);
  });
  on('turn.complete', async ($, e, next) => {
    // Effort can change between turns; never present the previous request as current.
    observed = null;
    await redraw($, observed, recommendation);
    return next(e);
  });
  on('session.end', async ($, e, next) => {
    recommendation = null;
    observed = null;
    $.ui.status(undefined);
    return next(e);
  });
}
