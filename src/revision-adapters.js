import { resolveCliInvocation } from './cli-executable.js';

const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
export async function buildRevisionInvocation({
  client,
  model,
  effort,
  root,
  environment = process.env,
  resolve = resolveCliInvocation,
}) {
  if (
    !['claude', 'codex', 'antigravity'].includes(client) ||
    typeof model !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u.test(model) ||
    !EFFORTS.has(effort)
  )
    throw new Error('Revisor, modelo o esfuerzo inválido.');
  const cli = await resolve({ name: client === 'antigravity' ? 'agy' : client, environment });
  let args;
  if (client === 'codex')
    args = [
      'exec',
      '--model',
      model,
      '-c',
      `model_reasoning_effort="${effort}"`,
      '-c',
      'approval_policy="never"',
      '-c',
      'mcp_servers={}',
      '--disable',
      'apps',
      '--sandbox',
      'read-only',
      '--json',
      '--ignore-user-config',
      '-C',
      root,
      '-',
    ];
  else if (client === 'claude')
    args = [
      '-p',
      '--model',
      model,
      '--effort',
      effort,
      '--strict-mcp-config',
      '--allowedTools',
      'Read,Glob,Grep',
      '--disallowedTools',
      'Edit,Write,NotebookEdit,Bash',
      '--output-format',
      'json',
      '--no-session-persistence',
    ];
  else
    args = [
      '--print=',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--model',
      model,
      '--effort',
      effort,
      '--mode',
      'plan',
      '--sandbox',
    ];
  return {
    executable: cli.executable,
    args: [...cli.argsPrefix, ...args],
    env: { ...environment },
    cwd: root,
    inputFormat: client === 'antigravity' ? 'stream-json' : 'text',
  };
}

const count = (n) => (Number.isSafeInteger(n) && n >= 0 ? n : null);
const usageOf = (u = {}) => ({
  inputTokens: count(u.input_tokens ?? u.inputTokens),
  outputTokens: count(u.output_tokens ?? u.outputTokens),
  cachedInputTokens: count(
    u.cached_input_tokens ?? u.cache_read_tokens ?? u.cache_read_input_tokens ?? u.cacheReadInputTokens,
  ),
  cacheCreationTokens: count(u.cache_creation_input_tokens ?? u.cacheCreationInputTokens),
  thinkingTokens: count(u.thinking_tokens ?? u.output_tokens_details?.thinking_tokens ?? u.thinkingTokens),
});
const optionalText = (value) => (typeof value === 'string' && value ? value : null);
export function parseRevisionOutput(client, stdout) {
  let data;
  try {
    if (client === 'codex') {
      const events = stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      if (events.some((e) => ['error', 'turn.failed'].includes(e.type))) throw new Error();
      const turn = events.findLast((e) => e.type === 'turn.completed');
      const report = events
        .filter((e) => e.type === 'item.completed' && e.item?.type === 'agent_message')
        .map((e) => e.item.text)
        .join('\n');
      if (!report.trim()) throw new Error('El revisor no devolvió informe');
      if (!turn) throw new Error();
      return {
        report,
        executionId: optionalText(events.find((e) => e.type === 'thread.started')?.thread_id),
        usage: usageOf(turn.usage),
        reportedModel: null,
        reportedEffort: null,
      };
    }
    if (!['claude', 'antigravity'].includes(client)) throw new Error();
    if (client === 'antigravity' && stdout.trim().includes('\n')) {
      const events = stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      data = events.findLast((e) => e.event === 'result')?.result;
      const init = events.find((e) => e.event === 'init')?.init;
      if (data && init?.model) data = { ...data, model: init.model };
    } else data = JSON.parse(stdout);
    if (
      !data ||
      data.is_error ||
      data.status === 'ERROR' ||
      data.denied_actions?.length ||
      data.permission_denials?.length
    )
      throw new Error();
    const report = client === 'claude' ? data.result : data.response;
    if (typeof report !== 'string' || !report.trim()) throw new Error('El revisor no devolvió informe');
    const models = Object.entries(data.modelUsage ?? {});
    const modelData = models.length === 1 ? models[0][1] : null;
    return {
      report,
      executionId: optionalText(data.session_id ?? data.conversation_id),
      usage: usageOf(data.usage ?? modelData ?? {}),
      reportedModel: optionalText(
        data.model ?? modelData?.canonicalModel ?? (models.length === 1 ? models[0][0] : null),
      ),
      reportedEffort: optionalText(data.effort),
    };
  } catch (error) {
    if (error.message === 'El revisor no devolvió informe') throw error;
    throw new Error('Salida del revisor inválida, incompleta o con acciones denegadas.');
  }
}
