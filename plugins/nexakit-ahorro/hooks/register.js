import { compactarSalida } from './compactar.js';

const COMPLETA = /(^|\s)NEXAKIT_SALIDA=completa(\s|$)/u;

// Guarda la salida entera fuera del contexto para poder consultarla con grep o tail si hace falta.
async function guardar($, texto) {
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'));
  if (!home) return null;
  const ruta = `${home}/.nexakit/salidas/${await $.clock.now()}-${Math.random().toString(36).slice(2, 8)}.log`;
  await $.fs.write(ruta, texto);
  return ruta;
}

export function register(on) {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const r = await next(e);
    const salida = r?.result;
    if (!salida || typeof salida.stdout !== 'string' || salida.isImage || salida.backgroundTaskId) return r;
    if (COMPLETA.test(e.command ?? '')) return r;
    const unida = salida.stderr ? `${salida.stdout}\n${salida.stderr}` : salida.stdout;
    if (compactarSalida(unida).omitidas === 0) return r;
    let ruta = null;
    try {
      ruta = await guardar($, unida);
    } catch {
      // Sin copia en disco igual se recorta; el aviso explica cómo pedirla completa.
    }
    const { texto } = compactarSalida(unida, { ruta });
    // Sin `ref` ni `text`, el motor vuelve a presentar al modelo el resultado recortado.
    return { result: { ...salida, stdout: texto, stderr: '' }, ...(r.context ? { context: r.context } : {}), ...(r.isError ? { isError: r.isError } : {}) };
  });
}
