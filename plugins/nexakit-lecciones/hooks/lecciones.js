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

// --- Registro propio (~/.nexakit/lecciones.jsonl): una línea JSON por evento, en orden cronológico. ---
// correccion: el usuario corrigió a Claude (con su texto). guardada: Claude escribió en su memoria persistente.
// avisada: se recordaron al empezar una sesión las correcciones sin guardar. freno / repeticion: ver register.js.

const TIPOS = new Set(['correccion', 'guardada', 'avisada', 'freno', 'repeticion']);
const DIA_MS = 24 * 60 * 60 * 1000;
export const DIAS_DE_REGISTRO = 90;
export const MAX_EVENTOS = 500;
const MAX_TEXTO = 200;

export function leerEventos(texto) {
  const eventos = [];
  for (const linea of String(texto ?? '').split('\n')) {
    if (!linea.trim()) continue;
    try {
      const e = JSON.parse(linea);
      if (Number.isFinite(e?.fecha) && TIPOS.has(e?.tipo)) eventos.push(e);
    } catch {
      // Las líneas ilegibles se descartan.
    }
  }
  return eventos;
}

// El registro no crece sin límite: solo los últimos 90 días y como máximo 500 eventos.
export function podarEventos(eventos, ahora) {
  return eventos.filter((e) => e.fecha >= ahora - DIAS_DE_REGISTRO * DIA_MS).slice(-MAX_EVENTOS);
}

const despuesDe = (eventos, tipos) => {
  let ultimo = -1;
  eventos.forEach((e, i) => { if (tipos.includes(e.tipo)) ultimo = i; });
  return eventos.slice(ultimo + 1).filter((e) => e.tipo === 'correccion');
};

// Correcciones que ninguna lección guardada ha resuelto. Se cuenta por orden en el registro, no por hora:
// dos eventos pueden caer en el mismo milisegundo.
export const sinGuardar = (eventos) => despuesDe(eventos, ['guardada']);

// Las que además no se han recordado ya: lo que toca avisar al empezar una sesión.
export const pendientes = (eventos) => despuesDe(eventos, ['guardada', 'avisada']);

const SENSIBLE = new RegExp([
  String.raw`\b(?:sk-[\w-]{10,}|gh[pousr]_\w{20,}|AKIA[0-9A-Z]{12,}|xox[abprs]-[\w-]{10,})`,
  String.raw`-----BEGIN [A-Z ]*PRIVATE KEY`,
  String.raw`\b(?:password|passwd|contraseña|token|secret|api[_-]?key|clave)\s*[=:]\s*\S{6,}`,
].join('|'), 'iu');

// Lo que se guarda de lo que escribió la persona: una frase corta, y nada si parece llevar un secreto.
export function textoSeguro(texto) {
  const limpio = String(texto ?? '').replace(/\s+/gu, ' ').trim();
  if (SENSIBLE.test(limpio)) return '(texto omitido: parecía contener un dato sensible)';
  return limpio.slice(0, MAX_TEXTO);
}

// Memoria persistente de Claude Code: ~/.claude/projects/<proyecto>/memory/<nota>.md
export function esRutaDeMemoria(ruta) {
  return /\/\.claude\/projects\/[^/]+\/memory\/[^/]+\.md$/u.test(String(ruta ?? '').replaceAll('\\', '/'));
}

export function avisoPendientes(correcciones) {
  const ultimas = correcciones.slice(-3).map((c) => `«${c.texto ?? '(sin texto)'}»`).join(', ');
  const n = correcciones.length;
  const cuantas = n === 1 ? '1 corrección tuya' : `${n} correcciones tuyas`;
  return `[nexakit: quedaron ${cuantas} sin guardar de sesiones anteriores: ${ultimas}. Si siguen valiendo, guárdalas en tu memoria persistente (tipo feedback, con el porqué y cómo aplicarlas) y aplícalas desde ahora.]`;
}
