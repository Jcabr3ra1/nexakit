import path from 'node:path';
import { prepareCodex } from './codex-setup.js';
import { compareCodexSamples, readCodexSample } from './codex-compare.js';

const HELP = `Uso: nexakit codex auditar [--project ruta] [--json]
     nexakit codex preparar [--salida carpeta] [--apply] [--json]
     nexakit codex consumo [--json]
     nexakit codex hook
     nexakit codex ejecutar -- programa argumentos
     nexakit codex comparar --antes archivo --despues archivo [--json]\n`;
const FLAGS = { auditar: { '--project': 'value', '--json': 'bool' },
  preparar: { '--salida': 'value', '--apply': 'bool', '--json': 'bool' },
  consumo: { '--json': 'bool' }, hook: {}, comparar: { '--antes': 'value', '--despues': 'value', '--json': 'bool' } };
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
    let report;
    if (command === 'preparar') report = await prepareCodex({ ...options, outputDirectory: flags['--salida'], apply: Boolean(flags['--apply']) });
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
      command === 'comparar' ? formatComparison(report) : command === 'consumo' ? formatConsumption(report) : JSON.stringify(report, null, 2) + '\n');
    return 0;
  } catch {
    await io.err('No se pudo completar el comando Codex. Revisa formato, calidad, rutas y permisos.\n');
    return 1;
  }
}
