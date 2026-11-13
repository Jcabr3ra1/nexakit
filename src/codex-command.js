import path from 'node:path';
import { prepareCodex } from './codex-setup.js';
import { compareCodexSamples, readCodexSample } from './codex-compare.js';

const HELP = `Uso: nexakit codex auditar [--project ruta] [--json]
     nexakit codex preparar [--salida carpeta] [--apply] [--json]
     nexakit codex agentes [--apply] [--actualizar] [--json]
     nexakit codex consumo [--json]
     nexakit codex actividad [--json]
     nexakit codex recomendar --tarea texto [--json]
     nexakit codex hook
     nexakit codex ejecutar -- programa argumentos
     nexakit codex comparar --antes archivo --despues archivo [--json]\n`;
const FLAGS = { auditar: { '--project': 'value', '--json': 'bool' },
  preparar: { '--salida': 'value', '--apply': 'bool', '--json': 'bool' },
  agentes: { '--apply': 'bool', '--actualizar': 'bool', '--json': 'bool' },
  consumo: { '--json': 'bool' }, actividad: { '--json': 'bool' }, recomendar: { '--tarea': 'value', '--json': 'bool' }, hook: {}, comparar: { '--antes': 'value', '--despues': 'value', '--json': 'bool' } };
function parse(command, argv) {
  if (!Object.hasOwn(FLAGS, command)) throw new Error('Uso inválido.');
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i], kind = FLAGS[command][flag];
    if (!Object.hasOwn(FLAGS[command], flag) || Object.hasOwn(result, flag)) throw new Error('Uso inválido.');
    if (kind === 'bool') result[flag] = true;
    else {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error('Falta el valor.');
      result[flag] = value;
    }
  }
  if (command === 'comparar' && (!result['--antes'] || !result['--despues'])) throw new Error('Faltan muestras.');
  if (command === 'recomendar' && !result['--tarea']?.trim()) throw new Error('Falta la tarea.');
  if (command === 'agentes' && result['--actualizar'] && !result['--apply']) throw new Error('Actualizar requiere apply.');
  return result;
}
async function readHookInput(input) {
  let size = 0;
  const chunks = [];
  for await (const chunk of input) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1024 * 1024) throw new Error('Límite de entrada.');
    chunks.push(buffer);
  }
  const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof payload.hook_event_name !== 'string') throw new Error('Payload inválido.');
  return payload;
}
async function hook(io, options) {
  let result = {};
  try {
    const payload = await readHookInput(io.input ?? process.stdin);
    const { runCodexHook } = await import('./codex-hook.js');
    result = await runCodexHook(payload, options) ?? {};
  } catch {
    await io.err('No se pudo procesar el hook de Codex; la sesión puede continuar.\n');
  }
  await io.out(JSON.stringify(result) + '\n');
  return 0;
}
function formatComparison(report) {
  return [`Tarea: ${report.task}`, `Comparabilidad: ${report.comparable ? 'sí' : 'no'}`,
    ...Object.entries(report.counters).map(([key, value]) => `${key}: ${value.saved ?? 'desconocido'} evitados; ${value.percent === null ? 'porcentaje no disponible' : `${value.percent.toFixed(2)}%`}; cobertura ${report.before.counters[key].known}/${report.before.calls} antes, ${report.after.counters[key].known}/${report.after.calls} después`),
    ...report.limitations, ''].join('\n');
}
function formatConsumption(report) {
  const labels = { input_tokens: 'Entrada', cached_input_tokens: 'Entrada en caché (incluida en entrada)',
    output_tokens: 'Salida', total_tokens: 'Total de tokens' };
  const groups = [['Total', report], ['Principal', report.main], ['Subagentes', report.agents],
    ['Atribución desconocida', report.unknown]];
  return ['Consumo Codex: cobertura de solicitudes registradas.',
    ...groups.flatMap(([label, group]) => [`${label}: ${group.requests} solicitudes`,
      ...Object.entries(labels).map(([key, name]) =>
        `  ${name}: ${group.token_usage[key] ?? 'desconocido'} (cobertura ${group.known_counts[key]}/${group.requests})`)]),
    `Estados: ${Object.entries(report.statuses).map(([status, count]) => `${status}: ${count}`).join(', ') || 'sin datos'}`,
    'Limitaciones:', ...report.limitations, ''].join('\n');
}

// Explicit allowlist: profile instructions and concurrency snapshots stay local.
function publicTeam(plan) {
  return {
    codexHome: plan.codexHome,
    files: plan.files.map(({ name, kind, path, model, effort, state, backupPath }) => ({
      name, kind, path, model, effort, state, ...(backupPath ? { backupPath } : {}),
    })),
    limitations: plan.limitations,
  };
}
function formatTeam(report, apply) {
  const rows = [['Nombre', 'Modelo', 'Esfuerzo', 'Estado'],
    ...report.files.map(file => [file.name, file.model ?? 'no disponible', file.effort ?? 'no disponible',
      `${file.state}${['sin-modelo', 'sin-catalogo', 'bloqueado'].includes(file.state) ? ' (no instalado)' : ''}`])];
  const widths = rows[0].map((_, index) => Math.max(...rows.map(row => row[index].length)));
  return [apply ? 'Equipo de Codex: resultado de la aplicación.' : 'Vista previa: no se escribió ningún perfil.',
    ...rows.map(row => row.map((value, index) => value.padEnd(widths[index])).join('  ').trimEnd()),
    ...report.files.filter(file => file.backupPath).map(file => `Respaldo ${file.name}: ${file.backupPath}`),
    'Limitaciones:', ...report.limitations, ''].join('\n');
}
async function teamCommand(flags, io, options) {
  const { teamPlan, writeTeam } = await import('./codex-team.js');
  let plan = await teamPlan(options);
  if (flags['--apply']) plan = await writeTeam(plan, { update: Boolean(flags['--actualizar']) });
  const report = publicTeam(plan);
  await io.out(flags['--json'] ? JSON.stringify(report) + '\n' : formatTeam(report, Boolean(flags['--apply'])));
  const blocked = plan.files.some(file => file.state === 'bloqueado');
  const incomplete = plan.files.some(file => file.state !== 'igual');
  return blocked || (flags['--apply'] && incomplete) ? 1 : 0;
}

function formatRecommendation(report) {
  return [report.message,
    report.recommendation ? `Recomendación: ${report.recommendation.model}; esfuerzo: ${report.recommendation.effort ?? 'no fijado'}.` : 'Recomendación no disponible.',
    `Configuración guardada: ${report.stored ? `${report.stored.model}; esfuerzo: ${report.stored.effort ?? 'no fijado'}` : 'no comprobable'}. No acredita el estado activo; consulta /status.`,
    `Razón: ${report.reason}`,
    `Fuente: ${report.source}`,
    `Acción: ${report.action ?? 'sin acción'}`,
    ...(report.delegate ? [`Subagente: ${report.delegate}`] : []),
    ...(report.command ? [`Comando: ${report.command}`] : []),
    'Sin cambios automáticos.', ''].join('\n');
}

export async function runCodexCommand(argv, io, options = {}) {
  const [command, ...rest] = argv;
  if (argv.length === 1 && ['--help', '-h'].includes(command)) { await io.out(HELP); return 0; }
  if (command === 'ejecutar') {
    if (rest[0] !== '--' || !rest[1]) { await io.err(HELP); return 2; }
    try {
      const { runCodexOutput } = await import('./codex-output.js');
      return await runCodexOutput(rest.slice(1), io, options);
    } catch { await io.err('No se pudo ejecutar el programa.\n'); return 1; }
  }
  let flags;
  try { flags = parse(command, rest); }
  catch { await io.err(HELP); return 2; }
  if (command === 'hook') return hook(io, options);
  try {
    if (command === 'actividad') {
      const { readCodexAgentEvents } = await import('./codex-events.js');
      const events = await readCodexAgentEvents(options);
      const limitations = ['Eventos locales recibidos; no acreditan cobertura completa, éxito de la tarea ni consumo del subagente.'];
      const report = { events, limitations };
      await io.out(flags['--json'] ? JSON.stringify(report) + '\n' : [
        'Actividad local de subagentes (últimos 50 eventos):',
        ...events.slice(-50).map(event => `${event.recorded_at} ${event.hook_event_name} ${event.agent_type} id=${event.agent_id} modelo=${event.model ?? 'desconocido'}`),
        ...limitations, '',
      ].join('\n'));
      return 0;
    }
    if (command === 'agentes') return await teamCommand(flags, io, options);
    let report;
    if (command === 'recomendar') {
      const { recommendCodexTask } = await import('./codex-recommendation.js');
      report = await recommendCodexTask(flags['--tarea'], { ...options, includeAntigravity: false });
    } else if (command === 'preparar') report = await prepareCodex({ ...options, outputDirectory: flags['--salida'], apply: Boolean(flags['--apply']) });
    else if (command === 'comparar') {
      const before = await readCodexSample(flags['--antes']);
      const after = await readCodexSample(flags['--despues']);
      report = compareCodexSamples(before, after);
    } else if (command === 'auditar') {
      const { auditCodex } = await import('./codex-audit.js');
      report = await auditCodex({ ...options, projectRoot: path.resolve(flags['--project'] ?? options.projectRoot ?? process.cwd()) });
    } else {
      const { readCodexUsage, summarizeCodexUsage } = await import('./codex-usage.js');
      report = summarizeCodexUsage(await readCodexUsage(options));
    }
    await io.out(flags['--json'] ? JSON.stringify(report) + '\n' :
      command === 'recomendar' ? formatRecommendation(report) : command === 'comparar' ? formatComparison(report) : command === 'consumo' ? formatConsumption(report) : JSON.stringify(report, null, 2) + '\n');
    return 0;
  } catch {
    await io.err('No se pudo completar el comando Codex. Revisa formato, calidad, rutas y permisos.\n');
    return 1;
  }
}
