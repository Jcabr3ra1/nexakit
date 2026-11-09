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

const contarLineas = (texto) => (texto === '' ? 0 : texto.split('\n').length);

// Registra solo cifras del recorte (nunca el contenido ni el comando) para poder medir el ahorro.
// El motor no ofrece añadir al final: se lee el registro y se reescribe con la línea nueva.
async function registrar($, antes, despues) {
  try {
    const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'));
    if (!home) return;
    const ruta = `${home}/.nexakit/ahorro.jsonl`;
    let previo = '';
    try {
      if (await $.fs.exists(ruta)) previo = await $.fs.read(ruta);
    } catch {
      previo = '';
    }
    if (previo && !previo.endsWith('\n')) previo += '\n';
    const linea = JSON.stringify({
      fecha: await $.clock.now(),
      antes: antes.length,
      despues: despues.length,
      lineasAntes: contarLineas(antes),
      lineasDespues: contarLineas(despues),
    });
    await $.fs.write(ruta, `${previo}${linea}\n`);
  } catch {
    // Un fallo al registrar nunca debe romper el recorte.
  }
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
    await registrar($, unida, texto);
    // Sin `ref` ni `text`, el motor vuelve a presentar al modelo el resultado recortado.
    return { result: { ...salida, stdout: texto, stderr: '' }, ...(r.context ? { context: r.context } : {}), ...(r.isError ? { isError: r.isError } : {}) };
  });
}
