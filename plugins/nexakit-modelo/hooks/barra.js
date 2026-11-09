// Contenido de la barra sobre el prompt: datos puros (texto y color por tramo) para poder probarlos.
import { UMBRAL_AVISO, UMBRAL_URGENTE } from './umbrales.js';

const FAMILIA = /(haiku|sonnet|opus|fable)(?:-(\d+)-(\d+))?/iu;
const esNumero = (v) => typeof v === 'number' && Number.isFinite(v);
const mayuscula = (s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

export function familia(model) {
  return model?.match(FAMILIA)?.[1]?.toLowerCase() ?? model;
}

export function nombreModelo(model) {
  if (!model) return 'modelo ?';
  const m = model.match(FAMILIA);
  if (!m) return model;
  return m[2] ? `${mayuscula(m[1])} ${m[2]}.${m[3]}` : mayuscula(m[1]);
}

export function medidor(percent, celdas = 10) {
  const llenas = Math.min(celdas, Math.max(0, Math.ceil((percent / 100) * celdas)));
  return '▰'.repeat(llenas) + '▱'.repeat(celdas - llenas);
}

export function tono(percent) {
  if (percent >= UMBRAL_URGENTE) return 'error';
  if (percent >= UMBRAL_AVISO) return 'warning';
  return 'success';
}

// Desde este porcentaje de contexto, cambiar de modelo cuesta más que delegar: el turno siguiente relee
// todo el historial sin caché (cada modelo tiene la suya). Cambiar el esfuerzo no la rompe en los 5.x.
export const CONTEXTO_PARA_DELEGAR = 30;

// Acierto de caché acumulado: lo leído de la caché frente a todo lo que entró. null hasta tener dos
// turnos, porque el primero siempre escribe la caché entera.
export function aciertoDeCache(cache) {
  if (!cache || cache.turnos < 2) return null;
  const total = cache.read + cache.creation + cache.input;
  return total > 0 ? (cache.read / total) * 100 : null;
}

const tonoCache = (p) => (p >= 80 ? 'success' : p >= 50 ? 'warning' : 'error');

function sugerencia({ model, effort, recommendation, ctx }) {
  const mismaFamilia = familia(model) === familia(recommendation.model);
  if (effort && mismaFamilia && effort === recommendation.effort) return { text: '  ✓', color: 'success' };
  const delegar = recommendation.delegar &&
    (recommendation.delegar === 'nivel-ligero' || (!mismaFamilia && esNumero(ctx) && ctx >= CONTEXTO_PARA_DELEGAR));
  if (delegar && !mismaFamilia) return { text: `  → delega: ${recommendation.delegar}`, color: 'suggestion' };
  return { text: `  → ${nombreModelo(recommendation.model)} · ${recommendation.effort}`, color: 'suggestion' };
}

export function segmentosDeBarra({ model, effort, recommendation, usage, cache }) {
  const s = [
    { text: nombreModelo(model), color: 'claude', bold: true },
    effort ? { text: ` · ${effort}` } : { text: ' · esfuerzo ?', dim: true },
  ];
  const ctx = usage?.context?.percent;
  if (recommendation) s.push(sugerencia({ model, effort, recommendation, ctx }));
  const acierto = aciertoDeCache(cache);
  if (acierto !== null) s.push({ text: '   caché ', dim: true }, { text: `${Math.round(acierto)}%`, color: tonoCache(acierto) });
  if (esNumero(ctx)) {
    s.push({ text: '    ctx ', dim: true }, { text: medidor(ctx), color: tono(ctx) }, { text: ` ${Math.round(ctx)}%` });
  }
  for (const l of usage?.rateLimits ?? []) {
    if (!esNumero(l?.percentUsed)) continue;
    const nombre = l.kind === 'five_hour' ? '5h' : l.kind === 'seven_day' ? 'sem' : null;
    if (nombre) s.push({ text: `   ${nombre} `, dim: true }, { text: `${Math.round(l.percentUsed)}%`, color: tono(l.percentUsed) });
  }
  return s;
}

const MAX_FILAS = 4;
const ICONO = {
  pending: ['…', 'warning'], running: ['…', 'warning'], waiting: ['…', 'warning'],
  idle: ['✓', 'success'], completed: ['✓', 'success'], failed: ['✗', 'error'], killed: ['✗', 'error'],
};
const ancho = (texto, n) => (texto.length >= n ? `${texto.slice(0, n - 1)}…` : texto.padEnd(n));

// Una fila por subagente (los más recientes): nivel, modelo y esfuerzo observados, encargo y estado.
export function filasDeAgentes(agentes) {
  return agentes.slice(-MAX_FILAS).map((a) => {
    const nivel = String(a.type ?? '?').replace(/^niveles:nivel-/u, '');
    const [icono, color] = ICONO[a.status] ?? ['?', undefined];
    return [
      { text: `  ↳ ${ancho(nivel, 9)}`, dim: true },
      { text: ancho(`${nombreModelo(a.model)}${a.effort ? ` · ${a.effort}` : ''}`, 20), color: 'claude' },
      { text: ` ${ancho(a.description ?? '', 32)} ` },
      { text: icono, color },
    ];
  });
}
