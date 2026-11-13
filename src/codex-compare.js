import fs from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { normalizeMeasurement, summarizeMeasurements, USAGE_COUNTERS } from './usage-metrics.js';

const MAX_SAMPLE_BYTES = 1024 * 1024;
function normalizeSample(sample) {
  if (!sample || typeof sample.task !== 'string' || !sample.task.trim() || sample.task.length > 500 ||
      sample.quality?.passed !== true || !Array.isArray(sample.measurements)) {
    throw new Error('La muestra exige task, quality.passed=true y measurements.');
  }
  const measurements = sample.measurements.map(normalizeMeasurement);
  if (new Set(measurements.map(item => item.id)).size !== measurements.length) {
    throw new Error('Mediciones duplicadas.');
  }
  return { task: sample.task, measurements };
}
const provenance = records => [...new Set(records.map(({ agent, phase, model, source }) =>
  JSON.stringify([agent, phase, model, source])))].sort();

export function compareCodexSamples(beforeSample, afterSample) {
  const before = normalizeSample(beforeSample), after = normalizeSample(afterSample);
  if (before.task !== after.task) throw new Error('Las muestras deben declarar la misma tarea.');
  const comparable = before.measurements.length > 0 && after.measurements.length > 0 &&
    JSON.stringify(provenance(before.measurements)) === JSON.stringify(provenance(after.measurements));
  const beforeSummary = summarizeMeasurements(before.measurements);
  const afterSummary = summarizeMeasurements(after.measurements);
  const counters = Object.fromEntries(USAGE_COUNTERS.map(key => {
    const a = beforeSummary.counters[key], b = afterSummary.counters[key];
    const complete = comparable && a.complete && b.complete;
    return [key, { saved: complete ? a.sum - b.sum : null,
      percent: complete && a.sum > 0 ? (a.sum - b.sum) / a.sum * 100 : null }];
  }));
  return { task: before.task, comparable, before: beforeSummary, after: afterSummary, counters,
    limitations: ['Muestras declaradas; cobertura limitada a llamadas registradas.',
      'La caché es un subconjunto de entrada; no se suma al total.',
      ...(comparable ? [] : ['Procedencia distinta o muestras vacías: ahorro no comparable.'])] };
}

export async function readCodexSample(filename) {
  filename = path.resolve(filename);
  let ancestor = path.dirname(filename);
  while (true) {
    if ((await fs.lstat(ancestor)).isSymbolicLink()) throw new Error('No se admiten enlaces simbólicos en las muestras.');
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const stat = await fs.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SAMPLE_BYTES) throw new Error('Muestra inválida o demasiado grande.');
  const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | constants.O_NONBLOCK);
  try {
    const current = await handle.stat();
    if (!current.isFile() || current.size > MAX_SAMPLE_BYTES || current.ino !== stat.ino || current.dev !== stat.dev) {
      throw new Error('La muestra cambió durante la lectura.');
    }
    const buffer = Buffer.alloc(MAX_SAMPLE_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > MAX_SAMPLE_BYTES) throw new Error('Muestra demasiado grande.');
    return JSON.parse(buffer.subarray(0, size).toString('utf8'));
  } finally { await handle.close(); }
}
