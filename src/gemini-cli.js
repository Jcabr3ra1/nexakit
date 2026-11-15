import { createGeminiUsageStore } from "./gemini-usage-store.js";
import { GeminiError, estado, imagen, investigar, consultar, analizar, historial, recuperar } from './gemini-tools.js';
const HELP = `Uso: agent-toolkit-gemini investigar --prompt <pregunta> [--modelo <id>] [--copiar-a <carpeta>]
     agent-toolkit-gemini consultar --prompt <consulta> [--modelo <id>] [--copiar-a <carpeta>]
     agent-toolkit-gemini analizar --prompt <pregunta> --archivo <ruta> [--archivo <ruta> ...] [--modelo <id>] [--copiar-a <carpeta>]
     agent-toolkit-gemini imagen --prompt <descripción> [--modelo <id>] [--copiar-a <carpeta>] [--espera-seg <1-600>]
     agent-toolkit-gemini recuperar --directorio <ruta-de-historial> [--copiar-a <carpeta>] [--espera-seg <1-600>]
     agent-toolkit-gemini historial [--limite <1-100>]
     agent-toolkit-gemini estado

Solo Antigravity CLI (agy), sin API ni cambio de proveedor. analizar copia únicamente
los archivos elegidos (texto, imagen, PDF o vídeo); audio bloqueado por validación fallida. Su lectura depende de las
herramientas del cliente. No genera audio ni vídeo. historial/recuperar no llaman IA.
Cada consulta se guarda en ~/.agent-toolkit/gemini y su consumo declarado, en consumo.jsonl. --copiar-a nunca sobrescribe.
Exit: 0 completado, 1 error, 2 uso incorrecto, 3 análisis parcial/no compatible.
`;
const COUNTERS = ['inputTokens', 'cacheReadTokens', 'outputTokens', 'totalTokens', 'durationMs'];
const MEASURED = ['investigar', 'imagen', 'consultar', 'analizar'];
const NAMES = { '--prompt': 'prompt', '--modelo': 'model', '--copiar-a': 'copyTo', '--espera-seg': 'wait', '--archivo': 'files', '--directorio': 'directory', '--limite': 'limit' };
const ALLOWED = {
  investigar: ['prompt','model','copyTo'], consultar: ['prompt','model','copyTo'], analizar: ['prompt','model','copyTo','files'],
  imagen: ['prompt','model','copyTo','wait'], recuperar: ['directory','copyTo','wait'], historial: ['limit'], estado: []
};
export async function runGeminiCli(argv, { out, err, tools = { investigar, imagen, estado, consultar, analizar, historial, recuperar }, usageStore }  = {}) {
  if (argv.length === 1 && ['--help','-h'].includes(argv[0])) { await out(HELP); return 0; }
  const [command, ...rest] = argv;
  if (!Object.hasOwn(ALLOWED, command ?? '')) { await err(HELP); return 2; }
  const options = {};
  for (let i=0; i<rest.length; i+=2) {
    if (['--task', '--project-root'].includes(rest[i])) { await err('--task y --project-root se retiraron; el consumo se guarda en ~/.agent-toolkit/gemini/consumo.jsonl\n'); return 2; }
    const key = NAMES[rest[i]], value = rest[i+1];
    if (!key || !(ALLOWED[command].includes(key)) || value === undefined || !value || (key !== 'files' && Object.hasOwn(options,key))) { await err(HELP); return 2; }
    if (key === 'files') (options.files ??= []).push(value); else options[key] = value;
  }
  if ((['investigar','consultar','analizar','imagen'].includes(command) && !options.prompt) ||
    (command === 'analizar' && !options.files?.length) || (command === 'recuperar' && !options.directory)) { await err(HELP); return 2; }
  if (options.wait !== undefined && (!/^\d+$/u.test(options.wait) || Number(options.wait)<1 || Number(options.wait)>600) ||
      options.limit !== undefined && (!/^\d+$/u.test(options.limit) || Number(options.limit)<1 || Number(options.limit)>100)) { await err(HELP); return 2; }
  let usageRecord = null;
  try {
    const store = MEASURED.includes(command) ? usageStore ?? createGeminiUsageStore() : null;
    let input;
    if (command === 'estado') input = undefined;
    else if (command === 'historial') input = options.limit === undefined ? {} : { limit: Number(options.limit) };
    else if (command === 'recuperar') input = { directory: options.directory, copyTo: options.copyTo, ...(options.wait && { waitMs: Number(options.wait)*1000 }) };
    else input = { prompt: options.prompt, model: options.model, copyTo: options.copyTo,
      ...(options.files && { files: options.files }), ...(options.wait && { waitMs: Number(options.wait)*1000 }) };
    const record = async result => {
      if (usageRecord) return usageRecord;
      try {
        const u = result.usage;
        const measurement = {
          id: 'gemini:' + result.conversationId, agent: 'gemini', model: result.model, source: 'client-reported',
          phase: { investigar: 'research', imagen: 'image', analizar: 'analysis', consultar: 'other' }[command],
          inputTokens: u.input_tokens ?? null, cacheReadTokens: u.cache_read_tokens ?? null,
          outputTokens: u.output_tokens ?? null, totalTokens: u.total_tokens ?? null,
          durationMs: result.durationMs ?? null, costUsd: null
        };
        // Sin ningún contador no hay nada que medir: una consulta correcta no debe fallar por eso.
        usageRecord = COUNTERS.every(key => measurement[key] === null)
          ? { recorded: false, reason: 'sin-contadores' }
          : await store.recordUsage(measurement);
      } catch {
        usageRecord = { recorded: false, error: 'No se guardó la medición de consumo; conserva estos resultados y no repitas la consulta.' };
      }
      return usageRecord;
    };
    if (store) input.onUsage = meta => record({ ...meta, durationMs: meta.seconds === null ? null : Math.round(meta.seconds * 1000) });
    const result = await tools[command](input);
    if (store && result.conversationId && result.usage) await record(result);
    if (usageRecord) result.usageRecord = usageRecord;
    if (usageRecord?.error) { await out(JSON.stringify(result) + '\n'); return 1; }
    await out(JSON.stringify(result) + '\n');
    return result.analysis && result.analysis.status !== 'completed' ? 3 : 0;
  } catch (failure) {
    if (failure instanceof GeminiError && failure.result) await out(JSON.stringify({ ...failure.result, ...(usageRecord && { usageRecord }) }) + '\n');
    await err((failure instanceof GeminiError ? failure.message : 'No se pudo completar la operación.') + '\n'); return 1;
  }
}
