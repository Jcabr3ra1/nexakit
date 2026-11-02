import fs from 'node:fs/promises';
import path from 'node:path';

// Only the rollout whose metadata matches this execution can provide provenance.
async function executionEvents({ executionId, homeDirectory }) {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(executionId ?? '') || !homeDirectory) return null;
  const root = path.join(homeDirectory, '.codex', 'sessions');
  let visited = 0;
  const found = [];
  async function scan(dir, depth = 0) {
    if (depth > 4 || ++visited > 10000) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (e) {
      if (e.code === 'ENOENT') return;
      throw e;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await scan(full, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(`-${executionId}.jsonl`)) found.push(full);
    }
  }
  await scan(root);
  const matches = [];
  for (const file of found) {
    try {
      if ((await fs.lstat(file)).size > 16 * 1024 * 1024) continue;
      const events = (await fs.readFile(file, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      const meta = events.find((e) => e.type === 'session_meta')?.payload;
      if (meta?.id !== executionId || meta.originator !== 'codex_exec') continue;
      matches.push(events);
    } catch {
      /* Missing or incomplete provenance is never a guessed model. */
    }
  }
  return matches.length === 1 ? matches[0] : null;
}

export async function readRevisionProvenance(options) {
  if (options.client !== 'codex') return null;
  const events = await executionEvents(options);
  const turn = events?.findLast((e) => e.type === 'turn_context')?.payload;
  return typeof turn?.model === 'string' && turn.model
    ? {
        model: turn.model,
        effort: typeof turn.effort === 'string' ? turn.effort : null,
        source: 'registro de codex',
      }
    : null;
}
export async function readCodexProbeDenial(options) {
  const events = await executionEvents(options);
  function denied(value, depth = 0) {
    if (depth > 12 || value === null || value === undefined) return false;
    if (typeof value === 'string') {
      try {
        return denied(JSON.parse(value), depth + 1);
      } catch {
        return false;
      }
    }
    if (Array.isArray(value)) return value.some((x) => denied(x, depth + 1));
    if (typeof value === 'object') {
      if (
        Number.isInteger(value.exit_code) &&
        value.exit_code !== 0 &&
        typeof value.output === 'string' &&
        /operation not permitted|permission denied|read-only/iu.test(value.output)
      )
        return true;
      return Object.values(value).some((x) => denied(x, depth + 1));
    }
    return false;
  }
  return (
    events?.some(
      (e) =>
        e.type === 'response_item' &&
        ['function_call_output', 'custom_tool_call_output'].includes(e.payload?.type) &&
        denied(e.payload.output),
    ) ?? false
  );
}
