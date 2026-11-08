import { avisoDeContexto, mensajeDeAviso } from './aviso.js';

export function register(on) {
  // Último nivel avisado: solo se vuelve a avisar al subir de nivel o tras bajar y volver a subir.
  let ultimoAviso = 0;

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

  on('session.end', async ($, e, next) => {
    ultimoAviso = 0;
    // Limpia la línea de estado que dejaban versiones anteriores; el uso se ve ahora en la barra de nexakit-modelo.
    $.ui.status(undefined);
    return next(e);
  });
}
