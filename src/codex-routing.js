const LEVELS = ['nivel_ligero', 'nivel_normal', 'nivel_exigente', 'nivel_alto'];
const SPECIALISTS = [
  ['investigador', /\b(?:busca(?:r)?|investiga(?:r)?|consulta(?:r)?)\b.*\b(?:fuentes oficiales|documentacion|docs)\b/, 'nivel_normal'],
  ['revisor_de_calidad', /\b(?:revisa(?:r)?|audita(?:r)?)\b.*\bcalidad\b/, 'nivel_exigente'],
  ['subir_al_repo', /\b(?:sube|subir|subas)\s+(?:al\s+)?(?:repo|repositorio)\b/, 'nivel_normal'],
  ['cierre_de_memoria', /\b(?:cierra|cerrar)\s+(?:la\s+)?memoria\b/, 'nivel_normal'],
  ['sincronizador_docs', /\bsincroniza(?:r)?\s+(?:la\s+)?(?:docs|documentacion)\b/, 'nivel_normal'],
  ['cazador_de_flakes', /\b(?:fallo|falla|fallos|test|tests|ci)\b.*\b(?:intermitente|intermitentes|flaky|flakes)\b/, 'nivel_exigente'],
];
const ALLOWED = new Set([...LEVELS, ...SPECIALISTS.map(([name]) => name)]);
const SENSITIVE = new Set(['subir_al_repo', 'cierre_de_memoria']);
const GUIDANCE = [
  'El principal entiende, decide e integra; delega tareas de más de 1–2 pasos con la herramienta nativa spawn disponible.',
  'Acota cada encargo: objetivo, archivos y criterio de hecho; no repitas búsquedas ni suites ya comprobadas.',
  'Respeta los límites y permisos del padre, verifica los resultados antes de integrar y no cambies automáticamente modelo ni effort.',
  'No solicites revisión cruzada por otra IA sin petición expresa. El hook no ejecuta agentes ni crea autorización.',
  'Usa el perfil solo si aparece en tus agentes/herramientas disponibles; los archivos instalados no prueban que esta sesión lo haya cargado.',
  'Si no está disponible usa un nivel registrado o resuelve tú, sin inventar agent_type.',
].join(' ');
const AUTHORIZATION = 'Antes de subir al repo o cerrar memoria, el principal debe confirmar que el encargo contiene el pedido escrito de la persona y evidencia verificable; esta sugerencia no crea autorización.';

function silent() {
  return { agent: null, context: '' };
}

function isDirectRequest(task, pattern) {
  const match = pattern.exec(task);
  return match && /^[¿\s]*(?:por favor[,\s]+)?(?:(?:puedes|podrias|quiero que|necesito que)\s+)?$/.test(task.slice(0, match.index));
}

/** Pure routing hint, never an authorization or a statement of runtime availability. */
export function routeCodexTask(text, options = {}) {
  if (typeof text !== 'string' || text.length > 16384 || Buffer.byteLength(text, 'utf8') > 16384) {
    return silent();
  }
  if (!options || typeof options !== 'object' || Array.isArray(options)) return silent();
  const { installedNames = [] } = options;
  if (!Array.isArray(installedNames)) return silent();
  const installed = new Set(installedNames.filter((name) => typeof name === 'string' && ALLOWED.has(name)));
  if (!installed.size) return silent();

  // Quoted examples are data, not requests. An unmatched opening quote hides the remainder too.
  const task = text
    .replace(/```[\s\S]*?(?:```|$)|`[^`]*(?:`|$)|"[^"]*(?:"|$)|'[^']*(?:'|$)|“[^”]*(?:”|$)|«[^»]*(?:»|$)|‘[^’]*(?:’|$)/g, ' ')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim()
    .replace(/^si\s*,\s*/, '');
  if (!task || /^(?:(?:si|ok|vale|adelante|continua|hazlo|de acuerdo|perfecto|gracias|listo|dale|sigue|confirmo|por favor)[\s,.!]*)+$/.test(task)) {
    return silent();
  }

  const informational = /^(?:[¿?\s]*)(?:explica\b|que\b|como\b|cual\b|cuando\b|donde\b|por que\b|ya\b|has\b)/.test(task);
  const restricted = informational || /\b(?:no|nunca|jamas|sin|evita|prohibido|si|ejemplo|dice|escribio|significa)\b/.test(task);
  const generalAction = /\b(?:implementa(?:r)?|anade|agrega(?:r)?|crea(?:r)?|corrige|arregla(?:r)?|resuelve|renombra(?:r)?|refactoriza(?:r)?|optimiza(?:r)?)\b/.test(task);

  let specialist;
  let fallback;
  const explicit = /^(?:por favor[,\s]+)?(?:usa|utiliza|delega a)\s+([a-z][a-z_-]*)\b(?:\s+para\s+([\s\S]+))?/.exec(task);
  const requested = explicit?.[1].replace(/-/g, '_');
  const profile = SPECIALISTS.find(([name]) => name === requested);
  if (ALLOWED.has(requested) && !restricted &&
      (!SENSITIVE.has(requested) || isDirectRequest(explicit[2] || '', profile[1]))) {
    specialist = requested;
    fallback = profile?.[2] || requested;
  }
  if (!specialist) {
    for (const [name, pattern, level] of SPECIALISTS) {
      // Sensitive profiles require a direct request, not a mention or a question about permission.
      if (pattern.test(task) && !(SENSITIVE.has(name) && (restricted || !isDirectRequest(task, pattern)))) {
        specialist = name;
        fallback = level;
        break;
      }
    }
  }
  if (!specialist && (informational || restricted) && !generalAction) return silent();
  if (!specialist && /^[¿?]/.test(task) && !generalAction) return silent();

  const runTests = /\b(?:ejecuta(?:r)?|corre(?:r)?|lanza(?:r)?)\s+(?:(?:las|los)\s+)?(?:pruebas|tests?|suite)\b/.test(task) &&
    !/\b(?:escrib[ei]|anade|agrega|implementa|crea|corrige|arregla|diagnostica)\w*\b/.test(task);
  const level = /\b(?:dificil|complejo|sutil|concurrencia|seguridad)\b/.test(task) ? 'nivel_alto'
    : runTests ? 'nivel_ligero'
      : /\b(?:parser|tests?|pruebas|casos borde)\b/.test(task) ? 'nivel_exigente'
      : /\b(?:mecanico|mecanica|mecanicamente|renombra|formatea)\b/.test(task) ? 'nivel_ligero'
        : 'nivel_normal';
  const agent = installed.has(specialist) ? specialist : (fallback || level);
  if (!installed.has(agent)) return silent();
  return {
    agent,
    context: `Perfil candidato: ${agent}. ${GUIDANCE} ${AUTHORIZATION}`,
  };
}
