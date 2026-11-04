// Lógica pura del panel: reduce los eventos de la sesión a un estado que el panel dibuja. Sin datos inventados:
// todo sale de lo que el motor informa (pasos, subagentes, llamadas del servidor, herramientas).
export const MAX_REGISTRO = 60;
export const MAX_AGENTES = 8;

export const crear = () => ({
  lider: { modelo: null, esfuerzo: null, leidos: 0, escritos: 0, herramientas: 0 },
  agentes: [],
  asesor: { llamadas: 0, ultimo: null, tiempo: 0 },
  registro: [],
  pasos: 0,
  recomendacion: null,
});

export function familia(modelo) {
  const m = String(modelo ?? '').toLowerCase();
  for (const nombre of ['haiku', 'sonnet', 'opus', 'fable']) if (m.includes(nombre)) return nombre;
  return 'otro';
}

// «claude-sonnet-5-5» → «Sonnet 5.5»; ignora la fecha final de los identificadores largos.
export function etiquetaModelo(modelo) {
  if (!modelo) return 'modelo ?';
  const m = String(modelo).toLowerCase().replace(/^claude-/u, '');
  const partes = m.match(/^(haiku|sonnet|opus|fable)(?:-(\d{1,2})(?:-(\d{1,2}))?)?(?:-|$)/u);
  if (!partes) return String(modelo);
  const nombre = partes[1][0].toUpperCase() + partes[1].slice(1);
  if (!partes[2]) return nombre;
  return `${nombre} ${partes[2]}${partes[3] ? `.${partes[3]}` : ''}`;
}

const NIVELES = { low: 1, medium: 2, high: 3, xhigh: 4, max: 4 };
export function barraEsfuerzo(esfuerzo) {
  const llenos = NIVELES[esfuerzo] ?? 0;
  return '▮'.repeat(llenos) + '▯'.repeat(4 - llenos);
}

export function duracion(ms) {
  if (!Number.isFinite(ms) || ms < 1000) return '0 s';
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
}

export function hora(ms) {
  const d = new Date(ms);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
}

const conRegistro = (estado, entrada) => ({ ...estado, registro: [...estado.registro, entrada].slice(-MAX_REGISTRO) });
const nombreDe = (estado, id) => (id ? (estado.agentes.find((a) => a.id === id)?.nombre ?? 'agente') : 'líder');

export function registrarPaso(estado, { modelo, esfuerzo, agentId }) {
  if (agentId) {
    return { ...estado, agentes: estado.agentes.map((a) => (a.id === agentId && modelo ? { ...a, modelo } : a)) };
  }
  return {
    ...estado,
    pasos: estado.pasos + 1,
    lider: { ...estado.lider, modelo: modelo ?? estado.lider.modelo, esfuerzo: esfuerzo ?? estado.lider.esfuerzo },
  };
}

export function iniciarAgente(estado, { id, nombre, modelo, at }) {
  const agente = { id, nombre, modelo, estado: 'corriendo', inicio: at, fin: null, herramientas: 0, leidos: 0, escritos: 0, ultimo: '' };
  return conRegistro(
    { ...estado, agentes: [...estado.agentes, agente].slice(-MAX_AGENTES) },
    { t: at, quien: nombre, texto: `empieza · ${etiquetaModelo(modelo)}` },
  );
}

export function terminarAgente(estado, { id, ok, at }) {
  const existe = estado.agentes.some((a) => a.id === id);
  if (!existe) return estado;
  const agentes = estado.agentes.map((a) => (a.id === id ? { ...a, estado: ok ? 'listo' : 'error', fin: at } : a));
  return conRegistro({ ...estado, agentes }, { t: at, quien: nombreDe(estado, id), texto: ok ? 'terminó' : 'terminó con error' });
}

export function registrarHerramienta(estado, { tool, detalle, agentId, at }) {
  const texto = detalle ? `${tool} · ${detalle}` : tool;
  const agentes = agentId
    ? estado.agentes.map((a) => (a.id === agentId ? { ...a, herramientas: a.herramientas + 1, ultimo: texto } : a))
    : estado.agentes;
  const lider = agentId ? estado.lider : { ...estado.lider, herramientas: (estado.lider.herramientas ?? 0) + 1 };
  return conRegistro({ ...estado, agentes, lider }, { t: at, quien: nombreDe(estado, agentId), texto });
}

export function registrarAsesor(estado, { llamadas, at, tiempo = 0 }) {
  if (!llamadas) return estado;
  return conRegistro(
    { ...estado, asesor: { llamadas: estado.asesor.llamadas + llamadas, ultimo: at, tiempo: (estado.asesor.tiempo ?? 0) + tiempo } },
    { t: at, quien: 'asesor', texto: `consultado ${llamadas} ${llamadas === 1 ? 'vez' : 'veces'}`, ms: tiempo },
  );
}

const esNumero = (valor) => typeof valor === 'number' && Number.isFinite(valor);
// Línea de uso: solo lo que se conoce; undefined si no hay nada que mostrar.
export function textoDeUso(uso) {
  const partes = [];
  if (esNumero(uso?.context?.percent)) partes.push(`contexto ${Math.round(uso.context.percent)} %`);
  for (const limite of uso?.rateLimits ?? []) {
    if (!esNumero(limite?.percentUsed)) continue;
    if (limite.kind === 'five_hour') partes.push(`5 h ${Math.round(limite.percentUsed)} %`);
    if (limite.kind === 'seven_day') partes.push(`semana ${Math.round(limite.percentUsed)} %`);
  }
  return partes.length > 0 ? partes.join(' · ') : undefined;
}

// --- Diagrama ---------------------------------------------------------------------------------------------------
export function barra(fraccion, ancho) {
  const valor = Number.isFinite(fraccion) ? Math.min(1, Math.max(0, fraccion)) : 0;
  const llenos = Math.round(valor * ancho);
  return '█'.repeat(llenos) + '░'.repeat(ancho - llenos);
}

export function resumenDelegacion(agentes) {
  return {
    total: agentes.length,
    corriendo: agentes.filter((a) => a.estado === 'corriendo').length,
    listos: agentes.filter((a) => a.estado === 'listo').length,
    errores: agentes.filter((a) => a.estado === 'error').length,
    herramientas: agentes.reduce((suma, a) => suma + a.herramientas, 0),
  };
}

// Lo que se escribe en --model: la familia si se reconoce, y el texto tal cual si no.
export function alias(modelo) {
  if (!modelo) return '?';
  const f = familia(modelo);
  return f === 'otro' ? String(modelo) : f;
}

// La familia de subagentes más usada, en el orden en que aparecieron si hay empate.
function familiaDominante(agentes) {
  const cuentas = new Map();
  for (const a of agentes) cuentas.set(familia(a.modelo), (cuentas.get(familia(a.modelo)) ?? 0) + 1);
  let mejor = null;
  for (const [nombre, n] of cuentas) if (mejor === null || n > cuentas.get(mejor)) mejor = nombre;
  return mejor;
}

// «Haiku 5.5» si es la familia de subagentes más usada; null si no hay subagentes.
export function etiquetaEnjambre(agentes) {
  if (agentes.length === 0) return null;
  const dominante = familiaDominante(agentes);
  const representante = [...agentes].reverse().find((a) => familia(a.modelo) === dominante);
  return etiquetaModelo(representante.modelo);
}

export function tituloDeOrquesta(estado) {
  let titulo = 'NEXAKIT · ORQUESTA';
  if (estado.lider.modelo) titulo += ` · ${etiquetaModelo(estado.lider.modelo).toUpperCase()} DIRIGE`;
  const enjambre = etiquetaEnjambre(estado.agentes);
  if (enjambre) titulo += ` · ${enjambre.toUpperCase()} EN ENJAMBRE`;
  return titulo;
}

// Una etiqueta por familia de subagentes, el avance de la delegación y el asesor; solo lo que ocurre.
export function estadoPorFamilia(estado) {
  const partes = [];
  const familias = [];
  for (const a of estado.agentes) if (!familias.includes(familia(a.modelo))) familias.push(familia(a.modelo));
  for (const nombre of familias) {
    const suyos = estado.agentes.filter((a) => familia(a.modelo) === nombre);
    const etiqueta = suyos.some((a) => a.estado === 'corriendo') ? 'enjambre' : suyos.some((a) => a.estado === 'error') ? 'con error' : 'listo';
    partes.push(`${nombre === 'otro' ? 'agente' : nombre} [${etiqueta}]`);
  }
  if (estado.agentes.length > 0) {
    const r = resumenDelegacion(estado.agentes);
    partes.push(`subagentes [${r.total - r.corriendo}/${r.total}]`);
  }
  if (estado.asesor.llamadas > 0) partes.push(`asesor [consultado ${estado.asesor.llamadas}]`);
  return partes;
}

// Datos ficticios para ver el diseño sin esperar a que haya actividad real. Siempre se muestran marcados como ejemplo.
export function ejemplo(ahora) {
  const t = (segundos) => ahora - segundos * 1000;
  let s = { ...registrarPaso(crear(), { modelo: 'claude-sonnet-5-5', esfuerzo: 'high' }), pasos: 24 };
  s = registrarUso(s, { usage: { input_tokens: 8_400, output_tokens: 12_300, cache_read_input_tokens: 660_000, cache_creation_input_tokens: 0 } });
  s = registrarAsesor(s, { llamadas: 1, at: t(95), tiempo: 4_200 });
  s = iniciarAgente(s, { id: 'ej1', nombre: 'search', modelo: 'claude-haiku-5-5', at: t(40) });
  s = iniciarAgente(s, { id: 'ej2', nombre: 'grep', modelo: 'claude-haiku-5-5', at: t(38) });
  s = iniciarAgente(s, { id: 'ej3', nombre: 'audit', modelo: 'claude-haiku-5-5', at: t(36) });
  s = registrarHerramienta(s, { tool: 'Glob', detalle: 'src/**/*.ts', agentId: 'ej1', at: t(31) });
  s = registrarHerramienta(s, { tool: 'Grep', detalle: 'verifyToken', agentId: 'ej2', at: t(28) });
  s = registrarHerramienta(s, { tool: 'Read', detalle: 'src/auth.ts', agentId: 'ej3', at: t(24) });
  s = registrarHerramienta(s, { tool: 'Read', detalle: 'src/session.ts', agentId: 'ej3', at: t(20) });
  s = registrarHerramienta(s, { tool: 'Bash', detalle: 'npm test', agentId: 'ej3', at: t(14) });
  s = registrarUso(s, { agentId: 'ej1', usage: { input_tokens: 41_000, output_tokens: 900, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
  s = registrarUso(s, { agentId: 'ej2', usage: { input_tokens: 72_000, output_tokens: 1_400, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
  s = registrarUso(s, { agentId: 'ej3', usage: { input_tokens: 230_000, output_tokens: 3_100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
  s = terminarAgente(s, { id: 'ej3', ok: true, at: t(10) });
  s = registrarHerramienta(s, { tool: 'Edit', detalle: 'src/auth.ts', at: t(8) });
  s = registrarAsesor(s, { llamadas: 1, at: t(5), tiempo: 2_800 });
  return s;
}

// Uso real de cada paso: leídos = entrada + caché leída + caché escrita; escritos = salida.
export function registrarUso(estado, { agentId, usage }) {
  if (!usage) return estado;
  const leidos = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
  const escritos = usage.output_tokens ?? 0;
  if (agentId) {
    return { ...estado, agentes: estado.agentes.map((a) => (a.id === agentId ? { ...a, leidos: a.leidos + leidos, escritos: a.escritos + escritos } : a)) };
  }
  return { ...estado, lider: { ...estado.lider, leidos: estado.lider.leidos + leidos, escritos: estado.lider.escritos + escritos } };
}

export function tokens(n) {
  if (!Number.isFinite(n) || n < 1000) return String(Math.max(0, Math.round(n || 0)));
  if (n < 1_000_000) {
    const k = n / 1000;
    return `${k < 10 ? Math.round(k * 10) / 10 : Math.round(k)}k`;
  }
  return `${Math.round(n / 100_000) / 10}M`;
}

// La recomendación que registra el mod nexakit-modelo, observada en su llamada.
export function registrarRecomendacion(estado, { modelo, esfuerzo, motivo }) {
  return { ...estado, recomendacion: { modelo, esfuerzo, motivo } };
}

// Tacha los secretos evidentes de un detalle antes de mostrarlo o guardarlo en disco.
export function sinSecretos(texto) {
  return String(texto)
    .replace(/\b([A-Za-z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD)[A-Za-z0-9_]*)=([^\s"']+)/giu, '$1=***')
    .replace(/(Bearer\s+)[^\s"']+/giu, '$1***')
    .replace(/(--?(?:password|passwd|token|secret|api-key)[= ])[^\s"']+/giu, '$1***');
}
