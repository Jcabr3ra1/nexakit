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

// Cuota de 5 horas: a partir de aquí los subagentes en paralelo agotan el límite antes de terminar.
export const CUOTA_SERIE = 70;
export const CUOTA_CRITICA = 90;

export function nivelDeCuota(usage) {
  const cinco = (usage?.rateLimits ?? []).find((l) => l?.kind === 'five_hour')?.percentUsed;
  if (!esNumero(cinco)) return 0;
  if (cinco >= CUOTA_CRITICA) return 2;
  if (cinco >= CUOTA_SERIE) return 1;
  return 0;
}

// Nota para el modelo, no para la persona: va al final del mensaje solo al cambiar de nivel.
export function notaDeCuota(nivel, percent) {
  const p = entero(percent);
  if (nivel === 1) return `[nexakit: cuota de 5 h al ${p} %. Lanza los subagentes en serie, no en paralelo.]`;
  if (nivel === 2) return `[nexakit: cuota de 5 h al ${p} %. Subagentes solo en serie y en los niveles ligero o normal; avisa antes de algo largo.]`;
  return undefined;
}

// Lo que el resumen de una compactación debe conservar para poder seguir la tarea sin releer todo.
export const CONSERVAR_AL_COMPACTAR = [
  'Conserva literalmente: la rama y el directorio de trabajo, los archivos tocados, las decisiones',
  'tomadas con la persona y su porqué, lo pendiente en orden, los comandos de comprobación con su',
  'último resultado y cualquier autorización o prohibición que haya dado la persona.',
].join(' ');
