import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { compactarSalida } from '../plugins/nexakit-ahorro/hooks/compactar.js';

const MAX_BYTES = 1024 * 1024;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const blocked = value => ['session_id', 'signal', 'backgroundTaskId'].some(key => key in value)
  || Boolean(value.isError || value.is_error || value.interrupted);
const FAILURE = /(error|fail|falla|✖|✗|not ok|exception|traceback|panic|assert|warn|denied|refused|cannot|no se pudo)/iu;

function responseText(response) {
  if (typeof response === 'string') {
    if (Buffer.byteLength(response, 'utf8') > MAX_BYTES) return null;
    const match = /^(?:(?:Chunk ID: [^\r\n]+|Wall time: [^\r\n]+)\r?\n)*Process exited with code 0\r?\n(?:(?:Wall time: [^\r\n]+|Total output lines: \d+)\r?\n)*Final output:\r?\n([\s\S]*)$/u.exec(response);
    if (match) return { text: match[1], original: response, json: false, exit: 0 };
    // Native Codex can deliver just the model-facing text, without exit status.
    // Never infer success; preserve error-like text and ambiguous/live envelopes.
    if (FAILURE.test(response) || /^(?:Chunk ID:|Wall time:|Process exited|Process running)/u.test(response)) return null;
    return { text: response, original: response, json: false, exit: null };
  }
  if (!object(response) || blocked(response) || response.exit_code !== 0) return null;
  let text;
  if (typeof response.output === 'string' && !('stdout' in response) && !('stderr' in response)) {
    text = response.output;
  } else if (!('output' in response) && typeof response.stdout === 'string' && typeof response.stderr === 'string') {
    text = response.stdout + (response.stderr ? `\n${response.stderr}` : '');
  } else return null;
  return { text, original: JSON.stringify(response), json: true, exit: 0 };
}

function privateFolder(homeDirectory) {
  const home = path.resolve(homeDirectory);
  const target = path.join(home, '.nexakit', 'codex', 'salidas');
  let current = path.parse(target).root;
  for (const part of target.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Unsafe directory');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      fs.mkdirSync(current, { mode: 0o700 });
    }
    if (current === path.join(home, '.nexakit') || current === path.join(home, '.nexakit/codex') || current === target) {
      fs.chmodSync(current, 0o700);
    }
  }
  return target;
}

/** Returns hook JSON only; never executes the command, writes to stdout/stderr,
 * or changes a process exit status. Unsupported inputs and storage errors fail open.
 */
export async function compactCodexToolOutput(payload, options = {}) {
  try {
    if (!object(payload) || payload.hook_event_name !== 'PostToolUse' || payload.tool_name !== 'Bash'
      || payload.isError || payload.is_error || payload.interrupted) return {};
    if ((options.environment ?? process.env).NEXAKIT_SALIDA === 'completa') return {};
    const command = payload.tool_input?.command;
    if (typeof command === 'string' && /^\s*NEXAKIT_SALIDA=completa(?:\s|$)/u.test(command)) return {};
    const response = responseText(payload.tool_response);
    if (!response || Buffer.byteLength(response.original, 'utf8') > MAX_BYTES) return {};
    if (!compactarSalida(response.text).omitidas) return {};
    const home = options.homeDirectory ?? os.homedir();
    const file = path.join(path.resolve(home), '.nexakit', 'codex', 'salidas', `${randomUUID()}.${response.json ? 'json' : 'log'}`);
    const { texto } = compactarSalida(response.text, { ruta: file });
    const status = response.exit === null ? 'desconocido (el hook no recibió el estado; este resumen no acredita éxito)' : '0';
    const result = { continue: false, stopReason: `exit_code: ${status}\n${texto}\nOriginal completo (${response.json ? 'JSON de tool_response' : 'texto exacto de tool_response'}): ${file}` };
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') >= Buffer.byteLength(response.original, 'utf8')) return {};
    privateFolder(home);
    const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1) throw new Error('Unsafe output file');
      fs.fchmodSync(fd, 0o600);
      fs.writeFileSync(fd, response.original, 'utf8');
    } catch (error) {
      // Do not claim an original was saved if writing it failed.
      try { fs.unlinkSync(file); } catch { /* best effort cleanup */ }
      throw error;
    } finally {
      fs.closeSync(fd);
    }
    return result;
  } catch {
    return {};
  }
}
