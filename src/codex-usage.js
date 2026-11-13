import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const COUNTERS = ['input_tokens', 'cached_input_tokens', 'output_tokens', 'total_tokens'];
const MAX_RECORD_BYTES = 16384;
const MAX_RECORDS = 10000;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;

function metadata(value, required = false) {
  if (value == null && !required) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > 1024 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError('Metadatos de consumo Codex inválidos.');
  }
  return value;
}

function normalize(payload) {
  if (!isObject(payload) || payload.hook_event_name !== 'PostModelRequest') {
    throw new TypeError('Evento de consumo Codex inválido.');
  }
  const usage = isObject(payload.token_usage) ? payload.token_usage : {};
  const input = count(usage.input_tokens);
  const output = count(usage.output_tokens);
  let total = count(usage.total_tokens);
  let cached = count(usage.cached_input_tokens ?? usage.input_tokens_details?.cached_tokens);
  if (input !== null && cached !== null && cached > input) cached = null;
  // This schema treats total as input + output, with cached input included once.
  // A client with another definition needs an explicit schema adapter. Preserve
  // component counts but discard a contradictory total, never invent a repair.
  if (input !== null && output !== null && total !== null && BigInt(total) !== BigInt(input) + BigInt(output)) total = null;
  return {
    hook_event_name: 'PostModelRequest',
    session_id: metadata(payload.session_id, true),
    turn_id: metadata(payload.turn_id),
    agent_id: metadata(payload.agent_id),
    agent_type: metadata(payload.agent_type),
    model: metadata(payload.model),
    status: metadata(payload.status),
    token_usage: {
      input_tokens: input,
      cached_input_tokens: cached,
      output_tokens: output,
      total_tokens: total,
    },
  };
}

// CODEX_HOME configures the client, not NexaKit's private log root. This module
// never reads or writes that directory (including a supplied options.codexHome).
function storageDirectory(options, create) {
  const home = path.resolve(options.homeDirectory ?? os.homedir());
  if (!fs.lstatSync(home).isDirectory()) throw new Error('Directorio de consumo Codex no seguro.');
  let directory = home;
  for (const component of ['.nexakit', 'codex', 'usage']) {
    directory = path.join(directory, component);
    if (create) {
      try { fs.mkdirSync(directory, { mode: 0o700 }); }
      catch (error) { if (error.code !== 'EEXIST') throw new Error('No se pudo crear el registro Codex.'); }
    }
    let stat;
    try { stat = fs.lstatSync(directory); }
    catch (error) {
      if (!create && error.code === 'ENOENT') return null;
      throw new Error('No se pudo acceder al registro Codex.');
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Directorio de consumo Codex no seguro.');
    if (create) fs.chmodSync(directory, 0o700);
  }
  return directory;
}

/** One exclusive JSONL file per received event; never append to shared files.
 * No official request ID exists: repeated turn_id values are neither retries
 * nor duplicates. Re-delivery may therefore count an event twice.
 * Returns the stored, allowlisted record; throws on invalid input/storage errors.
 */
export function recordCodexUsage(payload, options = {}) {
  const normalized = normalize(payload);
  const instant = typeof options.now === 'function' ? options.now() : options.now;
  const date = instant === undefined ? new Date() : new Date(instant);
  if (!Number.isFinite(date.getTime())) throw new TypeError('Fecha de consumo Codex inválida.');
  const record = { version: 1, recorded_at: date.toISOString(), ...normalized };
  const line = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(line) > MAX_RECORD_BYTES) throw new RangeError('Registro de consumo Codex demasiado grande.');
  const directory = storageDirectory(options, true);
  let fd;
  try {
    fd = fs.openSync(path.join(directory, `${randomUUID()}.jsonl`), 'wx', 0o600);
    fs.writeFileSync(fd, line, 'utf8');
  } catch {
    throw new Error('No se pudo guardar el consumo Codex.');
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return record;
}

/** Bounded local snapshot, not live telemetry. Invalid records are skipped.
 * Refuses unsafe directory paths; returns [] if storage has not been created.
 */
export function readCodexUsage(options = {}) {
  const directory = storageDirectory(options, false);
  if (directory === null) return [];
  const records = [];
  let entries = 0;
  const dir = fs.opendirSync(directory);
  try {
    let entry;
    while ((entry = dir.readSync()) !== null) {
      if (++entries > MAX_RECORDS) throw new RangeError('Registro Codex supera el límite de lectura de 10000 archivos.');
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      let fd;
      try {
        fd = fs.openSync(path.join(directory, entry.name), fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | fs.constants.O_NONBLOCK);
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_RECORD_BYTES) continue;
        // Fixed-size read also bounds files that grow after fstat.
        const buffer = Buffer.alloc(MAX_RECORD_BYTES + 1);
        const size = fs.readSync(fd, buffer, 0, buffer.length, 0);
        if (size > MAX_RECORD_BYTES) continue;
        const raw = buffer.subarray(0, size).toString('utf8').trim();
        if (raw.includes('\n')) continue;
        const parsed = JSON.parse(raw);
        if (parsed.version !== 1 || typeof parsed.recorded_at !== 'string' || !Number.isFinite(Date.parse(parsed.recorded_at))) continue;
        records.push({ version: 1, recorded_at: parsed.recorded_at, ...normalize(parsed) });
      } catch {
        // Partial concurrent writes, malformed records and symlinks are ignored.
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
      }
    }
  } finally {
    dir.closeSync();
  }
  return records.sort((a, b) => a.recorded_at.localeCompare(b.recorded_at));
}

function aggregate(records) {
  const token_usage = {};
  const known_counts = {};
  for (const key of COUNTERS) {
    const values = records.map((record) => record.token_usage[key]).filter((value) => value !== null);
    const sum = values.reduce((total, value) => total + BigInt(value), 0n);
    token_usage[key] = values.length && sum <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(sum) : null;
    known_counts[key] = values.length;
  }
  return { requests: records.length, token_usage, known_counts };
}

/** Known sums have per-counter coverage; null means unavailable or overflow.
 * Cached input is already included in input_tokens. No costs are estimated.
 * Attribution is explicit: main type, agent metadata, or unknown; no guessing.
 */
export function summarizeCodexUsage(records) {
  if (!Array.isArray(records) || records.length > MAX_RECORDS) throw new TypeError('Lista de consumo Codex inválida o demasiado grande.');
  const normalized = records.map(normalize);
  const main = [], agents = [], unknown = [];
  const statuses = new Map();
  const models = new Map();
  for (const record of normalized) {
    (record.agent_type === 'main' ? main : record.agent_id !== null || record.agent_type !== null ? agents : unknown).push(record);
    const status = record.status ?? 'unknown';
    const model = record.model ?? 'unknown';
    statuses.set(status, (statuses.get(status) ?? 0) + 1);
    models.set(model, (models.get(model) ?? 0) + 1);
  }
  return {
    ...aggregate(normalized),
    main: aggregate(main), agents: aggregate(agents), unknown: aggregate(unknown),
    statuses: Object.fromEntries(statuses), models: Object.fromEntries(models),
    limitations: [
      'Muestra local de eventos recibidos; no es telemetría viva ni cobertura garantizada de todas las solicitudes.',
      'Sin request id oficial: turn_id no identifica solicitudes, duplicados ni reintentos; cada evento recibido cuenta una vez.',
      'Las sumas incluyen solo contadores conocidos; cached_input_tokens es parte de input_tokens. No se estiman costes.',
      'Si input_tokens y output_tokens son conocidos, un total_tokens incompatible con su suma se marca null; otras definiciones de total requieren un adaptador explícito.',
    ],
  };
}
