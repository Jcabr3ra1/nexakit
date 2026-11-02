import fs from 'node:fs/promises';
import path from 'node:path';

// Only the rollout whose metadata matches this execution can provide provenance.
export async function readRevisionProvenance({ client, executionId, homeDirectory }) {
  if (client !== 'codex' || !/^[A-Za-z0-9_-]{1,128}$/u.test(executionId ?? '') || !homeDirectory) return null;
  const root = path.join(homeDirectory, '.codex', 'sessions');
  let visited = 0;
  const found = [];
  async function scan(dir, depth = 0) {
    if (depth > 4 || ++visited > 10000) return;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
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
      const events = (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
      const meta = events.find(e => e.type === 'session_meta')?.payload;
      if (meta?.id !== executionId || meta.originator !== 'codex_exec') continue;
      const turn = events.findLast(e => e.type === 'turn_context')?.payload;
      if (typeof turn?.model !== 'string' || !turn.model) continue;
      matches.push({ model: turn.model, effort: typeof turn.effort === 'string' ? turn.effort : null, source: 'registro de codex' });
    } catch { /* Missing or incomplete provenance is never a guessed model. */ }
  }
  return matches.length === 1 ? matches[0] : null;
}
