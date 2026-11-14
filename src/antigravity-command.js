import path from 'node:path';
import {
  buildAntigravityStatusSegments,
  extractContextPercent,
  extractQuotaSummary,
  formatAntigravityStatusLine,
} from './antigravity-barra.js';
import { syncAndReadAntigravityBarraSession } from './antigravity-session.js';

const MAX_STDIN_BYTES = 1024 * 1024;

const HELP = `Uso: nexakit antigravity barra [--sin-color] [--json]
     nexakit antigravity preparar [--salida carpeta] [--apply] [--json]
     nexakit antigravity agentes [--proyecto] [--salida carpeta] [--apply] [--actualizar] [--json]
     nexakit antigravity recomendar --tarea texto [--json]
     nexakit antigravity hook
     nexakit antigravity ejecutar -- programa [argumentos...]\n`;

const FLAGS = Object.freeze({
  barra: { '--sin-color': 'bool', '--json': 'bool' },
  preparar: { '--salida': 'value', '--apply': 'bool', '--json': 'bool' },
  agentes: { '--proyecto': 'bool', '--salida': 'value', '--apply': 'bool', '--actualizar': 'bool', '--json': 'bool' },
  recomendar: { '--tarea': 'value', '--json': 'bool' },
  hook: {},
});

function parseFlags(command, argv) {
  if (!Object.hasOwn(FLAGS, command)) throw new Error('Uso inválido.');
  const spec = FLAGS[command];
  const parsed = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!Object.hasOwn(spec, flag) || Object.hasOwn(parsed, flag)) throw new Error('Uso inválido.');
    if (spec[flag] === 'bool') {
      parsed[flag] = true;
    } else {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error('Falta el valor.');
      parsed[flag] = value;
    }
  }
  if (command === 'recomendar' && !parsed['--tarea']?.trim()) throw new Error('Falta la tarea.');
  if (command === 'agentes' && parsed['--actualizar'] && !parsed['--apply']) throw new Error('Actualizar requiere apply.');
  if (command === 'agentes' && parsed['--proyecto'] && parsed['--salida']) throw new Error('Conflicto de destino.');
  return parsed;
}

async function readBoundedJson(input) {
  let size = 0;
  const chunks = [];
  for await (const chunk of input) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_STDIN_BYTES) throw new Error('Límite de entrada.');
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return null;
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Payload inválido.');
  return parsed;
}

async function handleBarra(flags, io, options) {
  let payload;
  try {
    payload = await readBoundedJson(io.input ?? process.stdin);
  } catch {
    return 0;
  }
  if (!payload) return 0;

  const sessionId = typeof payload.conversation_id === 'string' && payload.conversation_id
    ? payload.conversation_id
    : payload.session_id;
  const now = options.now ?? Date.now();
  const contextPercent = extractContextPercent(payload.context_window);
  const quotaPercent = extractQuotaSummary(payload.quota, now)?.percentUsed ?? null;
  const recommendation = await syncAndReadAntigravityBarraSession(
    sessionId,
    { contextPercent, quotaPercent },
    options,
  );

  if (flags['--json']) {
    await io.out(JSON.stringify(buildAntigravityStatusSegments(payload, { recommendation, now })) + '\n');
    return 0;
  }
  const color = !flags['--sin-color'] && !(options.environment?.NO_COLOR || process.env.NO_COLOR);
  const line = formatAntigravityStatusLine(payload, { recommendation, now, color });
  if (line) await io.out(`${line}\n`);
  return 0;
}

async function handleHook(io, options) {
  let result = {};
  try {
    const payload = await readBoundedJson(io.input ?? process.stdin);
    if (payload && typeof payload.hookEventName === 'string') {
      const { runAntigravityHook } = await import('./antigravity-hook.js');
      result = (await runAntigravityHook(payload, options)) ?? {};
    }
  } catch {
    await io.err('No se pudo procesar el hook de Antigravity; la sesión puede continuar.\n');
  }
  await io.out(JSON.stringify(result) + '\n');
  return 0;
}

function formatRecommendation(report) {
  return [
    report.message,
    report.recommendation
      ? `Recomendación: ${report.recommendation.level} (${report.recommendation.label}).`
      : 'Recomendación no disponible.',
    `Razón: ${report.reason}`,
    `Fuente: ${report.source}`,
    `Acción: ${report.action ?? 'sin acción'}`,
    ...(report.delegate ? [`Subagente: ${report.delegate}`] : []),
    'Sin cambios automáticos.',
    '',
  ].join('\n');
}

function formatPrepare(report) {
  return [
    report.applied
      ? `Paquete Antigravity CLI creado en: ${report.outputDirectory}`
      : 'Vista previa Antigravity CLI (no se escribió ningún archivo):',
    '',
    'Comando rápido dentro de agy:',
    `  /statusline ${report.statusLineCommand}`,
    '',
    'Limitaciones:',
    ...report.limitations.map((item) => `- ${item}`),
    '',
  ].join('\n');
}

function formatAgents(report, apply) {
  const rows = [
    ['Nombre', 'Modelo', 'Esfuerzo', 'Estado'],
    ...report.files.map((file) => [file.name, file.model, file.effort, file.state]),
  ];
  const widths = rows[0].map((_, index) => Math.max(...rows.map((row) => row[index].length)));
  return [
    apply ? `Agentes de Antigravity (${report.targetDirectory}):` : `Vista previa de agentes (${report.targetDirectory}):`,
    ...rows.map((row) => row.map((value, index) => value.padEnd(widths[index])).join('  ').trimEnd()),
    ...report.files.filter((f) => f.backupPath).map((f) => `Respaldo ${f.name}: ${f.backupPath}`),
    'Limitaciones:',
    ...report.limitations.map((item) => `- ${item}`),
    '',
  ].join('\n');
}

/** Run `nexakit antigravity <subcommand>` CLI actions. */
export async function runAntigravityCommand(argv, io, options = {}) {
  const [command, ...rest] = argv;
  if (argv.length === 1 && ['--help', '-h'].includes(command)) {
    await io.out(HELP);
    return 0;
  }
  if (command === 'ejecutar') {
    if (rest[0] !== '--' || !rest[1]) {
      await io.err(HELP);
      return 2;
    }
    try {
      const { runCodexOutput } = await import('./codex-output.js');
      return await runCodexOutput(rest.slice(1), io, { ...options, agent: 'antigravity' });
    } catch {
      await io.err('No se pudo ejecutar el programa.\n');
      return 1;
    }
  }
  let flags;
  try {
    flags = parseFlags(command, rest);
  } catch {
    await io.err(HELP);
    return 2;
  }
  if (command === 'barra') return handleBarra(flags, io, options);
  if (command === 'hook') return handleHook(io, options);
  try {
    if (command === 'agentes') {
      const { planAntigravityAgents, writeAntigravityAgents } = await import('./antigravity-agents.js');
      let plan = await planAntigravityAgents({
        ...options,
        project: Boolean(flags['--proyecto']),
        outputDirectory: flags['--salida'] ? path.resolve(flags['--salida']) : undefined,
      });
      if (flags['--apply']) {
        plan = await writeAntigravityAgents(plan, { apply: true, update: Boolean(flags['--actualizar']) });
      }
      const report = {
        targetDirectory: plan.targetDirectory,
        files: plan.files.map(({ name, path: filePath, model, effort, state, backupPath }) => ({
          name, path: filePath, model, effort, state, ...(backupPath ? { backupPath } : {}),
        })),
        limitations: plan.limitations,
      };
      await io.out(flags['--json'] ? JSON.stringify(report) + '\n' : formatAgents(report, Boolean(flags['--apply'])));
      const blocked = report.files.some((f) => f.state === 'bloqueado');
      const incomplete = report.files.some((f) => f.state !== 'igual');
      return blocked || (flags['--apply'] && incomplete) ? 1 : 0;
    }
    if (command === 'recomendar') {
      const { recommendAntigravityTask } = await import('./antigravity-recommendation.js');
      const report = await recommendAntigravityTask(flags['--tarea'], options);
      await io.out(flags['--json'] ? JSON.stringify(report) + '\n' : formatRecommendation(report));
      return 0;
    }
    const { prepareAntigravity } = await import('./antigravity-setup.js');
    const report = await prepareAntigravity({
      ...options,
      outputDirectory: flags['--salida'] ? path.resolve(flags['--salida']) : undefined,
      apply: Boolean(flags['--apply']),
    });
    await io.out(flags['--json'] ? JSON.stringify(report) + '\n' : formatPrepare(report));
    return 0;
  } catch {
    await io.err('No se pudo completar el comando Antigravity. Revisa formato, rutas y permisos.\n');
    return 1;
  }
}
