import fs from 'node:fs/promises';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import schema from '../schemas/generators.schema.json' with { type: 'json' };
import { SIGNAL_LABELS } from './project-signals.js';

const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);
const placeholders = new Set(['dir', 'name', 'python', 'venvBin']);
export class GeneratorsCatalogError extends Error {
  constructor(message) { super(message); this.name = 'GeneratorsCatalogError'; this.code = 'GENERATORS_CATALOG_INVALID'; }
}
const fail = message => { throw new GeneratorsCatalogError(message); };
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function markers(value) {
  // Content may contain ordinary Python/JSON braces; only identifier markers are substituted.
  for (const match of value.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
    if (!placeholders.has(match[1])) fail(`Marcador desconocido: ${match[1]}.`);
  }
}
function stepsFor(generator) {
  return [...generator.steps, ...generator.install,
    ...Object.values(generator.database?.backends ?? {}).flatMap(b => b.install)];
}
export function validateGeneratorsCatalog(value) {
  let copy;
  try { copy = structuredClone(value); } catch { fail('El catálogo debe ser un objeto JSON válido.'); }
  if (!validate(copy)) fail('El catálogo de generadores no cumple el esquema requerido.');
  const ids = new Set();
  for (const g of copy.generators) {
    if (ids.has(g.id)) fail(`Generador duplicado: ${g.id}.`);
    ids.add(g.id);
    if (g.part !== 'database' && !g.signals.length) fail(`Falta una señal en ${g.id}.`);
    for (const s of g.signals) if (!Object.hasOwn(SIGNAL_LABELS, s)) fail(`Señal desconocida: ${s}.`);
    if ((g.part === 'database') !== Boolean(g.database)) fail(`Configuración de base de datos inválida: ${g.id}.`);
    for (const step of stepsFor(g)) {
      if (step.kind === 'write') {
        if (g.id !== 'fastapi') fail('Solo fastapi admite pasos de escritura.');
        if (step.path.includes('\\') || step.path.includes('\0') || path.posix.isAbsolute(step.path)
          || step.path.includes(':') || step.path.split('/').some(p => !p || p === '..' || p === '.')) fail(`Ruta de escritura inválida: ${step.path}.`);
        markers(step.path); markers(step.content);
      } else step.argv.forEach(markers);
    }
    g.check.argv.forEach(markers);
  }
  for (const g of copy.generators) for (const id of Object.keys(g.database?.backends ?? {})) {
    const target = copy.generators.find(e => e.id === id);
    if (!target || !['frontend', 'backend'].includes(target.part)) fail(`Destino de base de datos desconocido: ${id}.`);
  }
  return freeze(copy);
}
export async function loadGeneratorsCatalog({ catalogUrl = new URL('../catalogs/generadores.json', import.meta.url) } = {}) {
  try { return validateGeneratorsCatalog(JSON.parse(await fs.readFile(catalogUrl, 'utf8'))); }
  catch (error) {
    if (error instanceof GeneratorsCatalogError) throw error;
    throw new GeneratorsCatalogError('No se pudo leer el catálogo de generadores.');
  }
}
