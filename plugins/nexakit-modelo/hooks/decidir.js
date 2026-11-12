// Decide qué proponer cruzando la recomendación del mensaje con el estado de la sesión. Datos puros, sin
// llamar a ningún modelo. El criterio es el coste real de cada salida:
// - cambiar el esfuerzo no rompe la caché (Claude 5.x): siempre es barato;
// - cambiar de modelo relee todo el contexto sin caché: solo es barato con poco contexto o con la caché ya fría;
// - un subagente tiene su propia caché: delegar no toca la de la sesión;
// - seguir muchos turnos de rutina en un modelo caro cuesta en cada turno: conviene una sesión nueva.
import { familia, nombreModelo } from './barra.js';

export const CONTEXTO_BARATO = 30;
export const LIMITE_ALTO = 80;
export const RUTINA_PARA_SESION = 5;

const RANGO = { haiku: 0, sonnet: 1, opus: 2, fable: 3 };
const rango = (model) => RANGO[familia(model)] ?? -1;
const esNumero = (v) => typeof v === 'number' && Number.isFinite(v);

// Cerca del límite de uso no se propone el modelo más caro para diseñar: Sonnet con más esfuerzo. Un fallo
// difícil o de seguridad se mantiene: ahí el modelo es lo que falta.
export function ajustarPorLimite(recommendation, limite) {
  if (!recommendation || !esNumero(limite) || limite < LIMITE_ALTO) return recommendation;
  if (rango(recommendation.model) < RANGO.opus || recommendation.delegar) return recommendation;
  return { model: 'sonnet', effort: 'high', reason: `límite de uso al ${Math.round(limite)} %: Sonnet con más esfuerzo` };
}

const etiqueta = (r) => `${nombreModelo(r.model)} · ${r.effort}`;

// Una recomendación rebajada por el límite de uso lo dice en la barra: nunca se baja de modelo sin explicarlo.
export function decidir(entrada) {
  const { recommendation, limite } = entrada;
  const r = ajustarPorLimite(recommendation, limite);
  if (!r) return null;
  const decision = decidirCon(r, entrada);
  if (r === recommendation || decision.accion === 'mantener') return decision;
  return { ...decision, texto: `${decision.texto} (límite ${Math.round(limite)} %)` };
}

function decidirCon(r, { model, effort, ctx, tokens, cacheFria = false, rutinaSeguidas = 0 }) {
  const mismaFamilia = familia(model) === familia(r.model);
  if (r.delegar === 'nivel-ligero') {
    return mismaFamilia && effort === r.effort
      ? { accion: 'mantener', texto: '✓' }
      : { accion: 'delegar', texto: `delega: ${r.delegar}` };
  }
  if (mismaFamilia) {
    return effort === r.effort ? { accion: 'mantener', texto: '✓' } : { accion: 'esfuerzo', texto: etiqueta(r) };
  }
  const barato = cacheFria || !esNumero(ctx) || ctx < CONTEXTO_BARATO;
  const fria = cacheFria ? ' (caché fría: cambiar no cuesta)' : '';
  if (rango(r.model) > rango(model)) {
    if (barato) return { accion: 'cambiar', texto: `${etiqueta(r)}${fria}` };
    if (r.delegar) return { accion: 'delegar', texto: `delega: ${r.delegar}` };
    const coste = esNumero(tokens) && tokens > 0 ? ` · relee ~${Math.round(tokens / 1000)}k` : '';
    return { accion: 'cambiar', texto: `${etiqueta(r)}${coste}` };
  }
  if (barato) return { accion: 'cambiar', texto: `${etiqueta(r)}${fria}` };
  if (rutinaSeguidas >= RUTINA_PARA_SESION) return { accion: 'sesion', texto: `sesión nueva en ${nombreModelo(r.model)}` };
  return effort === r.effort || !effort ? { accion: 'mantener', texto: '✓' } : { accion: 'esfuerzo', texto: r.effort };
}
