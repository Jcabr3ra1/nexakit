import { avisoDeContexto, CONSERVAR_AL_COMPACTAR, mensajeDeAviso, nivelDeCuota, notaDeCuota } from './aviso.js';

export function register(on) {
  // Último nivel avisado: solo se vuelve a avisar al subir de nivel o tras bajar y volver a subir.
  let ultimoAviso = 0;
  let ultimaCuota = 0;

  on('turn.complete', async ($, e, next) => {
    try {
      if (!e.agentId) {
        const usage = await $.session.usage();
        const percent = usage?.context?.percent;
        const nivel = avisoDeContexto(percent);
        if (nivel > ultimoAviso) $.ui.toast(mensajeDeAviso(nivel, percent), { timeoutMs: 10000 });
        ultimoAviso = nivel;
      }
    } catch {
      // Medir nunca debe romper el turno.
    }
    return next(e);
  });

  // Con la cuota de 5 h alta, el modelo lo sabe una vez por nivel para no lanzar subagentes en paralelo.
  on('prompt.submit', async ($, e, next) => {
    try {
      const usage = await $.session.usage();
      const nivel = nivelDeCuota(usage);
      const anterior = ultimaCuota;
      ultimaCuota = nivel;
      if (nivel > anterior) {
        const cinco = usage.rateLimits.find((l) => l.kind === 'five_hour').percentUsed;
        return next({ ...e, text: `${e.text}\n\n${notaDeCuota(nivel, cinco)}` });
      }
    } catch {
      // Sin datos de uso, el mensaje pasa tal cual.
    }
    return next(e);
  });

  // Antes de compactar la conversación principal, el resumen sabe qué no puede perder.
  on('session.compact', async ($, e, next) => {
    if (e.agentId || (e.trigger !== 'auto' && e.trigger !== 'manual')) return next(e);
    const instructions = e.instructions ? `${e.instructions}\n\n${CONSERVAR_AL_COMPACTAR}` : CONSERVAR_AL_COMPACTAR;
    const r = await next({ ...e, instructions });
    if (r?.messages) $.ui.toast('Contexto compactado. Si la tarea es larga, pide actualizar el traspaso con project-handoff.', { timeoutMs: 10000 });
    return r;
  });

  on('session.end', async ($, e, next) => {
    ultimoAviso = 0;
    ultimaCuota = 0;
    // Limpia la línea de estado que dejaban versiones anteriores; el uso se ve ahora en la barra de nexakit-modelo.
    $.ui.status(undefined);
    return next(e);
  });
}
