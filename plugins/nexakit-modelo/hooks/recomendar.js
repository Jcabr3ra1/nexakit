// Recomendación local por el texto del mensaje: sin llamar a ningún modelo ni gastar tokens.
// Sigue la guía de elegir-modelo: uso diario por defecto; ante un fallo sube el esfuerzo (verificar importa) y
// solo sube de modelo si ya se intentó y falló, es intermitente o es de seguridad; el más capaz para diseñar;
// lo mecánico se delega. Las reglas se ajustaron contrastándolas con mensajes reales de uso.

// Solo cuenta como confirmación un mensaje hecho únicamente de estas palabras, separadas entre sí:
// «ok, depura esto» y «sídale» no lo son.
const PALABRA = '(?:s[ií]|ok|okay|dale|listo|vale|perfecto|bien|contin[uú]a|sigue|hazlo|adelante|gracias|de una|claro|no)';
const CONFIRMACION = new RegExp(`^¡?${PALABRA}(?:[\\s.!,¡]+${PALABRA})*[\\s.!,]*$`, 'iu');
// «error» solo cuenta como fallo si no es parte de «mensajes de error» o similar. «por qué» solo no es un
// fallo: suele ser una pregunta de explicación, trabajo habitual.
const FALLO = /(\bbugs?\b|(?<!de )\berror|\bfall[aeo]|no funciona|no guarda|no carga|\broto\b|\brompe|\bdepura|\bdebug|\barr?e?gl|\bcorr[ií][gj])/iu;
// Señales de que más esfuerzo no basta: ya se intentó y sigue fallando, no se sabe la causa, falla a ratos, o
// un error escondido costaría caro (seguridad, concurrencia).
const DIFICIL = /(sigue (fallando|sin funcionar|igual|pasando)|todav[ií]a (falla|no (funciona|carga|guarda|sirve|aparece|sale|anda))|a[uú]n (falla|no funciona)|otra vez (falla|el mismo|lo mismo)|volvi[oó] a fallar|intermitente|a veces (falla|funciona)|\bsutil|seguridad|vulnerab|concurrencia|condici[oó]n de carrera|race condition)/iu;
// Diseñar es un verbo o un tema («arquitectura»); el sustantivo suelto («sigue con el diseño») no lo es.
// Investigar es sobre todo leer: va con el modelo por defecto, no con el más capaz.
// «no sé por qué» solo indica dificultad si acompaña a un síntoma; suelto puede ser cualquier duda.
const SIN_CAUSA = /no s[eé] por ?qu[eé]/iu;
const SINTOMA = /no (aparece|sale|funciona|carga|guarda|sirve|anda)/iu;
const DISENO = /(\b(?:re)?dise[ñn;][ae]|arquitectura|\bplanific|\brefactori|\bmigra)/iu;
const MECANICO = /(\bcommit|\bpush\b|\bmerge\b|\brenombra|\bmueve\b|\bformatea|\bejecuta|\bcorre\b|\binstala|\btypo\b|\btraduce|\bborra la rama|\babre el\b)/iu;
// Un verbo de construir o de seguir trabajando convierte el mensaje en trabajo habitual aunque además pida un commit.
const TRABAJO = /(\bimplement|\bañad|\bagreg|\bcrea\b|\bcrear\b|\bconstru|\bmodific|\bcambia\b|\bescrib|\bhaz que\b|\btermin|\bredise)/iu;
// «…y sigue con el paso 2»: el mensaje pide continuar el trabajo en curso, no empezar otro.
const CONTINUA = /(\bsigues? con\b|\by sigue|\bcontin[uú]a con\b|\by contin[uú]a)/iu;
const PREGUNTA = /\?/u;
// Una pregunta corta que no pide construir nada: respuesta rápida, sin pensar de más.
const PREGUNTA_SIMPLE = /^\s*¿|\?\s*$/u;
const MAX_PREGUNTA = 160;
const PETICION = /\b(puedes|podr[ií]as|me (ayudas|haces|creas|pones))\b/iu;
// Tras un fallo, «tampoco» o «no se arregló» es un segundo intento: ya no falta esfuerzo, falta modelo.
const REINTENTO = /(tampoco|de nuevo|no se arregl|no qued[oó]|no sirvi[oó]|lo mismo|igual que antes)/iu;
const SOLO_PREGUNTA = /\b(?:una|otra|tengo una|te hago una) pregunta\b/iu;
// Buscar o leer algo concreto (dónde se usa, qué archivos lo mencionan, abrir un archivo) es de nivel ligero.
// Pide un objeto concreto: «busca una forma de mejorar esto» es pensar, no buscar.
const BUSQUEDA = /(\b(?:busca|encuentra|localiza|lista)\b.{0,50}\b(?:d[oó]nde|usos?|usa(?:n|dos?)?|archivos?|referencias?|menciones?|ocurrencias?)\b|\bd[oó]nde (?:se usa|est[aá]|se define)\b|\b(?:lee|abre|muestra)\b.{0,30}\b(?:archivo|readme|log|carpeta|configuraci[oó]n)\b)/iu;
// Escribir pruebas o cubrir casos borde (nivel exigente): se verifica más, sin cambiar de modelo. Ejecutarlas
// es mecánico y un fallo o un diseño ya tienen su propia regla, que va antes.
const PRUEBAS = /\b(?:pruebas?|tests?|casos? (?:de )?borde|cobertura)\b/iu;
const ESCRIBIR_PRUEBAS = /\b(?:escrib|a[ñn]ad|agreg|crea|cubr|complet|ampl[ií])\w*/iu;

export function recomendarPorTexto(texto, previa = null) {
  const limpio = String(texto ?? '').trim();
  if (limpio === '' || (previa && CONFIRMACION.test(limpio))) return previa ?? porDefecto();
  // Quien anuncia una pregunta quiere una explicación, mencione o no un error; si es larga o trae otra
  // petición, merece el esfuerzo normal.
  // `delegar` nombra el subagente que hace el mismo trabajo sin cambiar el modelo de la sesión: cada modelo
  // tiene su caché y cambiarlo relee todo el historial sin ella; un subagente no toca la caché de la sesión.
  const esFallo = FALLO.test(limpio);
  if (DIFICIL.test(limpio) || (SIN_CAUSA.test(limpio) && (esFallo || SINTOMA.test(limpio))) || (previa?.fallo && REINTENTO.test(limpio))) return { model: 'opus', effort: 'high', reason: 'fallo difícil, reintento o seguridad: hace falta el más capaz', delegar: 'nivel-alto', fallo: true };
  // Subir el esfuerzo no rompe la caché; subir el modelo, sí.
  // Quien anuncia una pregunta quiere una explicación, mencione o no un error; si es larga o trae otra
  // petición, merece el esfuerzo normal.
  if (SOLO_PREGUNTA.test(limpio)) return limpio.length <= MAX_PREGUNTA && !MECANICO.test(limpio) ? pregunta() : porDefecto();
  if (esFallo) return { model: 'sonnet', effort: 'high', reason: 'fallo: verificar importa', fallo: true };
  // Seguir con lo que ya estaba en marcha conserva la recomendación de ese trabajo.
  if (CONTINUA.test(limpio)) return previa ?? porDefecto();
  if (DISENO.test(limpio)) return { model: 'opus', effort: 'medium', reason: 'diseño o ambigüedad' };
  if (PRUEBAS.test(limpio) && ESCRIBIR_PRUEBAS.test(limpio) && !PREGUNTA.test(limpio)) {
    return { model: 'sonnet', effort: 'high', reason: 'pruebas o casos borde: verificar importa' };
  }
  if ((MECANICO.test(limpio) || BUSQUEDA.test(limpio)) && !TRABAJO.test(limpio) && !PREGUNTA.test(limpio)) {
    return { model: 'haiku', effort: 'low', reason: 'tarea mecánica: mejor delegarla', delegar: 'nivel-ligero' };
  }
  if (PREGUNTA_SIMPLE.test(limpio) && limpio.length <= MAX_PREGUNTA && !TRABAJO.test(limpio) && !PETICION.test(limpio)) return pregunta();
  return porDefecto();
}

function pregunta() {
  return { model: 'sonnet', effort: 'low', reason: 'pregunta o explicación: respuesta rápida' };
}

function porDefecto() {
  return { model: 'sonnet', effort: 'medium', reason: 'trabajo habitual' };
}
