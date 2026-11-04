// Umbrales de contexto a partir de los cuales conviene pensar en una sesión nueva.
export const UMBRAL_AVISO = 60;
export const UMBRAL_URGENTE = 80;

const entero = (valor) => Math.round(valor);
const esNumero = (valor) => typeof valor === 'number' && Number.isFinite(valor);

// 0 = sin aviso, 1 = conviene, 2 = urgente. Sin dato nunca avisa.
export function avisoDeContexto(percent) {
  if (!esNumero(percent)) return 0;
  if (percent >= UMBRAL_URGENTE) return 2;
  if (percent >= UMBRAL_AVISO) return 1;
  return 0;
}

// Línea de estado: solo lo que se conoce; undefined si no hay nada que mostrar.
export function textoDeEstado(usage) {
  const partes = [];
  if (esNumero(usage?.context?.percent)) partes.push(`contexto ${entero(usage.context.percent)} %`);
  for (const limite of usage?.rateLimits ?? []) {
    if (!esNumero(limite?.percentUsed)) continue;
    if (limite.kind === 'five_hour') partes.push(`5 h ${entero(limite.percentUsed)} %`);
    if (limite.kind === 'seven_day') partes.push(`semana ${entero(limite.percentUsed)} %`);
  }
  return partes.length > 0 ? partes.join(' · ') : undefined;
}

// El aviso solo recomienda: nunca promete ni hace el cierre por la persona.
export function mensajeDeAviso(nivel, percent) {
  const p = entero(percent);
  if (nivel === 1) {
    return `Contexto al ${p} %. Si vas a cambiar de tarea, es buen momento: escribe el traspaso y abre una sesión nueva.`;
  }
  if (nivel === 2) {
    return `Contexto al ${p} %. Cada turno relee más contexto: cierra esta tarea, escribe el traspaso y abre una sesión nueva.`;
  }
  return undefined;
}
