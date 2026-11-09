import { familia, filasDeAgentes, segmentosDeBarra } from './barra.js';
import { recomendarPorTexto } from './recomendar.js';

async function refrescar($, estado, { usage = false } = {}) {
  try {
    estado.model = await $.session.model();
    // El esfuerzo se observó en un modelo concreto: si cambió de modelo, ya no se sabe.
    if (familia(estado.model) !== familia(estado.modeloDelEsfuerzo)) estado.effort = null;
    if (usage) estado.usage = await $.session.usage();
  } catch {
    // Medir nunca debe romper el turno.
  }
  $.ui.invalidate('ui.render');
}

// Completa los subagentes vistos con lo que dice el motor: tipo, encargo y estado.
async function sincronizarAgentes($, agentes) {
  try {
    for (const info of await $.agent.list()) {
      const visto = agentes.get(info.id);
      if (visto) Object.assign(visto, { type: info.type, description: info.description, status: info.status });
    }
  } catch {
    // Sin lista, se conserva lo último conocido.
  }
  $.ui.invalidate('ui.render');
}

const mismaRecomendacion = (a, b) =>
  a?.model === b?.model && a?.effort === b?.effort && a?.delegar === b?.delegar;

const cacheVacia = () => ({ read: 0, creation: 0, input: 0, turnos: 0 });
const tokens = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

function sumarCache(estado, usage) {
  if (!usage) return;
  const c = estado.cache;
  c.read += tokens(usage.cache_read_input_tokens);
  c.creation += tokens(usage.cache_creation_input_tokens);
  c.input += tokens(usage.input_tokens);
  c.turnos += 1;
}

// Una sola barra sobre el prompt con modelo, esfuerzo, recomendación y uso. Solo muestra:
// nunca cambia el modelo ni el esfuerzo de la sesión.
export function register(on) {
  const estado = { model: null, effort: null, modeloDelEsfuerzo: null, recommendation: null, enviada: null, usage: null, cache: cacheVacia() };
  // Subagentes de esta petición, por id, con el modelo y el esfuerzo que de verdad usaron.
  const agentes = new Map();

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
    await refrescar($, estado, { usage: true });
    return next(e);
  });

  on('tool.call', { tool: 'mcp__nexakit-modelo__nexakit_recomendacion' }, async ($, e) => {
    estado.recommendation = { model: e.model, effort: e.effort, reason: e.reason };
    estado.enviada = estado.recommendation;
    await refrescar($, estado);
    return { result: 'Recomendación mostrada; no se cambió el modelo ni el esfuerzo.' };
  });

  // Mientras se escribe: la recomendación aparece antes de pulsar Enter, cuando todavía se puede cambiar
  // de modelo o delegar. Parte de la del último mensaje enviado, para que «ok, dale» la conserve.
  on('prompt.edit', async ($, e, next) => {
    const r = await next(e);
    try {
      const nueva = recomendarPorTexto(r?.text ?? '', estado.enviada);
      if (!mismaRecomendacion(nueva, estado.recommendation)) {
        estado.recommendation = nueva;
        $.ui.invalidate('ui.render');
      }
    } catch {
      // Recomendar nunca debe estorbar la escritura.
    }
    return r;
  });

  on('prompt.submit', async ($, e, next) => {
    estado.recommendation = recomendarPorTexto(e.text, estado.enviada);
    estado.enviada = estado.recommendation;
    for (const [id, a] of agentes) if (['completed', 'idle', 'failed', 'killed'].includes(a.status)) agentes.delete(id);
    $.ui.invalidate('ui.render');
    return next(e);
  });

  on('turn.step', async function* ($, e, next) {
    if (!e.agentId) {
      // El último esfuerzo visto se conserva entre turnos; el siguiente paso lo corrige si cambió.
      estado.model = e.model;
      estado.effort = e.effort ?? null;
      estado.modeloDelEsfuerzo = e.model;
      $.ui.invalidate('ui.render');
    } else {
      const nuevo = !agentes.has(e.agentId);
      const a = agentes.get(e.agentId) ?? { status: 'running' };
      agentes.set(e.agentId, Object.assign(a, { model: e.model, effort: e.effort ?? null }));
      if (nuevo) await sincronizarAgentes($, agentes);
    }
    yield* next(e);
  });

  on('turn.complete', async ($, e, next) => {
    const r = await next(e);
    if (!e.agentId) {
      // Solo la sesión principal: cada subagente tiene su propia caché y no toca la de la sesión.
      sumarCache(estado, r?.usage);
      await refrescar($, estado, { usage: true });
      if (agentes.size > 0) await sincronizarAgentes($, agentes);
    }
    return r;
  });

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props?.hasSurvey || !estado.model) return next(e);
    const { Box, Text } = $.ui.resolve(e);
    const tramos = segmentosDeBarra(estado).map((s, i) =>
      h(Text, { key: String(i), color: s.color, dimColor: s.dim, bold: s.bold }, s.text));
    const linea = (partes, clave) => h(Box, { key: clave, flexDirection: 'row' },
      ...partes.map((s, i) => h(Text, { key: String(i), color: s.color, dimColor: s.dim, bold: s.bold }, s.text)));
    const filas = filasDeAgentes([...agentes.values()]).map((f, i) => linea(f, `agente-${i}`));
    return h(Box, { flexDirection: 'column' }, h(Box, { key: 'principal', flexDirection: 'row' }, ...tramos), ...filas);
  });

  on('session.end', async ($, e, next) => {
    agentes.clear();
    Object.assign(estado, { model: null, effort: null, modeloDelEsfuerzo: null, recommendation: null, enviada: null, usage: null, cache: cacheVacia() });
    return next(e);
  });
}
