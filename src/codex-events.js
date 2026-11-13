import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const MAX_RECORD_BYTES = 16384;
const MAX_ENTRIES = 10000;
const invalidMetadata = () => new TypeError('Metadatos de agentes Codex inválidos.');

function metadata(value, required = false, model = false) {
  if (value == null && !required) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > (model ? 100 : 200) ||
      /[\u0000-\u001f\u007f-\u009f]/u.test(value) ||
      (model && !/^[a-zA-Z0-9][a-zA-Z0-9._:/+-]*$/u.test(value))) {
    throw invalidMetadata();
  }
  return value;
}

function normalize(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload) ||
      !['SubagentStart', 'SubagentStop'].includes(payload.hook_event_name)) throw invalidMetadata();
  return {
    hook_event_name: payload.hook_event_name,
    session_id: metadata(payload.session_id, true),
    agent_id: metadata(payload.agent_id, true),
    agent_type: metadata(payload.agent_type, true),
    model: metadata(payload.model, false, true),
    turn_id: metadata(payload.turn_id),
  };
}

// Check every ancestor, including the supplied home: resolving symlinks would
// silently authorize a different storage location. Only the private suffix is created.
function storageDirectory(options, create) {
  const home = path.resolve(options.homeDirectory ?? os.homedir());
  const root = path.parse(home).root;
  const ancestors = home.slice(root.length).split(path.sep).filter(Boolean);
  let directory = root;
  for (const [index, component] of [...ancestors, '.nexakit', 'codex', 'agents'].entries()) {
    directory = path.join(directory, component);
    const privateDirectory = index >= ancestors.length;
    try {
      if (create && privateDirectory) {
        try { fs.mkdirSync(directory, { mode: 0o700 }); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
      }
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error();
      if (create && privateDirectory) fs.chmodSync(directory, 0o700);
    } catch (error) {
      if (!create && error.code === 'ENOENT') return null;
      throw new Error('Directorio de agentes Codex no seguro.');
    }
  }
  return directory;
}

/** One private, exclusive JSONL file per event. No payload content is persisted. */
export function recordCodexAgentEvent(payload, options = {}) {
  const normalized = normalize(payload);
  const instant = typeof options.now === 'function' ? options.now() : options.now;
  const date = instant === undefined ? new Date() : new Date(instant);
  if (!Number.isFinite(date.getTime())) throw new TypeError('Fecha de agentes Codex inválida.');
  const record = { version: 1, recorded_at: date.toISOString(), ...normalized };
  const directory = storageDirectory(options, true);
  let fd;
  try {
    fd = fs.openSync(path.join(directory, `${randomUUID()}.jsonl`), 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(record)}\n`, 'utf8');
  } catch {
    throw new Error('No se pudo guardar el evento de agentes Codex.');
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return record;
}

/** Bounded snapshot: malformed/unsafe files are skipped; exceeded limits throw. */
export function readCodexAgentEvents(options = {}) {
  const directory = storageDirectory(options, false);
  if (directory === null) return [];
  const records = [];
  const dir = fs.opendirSync(directory);
  let entries = 0;
  try {
    let entry;
    while ((entry = dir.readSync()) !== null) {
      if (++entries > MAX_ENTRIES) throw new RangeError('Registro de agentes Codex supera 10000 entradas.');
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      let fd;
      try {
        const file = path.join(directory, entry.name);
        const before = fs.lstatSync(file);
        if (!before.isFile() || before.nlink !== 1) continue;
        fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || before.dev !== stat.dev || before.ino !== stat.ino) continue;
        if (stat.size > MAX_RECORD_BYTES) throw new RangeError('Registro de agentes Codex supera 16KiB.');
        // One extra byte detects growth since fstat without unbounded allocation.
        const buffer = Buffer.alloc(MAX_RECORD_BYTES + 1);
        const size = fs.readSync(fd, buffer, 0, buffer.length, 0);
        if (size > MAX_RECORD_BYTES) throw new RangeError('Registro de agentes Codex supera 16KiB.');
        const after = fs.lstatSync(file);
        if (!after.isFile() || after.nlink !== 1 || after.dev !== stat.dev || after.ino !== stat.ino) continue;
        const raw = buffer.subarray(0, size).toString('utf8').trim();
        if (raw.includes('\n')) continue;
        const parsed = JSON.parse(raw);
        if (parsed?.version !== 1 || typeof parsed.recorded_at !== 'string' || !Number.isFinite(Date.parse(parsed.recorded_at))) continue;
        records.push({ version: 1, recorded_at: parsed.recorded_at, ...normalize(parsed) });
      } catch (error) {
        if (error instanceof RangeError) throw error;
        // Partial concurrent writes, malformed records and unsafe files are ignored.
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
      }
    }
  } finally {
    dir.closeSync();
  }
  return records.sort((a, b) => Date.parse(a.recorded_at) - Date.parse(b.recorded_at));
}
