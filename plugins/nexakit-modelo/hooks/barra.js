// Contenido de la barra sobre el prompt: datos puros (texto y color por tramo) para poder probarlos.
import { decidir } from './decidir.js';
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

// Acierto de caché acumulado: lo leído de la caché frente a todo lo que entró. null hasta tener dos
// turnos, porque el primero siempre escribe la caché entera.
export function aciertoDeCache(cache) {
  if (!cache || cache.turnos < 2) return null;
  const total = cache.read + cache.creation + cache.input;
  return total > 0 ? (cache.read / total) * 100 : null;
}

const tonoCache = (p) => (p >= 80 ? 'success' : p >= 50 ? 'warning' : 'error');

// Tokens de un subagente, sumados paso a paso con el uso que la API informó de cada petición. Separan lo que
// entró nuevo (input), lo que se leyó de la caché (read) y lo que se escribió en ella (creation), porque una
// cifra total sola asusta: casi todo suele ser lectura barata de caché.
export const tokensVacios = () => ({ input: 0, output: 0, read: 0, creation: 0, pasos: 0 });

const cuenta = (v) => (esNumero(v) && v > 0 ? v : 0);

export function sumarTokens(acum, usage) {
  if (!usage || typeof usage !== 'object') return;
  const input = cuenta(usage.input_tokens);
  const output = cuenta(usage.output_tokens);
  const read = cuenta(usage.cache_read_input_tokens);
  const creation = cuenta(usage.cache_creation_input_tokens);
  if (input + output + read + creation === 0) return;
  acum.input += input;
  acum.output += output;
  acum.read += read;
  acum.creation += creation;
  acum.pasos += 1;
}

export const totalDeTokens = (t) => t.input + t.output + t.read + t.creation;

// Caché frente a todo lo que entró (la salida no cuenta); null si no entró nada.
export function cacheDeTokens(t) {
  const entrada = t.input + t.read + t.creation;
  return entrada > 0 ? (t.read / entrada) * 100 : null;
}

export function formatoTokens(n) {
  if (!esNumero(n) || n <= 0) return '0';
  if (n < 1000) return String(Math.round(n));
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace('.', ',')}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace('.', ',')}M`;
}

// Tramos de tokens de la fila de un subagente: el total desde el primer paso y el porcentaje de caché desde el
// segundo (el primero siempre escribe la caché, así que juzgarlo sería engañoso).
function tramosDeTokens(tokens) {
  if (!tokens || tokens.pasos < 1) return [];
  const tramos = [{ text: `  ${formatoTokens(totalDeTokens(tokens))}` }];
  const acierto = tokens.pasos >= 2 ? cacheDeTokens(tokens) : null;
  if (acierto !== null) tramos.push({ text: ' · ', dim: true }, { text: `${Math.round(acierto)}% caché`, color: tonoCache(acierto) });
  return tramos;
}

// La decisión (mantener, esfuerzo, delegar, cambiar o sesión nueva) la toma decidir.js; aquí solo se pinta.
function sugerencia(estado) {
  const d = decidir(estado);
  if (!d) return null;
  return d.accion === 'mantener' ? { text: '  ✓', color: 'success' } : { text: `  → ${d.texto}`, color: 'suggestion' };
}

// El límite de uso más alto de los que informa la API (5 horas o semanal).
const limiteMasAlto = (usage) => Math.max(-1, ...(usage?.rateLimits ?? []).map((l) => (esNumero(l?.percentUsed) ? l.percentUsed : -1)));

export function segmentosDeBarra({ model, effort, recommendation, usage, cache, cacheFria = false, rutinaSeguidas = 0 }) {
  const s = [
    { text: nombreModelo(model), color: 'claude', bold: true },
    effort ? { text: ` · ${effort}` } : { text: ' · esfuerzo ?', dim: true },
  ];
  const ctx = usage?.context?.percent;
  const limite = limiteMasAlto(usage);
  const propuesta = recommendation && sugerencia({ model, effort, recommendation, ctx, tokens: usage?.context?.tokens, cacheFria, limite: limite < 0 ? undefined : limite, rutinaSeguidas });
  if (propuesta) s.push(propuesta);
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
      ...tramosDeTokens(a.tokens),
    ];
  });
}
