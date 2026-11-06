import fs from 'node:fs/promises';
import path from 'node:path';
import { gitTopLevel, runGit as defaultRunGit } from './project-root.js';

const ignoredEntries = new Set(['.git', '.DS_Store', 'Thumbs.db']);
export async function inspectFolder(dir, { runGit = defaultRunGit } = {}) {
  const root = await fs.realpath(dir);
  const entries = (await fs.readdir(root)).sort();
  return { empty: entries.every(name => ignoredEntries.has(name)), insideGit: Boolean(await gitTopLevel(root, runGit)), entries };
}
export function projectName(dir) {
  const normalized = path.basename(dir).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 214).replace(/-+$/g, '');
  return normalized || 'proyecto';
}

// Pure plan: cwd and write paths are relative to the selected project root.
// The executor (a later task) owns venv creation, confinement and exclusive writes.
export function planCleanProject({ choice, catalog, name, platform = process.platform }) {
  if (!choice || typeof choice !== 'object' || Array.isArray(choice)) throw new Error('Elección de proyecto inválida.');
  const order = ['frontend', 'backend', 'mobile'];
  for (const part of Object.keys(choice)) if (![...order, 'database'].includes(part)) throw new Error(`Parte desconocida: ${part}.`);
  const selected = {};
  for (const part of [...order, 'database']) {
    if (choice[part] == null) continue;
    const generator = catalog.generators.find(g => g.id === choice[part] && g.part === part);
    if (!generator) throw new Error(`Elección inválida para ${part}.`);
    selected[part] = generator;
  }
  const database = selected.database;
  if (database && database.id !== 'supabase' && !selected.backend) throw new Error('Esta base de datos necesita un backend.');
  const hostPart = database?.id === 'supabase' && selected.frontend ? 'frontend' : 'backend';
  if (database && !selected[hostPart]) throw new Error('La base de datos necesita un frontend o backend.');
  const hostConfig = database?.database.backends[selected[hostPart]?.id];
  if (database && !hostConfig) throw new Error('La base de datos no admite la parte elegida.');
  const count = order.filter(part => selected[part]).length;
  const venvBin = platform === 'win32' ? '.venv\\Scripts' : '.venv/bin';
  const python = platform === 'win32' ? `${venvBin}\\python.exe` : `${venvBin}/python`;
  const normalizedName = projectName(name);
  const parts = order.filter(part => selected[part]).map(part => {
    const g = selected[part], dir = count === 1 ? '.' : part === 'mobile' ? 'movil' : part;
    const substitutions = { dir, name: normalizedName, python, venvBin };
    const expand = value => value.replace(/\{(dir|name|python|venvBin)\}(\/)?/g, (_, key, slash) =>
      substitutions[key] + (slash ? key === 'venvBin' && platform === 'win32' ? '\\' : '/' : ''));
    const commands = [], writes = [];
    const append = (steps, root = false) => {
      for (const step of steps) {
        if (step.kind === 'run') commands.push({ argv: step.argv.map(expand), cwd: root || step.cwd === 'parent' ? '.' : dir });
        else writes.push({ path: path.posix.join(dir, expand(step.path)), content: expand(step.content) });
      }
    };
    append(g.steps); append(g.install);
    if (database && part === hostPart) {
      append(database.steps, true); append(database.install, true); append(hostConfig.install);
      if (hostConfig.envExample) writes.push({ path: path.posix.join(dir, '.env.example'), content: expand(hostConfig.envExample) });
    }
    return { part, id: g.id, dir, commands, writes, check: { argv: g.check.argv.map(expand), cwd: dir } };
  });
  const pythonUsed = Object.values(selected).some(g => g.requires.some(r => r.program === 'python'));
  return { parts, gitignore: [...(pythonUsed ? ['.venv/'] : []), '.env'] };
}
