// Recomendación local por el texto del mensaje: sin llamar a ningún modelo ni gastar tokens.
// Sigue la guía de elegir-modelo: ligero solo para lo mecánico, uso diario por defecto, el más capaz
// para diseño y fallos; high solo cuando verificar importa.

// Solo cuenta como confirmación un mensaje hecho únicamente de estas palabras, separadas entre sí:
// «ok, depura esto» y «sídale» no lo son.
const PALABRA = '(?:s[ií]|ok|okay|dale|listo|vale|perfecto|bien|contin[uú]a|sigue|hazlo|adelante|gracias|de una|claro|no)';
const CONFIRMACION = new RegExp(`^¡?${PALABRA}(?:[\\s.!,¡]+${PALABRA})*[\\s.!,]*$`, 'iu');
// «error» solo cuenta como fallo si no es parte de «mensajes de error» o similar.
const FALLO = /(\bbugs?\b|(?<!de )\berror|\bfall[aeo]|no funciona|no guarda|no carga|\broto\b|\brompe|por qu[eé]|\bdepura|\bdebug|\barregl|\bcorrig|seguridad|vulnerab)/iu;
const DISENO = /(\bdise[ñn]|arquitectura|\bplanific|\brefactori|\bmigra|investiga)/iu;
const MECANICO = /(\bcommit|\bpush\b|\bmerge\b|\brenombra|\bmueve\b|\bformatea|\bejecuta|\bcorre\b|\binstala|\btypo\b|\btraduce|\bborra la rama|\babre el\b)/iu;
// Un verbo de construir convierte el mensaje en trabajo habitual aunque además pida un commit.
const TRABAJO = /(\bimplement|\bañad|\bagreg|\bcrea\b|\bcrear\b|\bconstru|\bmodific|\bcambia\b|\bescrib|\bhaz que\b)/iu;

export function recomendarPorTexto(texto, previa = null) {
  const limpio = String(texto ?? '').trim();
  if (limpio === '' || (previa && CONFIRMACION.test(limpio))) return previa ?? porDefecto();
  if (FALLO.test(limpio)) return { model: 'opus', effort: 'high', reason: 'fallo o seguridad: verificar importa' };
  if (DISENO.test(limpio)) return { model: 'opus', effort: 'medium', reason: 'diseño o ambigüedad' };
  if (MECANICO.test(limpio) && !TRABAJO.test(limpio)) return { model: 'haiku', effort: 'low', reason: 'tarea mecánica' };
  return porDefecto();
}

function porDefecto() {
  return { model: 'sonnet', effort: 'medium', reason: 'trabajo habitual' };
}
