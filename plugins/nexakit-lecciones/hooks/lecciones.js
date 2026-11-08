// Reglas puras de nexakit-lecciones: reconocer correcciones y comparar comandos y errores.

const CORRECCION = new RegExp([
  String.raw`^\s*no[,.!]?\s+(eso|era|es\s+as[ií]|as[ií]|hagas|uses|me\s+(pidas|preguntes|hables|digas|hagas))\b`,
  // «otra vez» solo cuenta como queja («otra vez lo mismo», «¿otra vez?»), no como petición («córrelo otra vez»).
  String.raw`\botra\s+vez\s+(lo\s+mismo|con\s+eso|el\s+mismo|igual)\b|¿\s*otra\s+vez\s*\?|^\s*otra\s+vez\s*[!?.]*\s*$`,
  String.raw`\bte\s+(dije|he\s+dicho|hab[ií]a\s+dicho|ped[ií])\b`,
  String.raw`\bya\s+te\s+(dije|hab[ií]a)\b`,
  String.raw`\bh[aá]blame\s+en\b`,
  String.raw`\bdeja\s+de\s+(?!lado\b)\p{L}+(r|rme|rte|rlo|rla)\b`,
  String.raw`\b(est[aá]|eso\s+est[aá])\s+mal\b`,
  String.raw`^\s*nunca\b|^\s*siempre\s+que\s+(hagas|vayas|termines|abras|crees|uses)\b`,
  String.raw`\bte\s+equivocaste\b`,
  String.raw`\bvolviste\s+a\b`,
  String.raw`\bno\s+vuelvas\s+a\b`,
  String.raw`\bcu[aá]ntas\s+veces\b`,
].join('|'), 'iu');

export const NOTA_CORRECCION = '[nexakit: este mensaje parece una corrección. Si de verdad corrige algo que hiciste, guarda la lección en tu memoria persistente (tipo feedback, con el porqué y cómo aplicarla) si no está ya, y aplícala desde ahora; si no lo es, ignora esta nota.]';

export function esCorreccion(texto) {
  return CORRECCION.test(String(texto ?? ''));
}

export function claveDeComando(comando) {
  return String(comando ?? '').replace(/(^|\s)NEXAKIT_REPETIR=1(?=\s)/gu, ' ').replace(/\s+/gu, ' ').trim();
}

// Primera línea con contenido, sin textos entre comillas, números ni rutas: lo que tienen en común dos errores
// del mismo tipo.
export function claveDeError(texto) {
  const linea = String(texto ?? '').split('\n').map((l) => l.trim()).find(Boolean);
  if (!linea) return null;
  return linea
    .replace(/'[^']*'|"[^"]*"|`[^`]*`/gu, '<…>')
    .replace(/(?:\/[^\s'"]+)+/gu, '<ruta>')
    .replace(/\d+/gu, '#')
    .slice(0, 160);
}
