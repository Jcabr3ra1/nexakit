// Superpowers (obra/superpowers, MIT) is required: it carries the work process (brainstorming, plans, debugging,
// TDD, verification). Each agent installs it from the marketplace reviewed for it; nexakit only lists, installs or
// enables it through the agent's own CLI and never edits plugin folders by hand.
import { spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveCliInvocation } from './cli-executable.js';
import { IS_WINDOWS } from './platform.js';

export const SUPERPOWERS = Object.freeze({
  claude: Object.freeze({
    command: 'claude',
    id: 'superpowers@claude-plugins-official',
    list: ['plugin', 'list', '--json'],
    install: ['plugin', 'install', 'superpowers@claude-plugins-official'],
    enable: ['plugin', 'enable', 'superpowers@claude-plugins-official'],
    // A HOME where Claude Code never opened only has the built-in directory: the reviewed marketplace has to be
    // added (or refreshed, when its local copy is old) before the plugin can be found.
    marketplace: Object.freeze({
      missing: /not found in marketplace|marketplace\b.*\bnot found/iu,
      add: ['plugin', 'marketplace', 'add', 'anthropics/claude-plugins-official'],
      update: ['plugin', 'marketplace', 'update', 'claude-plugins-official'],
    }),
  }),
  codex: Object.freeze({
    command: 'codex',
    id: 'superpowers@openai-curated-remote',
    list: ['plugin', 'list'],
    install: ['plugin', 'add', 'superpowers@openai-curated-remote'],
    // `codex plugin` has no enable: a disabled plugin is turned on from Codex itself (/plugins).
    enable: null,
  }),
  antigravity: Object.freeze({
    command: 'agy',
    id: 'superpowers@antigravity-plugins-partners',
    list: ['plugin', 'list', '--json'],
    install: ['plugin', 'install', 'superpowers@antigravity-plugins-partners'],
    enable: ['plugin', 'enable', 'superpowers'],
  }),
});

const TIMEOUT_MS = 120_000;
const AGENT_NAMES = { claude: 'Claude Code', codex: 'Codex', antigravity: 'Antigravity' };

// 'activo' | 'desactivado' | 'falta' | 'desconocido'. Anything that cannot be read is unknown, never missing,
// so nexakit does not try to install over a list it did not understand.
export function parseSuperpowersState(agent, result) {
  if (!result || result.status !== 0) return 'desconocido';
  const text = String(result.stdout ?? '');
  if (agent === 'codex') {
    const row = text.split(/\r?\n/u).find((line) => /^superpowers@\S+\s/u.test(line.trim()));
    if (!row) return 'desconocido';
    if (/\bnot installed\b/u.test(row)) return 'falta';
    if (/\bdisabled\b/u.test(row)) return 'desactivado';
    return /\benabled\b/u.test(row) ? 'activo' : 'desconocido';
  }
  if (agent === 'antigravity' && /^\s*No plugins installed\.?\s*$/iu.test(text)) return 'falta';
  let list;
  try {
    list = JSON.parse(text);
  } catch {
    return 'desconocido';
  }
  if (!Array.isArray(list)) list = list?.plugins;
  if (!Array.isArray(list)) return 'desconocido';
  const entry = list.find((item) =>
    agent === 'claude' ? item?.id === SUPERPOWERS.claude.id : item?.name === 'superpowers',
  );
  if (!entry) return 'falta';
  return entry.enabled === false ? 'desactivado' : 'activo';
}

function spawnCommand(command, args) {
  // `codex plugin list` prints every remote marketplace (about 2 MB), above the 1 MB default buffer.
  const result = spawnSync(command, args, { encoding: 'utf8', shell: false, timeout: TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', errorCode: result.error?.code };
}

const notFound = () => ({ status: null, stdout: '', stderr: '', errorCode: 'ENOENT' });

// The CLI is looked up in the given environment's PATH, not this process's, so a test HOME never reaches the
// person's real agents.
export async function defaultRunner(command, environment = process.env) {
  if (!IS_WINDOWS) {
    for (const folder of (environment.PATH ?? '').split(path.delimiter).filter(Boolean)) {
      const file = path.join(folder, command);
      try {
        await fs.access(file, constants.X_OK);
        if ((await fs.stat(file)).isFile()) return (_command, args) => spawnCommand(file, args);
      } catch {}
    }
    return notFound;
  }
  try {
    const invocation = await resolveCliInvocation({ name: command, environment });
    return (_command, args) => spawnCommand(invocation.executable, [...invocation.argsPrefix, ...args]);
  } catch {
    return notFound;
  }
}

export async function inspectSuperpowers({ agentsFound, runCommand, environment } = {}) {
  const states = {};
  for (const agent of Object.keys(SUPERPOWERS)) {
    if (!agentsFound?.[agent]) continue;
    const { command, list } = SUPERPOWERS[agent];
    const run = runCommand ?? (await defaultRunner(command, environment));
    let result;
    try {
      result = await run(command, list);
    } catch {
      result = null;
    }
    states[agent] = parseSuperpowersState(agent, result);
  }
  return states;
}

// The command a person can run by hand, for messages.
export function superpowersCommand(agent, state) {
  const entry = SUPERPOWERS[agent];
  const args = state === 'desactivado' ? entry.enable : entry.install;
  return args ? `${entry.command} ${args.join(' ')}` : null;
}

export async function applySuperpowers(agent, state, { runCommand, environment } = {}) {
  const entry = SUPERPOWERS[agent];
  if (!entry) throw new Error(`Agente desconocido: ${agent}`);
  if (state !== 'falta' && state !== 'desactivado') return false;
  const args = state === 'falta' ? entry.install : entry.enable;
  if (!args) throw new Error(`Superpowers está desactivado en ${AGENT_NAMES[agent]}; actívalo desde ${AGENT_NAMES[agent]} (/plugins).`);
  const run = runCommand ?? (await defaultRunner(entry.command, environment));
  const detailOf = (output) => String(output?.stderr || output?.stdout || output?.errorCode || '').trim();
  let result = await run(entry.command, args);
  if (result?.status !== 0 && state === 'falta' && entry.marketplace?.missing.test(detailOf(result))) {
    const prepared =
      (await run(entry.command, entry.marketplace.add))?.status === 0 ||
      (await run(entry.command, entry.marketplace.update))?.status === 0;
    if (prepared) result = await run(entry.command, args);
  }
  if (result?.status !== 0) {
    const detail = detailOf(result);
    throw new Error(`No se pudo ${state === 'falta' ? 'instalar' : 'activar'} Superpowers en ${AGENT_NAMES[agent]}.${detail ? ` ${detail}` : ''}`);
  }
  return true;
}
