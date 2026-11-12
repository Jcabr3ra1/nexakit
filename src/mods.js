// The mods are nexakit's own Claude Code plugins (marketplace agent-toolkit). Like Superpowers, nexakit only lists,
// installs, enables or updates them through `claude plugin ...` and never edits plugin folders by hand.
import fs from 'node:fs';
import path from 'node:path';
import { SUPERPOWERS, defaultRunner } from './superpowers.js';

const MARKETPLACE = 'agent-toolkit';
const REPOSITORY = 'Jcabr3ra1/nexakit';
const COMMAND = 'claude';

const mod = (name, label) => Object.freeze({ name, id: `${name}@${MARKETPLACE}`, label });
export const MODS = Object.freeze([
  mod('niveles', 'Subagentes por nivel para delegar'),
  mod('nexakit-modelo', 'Barra con modelo, esfuerzo y consejo'),
  mod('nexakit-ahorro', 'Recorta la salida larga de comandos'),
  mod('nexakit-lecciones', 'Frena errores y guarda correcciones'),
  mod('nexakit-sesion', 'Avisa cuándo abrir una sesión nueva'),
]);

const allUnknown = () => Object.fromEntries(MODS.map((item) => [item.name, 'desconocido']));

function localVersion(name, toolkitRoot) {
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(toolkitRoot, 'plugins', name, '.claude-plugin', 'plugin.json'), 'utf8'),
    );
    return typeof manifest.version === 'string' ? manifest.version : null;
  } catch {
    return null;
  }
}

// name -> 'activo' | 'desactivado' | 'falta' | 'actualizable' | 'desconocido'. A list that cannot be read makes
// every mod unknown, never missing, so nexakit does not install over something it did not understand.
export function parseModsState(result, toolkitRoot) {
  if (!result || result.status !== 0) return allUnknown();
  let plugins;
  try {
    plugins = JSON.parse(String(result.stdout ?? ''));
  } catch {
    return allUnknown();
  }
  if (!Array.isArray(plugins)) plugins = plugins?.plugins;
  if (!Array.isArray(plugins)) return allUnknown();
  const states = {};
  for (const item of MODS) {
    const entry = plugins.find((plugin) => plugin?.id === item.id);
    if (!entry) states[item.name] = 'falta';
    else if (entry.enabled === false) states[item.name] = 'desactivado';
    else {
      const wanted = localVersion(item.name, toolkitRoot);
      states[item.name] = wanted && entry.version !== wanted ? 'actualizable' : 'activo';
    }
  }
  return states;
}

export async function inspectMods({ agentsFound, runCommand, environment, toolkitRoot } = {}) {
  if (!agentsFound?.claude) return null;
  const run = runCommand ?? (await defaultRunner(COMMAND, environment));
  let result;
  try {
    result = await run(COMMAND, SUPERPOWERS.claude.list);
  } catch {
    result = null;
  }
  return parseModsState(result, toolkitRoot);
}

const detailOf = (output) => String(output?.stderr || output?.stdout || output?.errorCode || '').trim();

export async function applyMod(name, state, { runCommand, environment } = {}) {
  const item = MODS.find((entry) => entry.name === name);
  if (!item) throw new Error(`Mod desconocido: ${name}`);
  const verb = { falta: 'install', desactivado: 'enable', actualizable: 'update' }[state];
  if (!verb) return false;
  const run = runCommand ?? (await defaultRunner(COMMAND, environment));
  const args = ['plugin', verb, item.id];
  let result = await run(COMMAND, args);
  if (result?.status !== 0 && state === 'falta' && SUPERPOWERS.claude.marketplace.missing.test(detailOf(result))) {
    const prepared =
      (await run(COMMAND, ['plugin', 'marketplace', 'add', REPOSITORY]))?.status === 0 ||
      (await run(COMMAND, ['plugin', 'marketplace', 'update', MARKETPLACE]))?.status === 0;
    if (prepared) result = await run(COMMAND, args);
  }
  if (result?.status !== 0) {
    const detail = detailOf(result);
    const action = { falta: 'instalar', desactivado: 'activar', actualizable: 'actualizar' }[state];
    throw new Error(`No se pudo ${action} el mod ${name}.${detail ? ` ${detail}` : ''}`);
  }
  return true;
}
