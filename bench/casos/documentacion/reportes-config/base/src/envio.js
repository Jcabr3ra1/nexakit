import { gzipSync } from 'node:zlib';

export async function enviarReporte(servidor, contenido, config) {
  const cuerpo = config.comprimir ? gzipSync(contenido) : contenido;
  const cabeceras = { 'content-type': 'application/json', ...(config.comprimir ? { 'content-encoding': 'gzip' } : {}) };
  let ultimoError;
  for (let intento = 1; intento <= config.reintentos; intento += 1) {
    try {
      const respuesta = await fetch(new URL('/reportes', servidor), {
        method: 'POST',
        headers: cabeceras,
        body: cuerpo,
        signal: AbortSignal.timeout(config.tiempoEsperaMs),
      });
      if (respuesta.ok) return;
      ultimoError = new Error(`El servidor respondió ${respuesta.status}`);
      if (respuesta.status < 500) break;
    } catch (error) {
      ultimoError = error;
    }
  }
  throw ultimoError ?? new Error('No se hizo ningún intento de envío');
}
