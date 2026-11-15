import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeMeasurement } from './usage-metrics.js';

// Registro propio del consumo de Gemini: ~/.agent-toolkit/gemini/consumo.jsonl.
// Una línea por consulta, solo contadores declarados por el cliente; sin prompts ni respuestas.
export const geminiHome = () => process.env.AGENT_TOOLKIT_GEMINI_DIR ?? path.join(os.homedir(), '.agent-toolkit', 'gemini');

export function createGeminiUsageStore({ directory = geminiHome(), now = () => new Date() } = {}) {
  async function recordUsage(measurement) {
    const normalized = normalizeMeasurement(measurement);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const folder = await fs.lstat(directory);
    if (!folder.isDirectory() || folder.isSymbolicLink()) throw new Error('Carpeta de consumo insegura.');
    const target = path.join(directory, 'consumo.jsonl');
    try {
      const stat = await fs.lstat(target);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Registro inseguro.');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const handle = await fs.open(target, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0), 0o600);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1) throw new Error('Registro inseguro.');
      await handle.chmod(0o600);
      await handle.appendFile(JSON.stringify({ ...normalized, at: now().toISOString() }) + '\n', 'utf8');
    } finally { await handle.close(); }
    return { recorded: true, id: normalized.id };
  }
  return Object.freeze({ recordUsage });
}
