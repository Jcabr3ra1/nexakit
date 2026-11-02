import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { parseTOML, getStaticTOMLValue } from 'toml-eslint-parser';
import { IS_WINDOWS } from './platform.js';
import { acquireLock } from './install-lock.js';
import { isRegistered, readRegistry, recordEntries } from './install-registry.js';
import {
  ACTIONABLE_LINK_STATES,
  chooseActiveRoot,
  classifyLink,
  classifyReference,
  isEphemeralPath,
  legacyGroups,
  relinkIfUnchanged,
} from './link-states.js';
import { actualRoot, ensureStableInstall, nexakitDir } from './stable-install.js';

import packageJson from '../package.json' with { type: 'json' };

// The package declares a simple major-version floor (>=24).
const minimumNodeMajor = Number(packageJson.engines.node.match(/^>=(\d+)$/u)[1]);
export const isNodeSupported = (version) =>
  Number(version.replace(/^v/u, '').split('.')[0]) >= minimumNodeMajor;

export const TOOLKIT_ROOT = fileURLToPath(new URL('../', import.meta.url));
const SKILL_HOMES = {
  codex: ['.agents', 'skills'],
  claude: ['.claude', 'skills'],
  antigravity: ['.gemini', 'antigravity-cli', 'skills'],
};
// Only Claude and Codex run the coordination MCP; Antigravity does not have one in this phase.
const MCP_CLIENTS = ['codex', 'claude'];
const MCP_SUFFIX = 'bin/agent-toolkit-mcp.js';
const COMMANDS = { codex: 'codex', claude: 'claude', antigravity: 'agy' };
export const globalSkillTarget = (home, client, name) => path.join(home, ...SKILL_HOMES[client], name);
// Registry key of an MCP entry: it has no path of its own in the home folder.
export const mcpRegistryTarget = (client, name) => `mcp:${client}:${name}`;

// `all` means Claude and Codex, plus Antigravity when `agy` is installed or its folder already exists:
// nothing is created for someone who does not use it.
async function clientsFor(agent, environment, home) {
  if (!['codex', 'claude', 'antigravity', 'all'].includes(agent))
    throw new Error('El agente debe ser codex, claude, antigravity o all.');
  if (agent !== 'all') return [agent];
  const antigravity =
    (await executable('agy', environment)) ||
    Boolean(await stat(path.join(home, '.gemini', 'antigravity-cli')));
  return antigravity ? ['codex', 'claude', 'antigravity'] : ['codex', 'claude'];
}
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
const stat = (file) =>
  fs.lstat(file).catch((e) => {
    if (e.code === 'ENOENT') return null;
    throw e;
  });

// Links point at the root in use, except when it is an npx cache: then they point at the stable copy.
export async function resolveRoots({ toolkitRoot, homeDirectory }) {
  const sourceRoot = await fs.realpath(toolkitRoot);
  const ephemeral = isEphemeralPath(sourceRoot);
  return { sourceRoot, linkRoot: ephemeral ? actualRoot(homeDirectory) : sourceRoot, ephemeral };
}
// A node inside an npx cache disappears with it, so it is never the one registered, not even through a link.
const outsideNpxCache = async (file) =>
  !isEphemeralPath(file) && !isEphemeralPath(await fs.realpath(file).catch(() => file));
export async function resolveNodeExecutable(environment) {
  const stable = await findExecutable('node', environment, outsideNpxCache);
  if (stable) return stable;
  return (await outsideNpxCache(process.execPath)) ? process.execPath : 'node';
}
async function baseSkillNames(root) {
  const names = (await fs.readdir(path.join(root, 'skills'), { withFileTypes: true }))
    .filter((e) => e.isDirectory() && /^[a-z0-9-]+$/u.test(e.name))
    .map((e) => e.name)
    .sort();
  for (const name of names) {
    const file = await stat(path.join(root, 'skills', name, 'SKILL.md'));
    if (!file?.isFile() || file.isSymbolicLink()) throw new Error('Skill fuente inválida.');
  }
  return names;
}
async function catalogNames(root) {
  try {
    return JSON.parse(await fs.readFile(path.join(root, 'catalogs/skills.json'), 'utf8')).skills.map(
      (s) => s.name,
    );
  } catch {
    return [];
  }
}
export async function packageVersion(root) {
  return JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
}
async function parents(home, target, create = false) {
  let current = home;
  for (const part of path.relative(home, path.dirname(target)).split(path.sep)) {
    current = path.join(current, part);
    let info = await stat(current);
    if (!info && create) {
      await fs.mkdir(current, { mode: 0o700 }).catch((e) => {
        if (e.code !== 'EEXIST') throw e;
      });
      info = await stat(current);
    }
    if (info && (!info.isDirectory() || info.isSymbolicLink()))
      throw new Error('Un directorio de instalación está ocupado o es un enlace.');
  }
}
export function registrationCommand(client, current, nodePath, entry) {
  const add =
    client === 'codex'
      ? `codex mcp add agent-toolkit-workflow -- ${quote(nodePath)} ${quote(entry)}`
      : `claude mcp add --scope user --transport stdio agent-toolkit-workflow -- ${quote(nodePath)} ${quote(entry)}`;
  if (current.state === 'falta') return add;
  // Moving or repairing an existing entry: remove it first under the name it has now.
  return `${client === 'codex' ? `codex mcp remove ${current.name}` : `claude mcp remove ${current.name} -s user`} && ${add}`;
}

// Classifies every global skill link and the coordination MCP, and with `apply` creates what is missing and
// moves or repairs only what nexakit can prove is its own. Conflicts are skipped and reported, never replaced.
export async function setupToolkit({
  agent = 'all',
  apply = false,
  homeDirectory = os.homedir(),
  toolkitRoot = TOOLKIT_ROOT,
  environment = process.env,
  codexHome = environment.CODEX_HOME ?? path.join(homeDirectory, '.codex'),
  codexProfile,
  runNpm,
  packageSpec,
  lockOptions,
  acquire = acquireLock,
} = {}) {
  const home = await fs.realpath(homeDirectory);
  const clients = await clientsFor(agent, environment, home);
  const { sourceRoot, linkRoot, ephemeral } = await resolveRoots({ toolkitRoot, homeDirectory: home });
  const names = await baseSkillNames(sourceRoot);
  const registry = await readRegistry(nexakitDir(home));
  const isOwned = (target, literal) => isRegistered(registry, target, literal);
  const activeRoots = [linkRoot, sourceRoot, actualRoot(home)];
  const retiredSkills = [];
  for (const client of clients)
    for (const name of ['programar', 'estado']) {
      const target = globalSkillTarget(home, client, name);
      await parents(home, target);
      const info = await stat(target);
      if (!info) continue;
      const literal = info.isSymbolicLink() ? await fs.readlink(target) : null;
      retiredSkills.push({
        client,
        name,
        target,
        literal,
        owned: Boolean(literal && isOwned(target, literal)),
      });
    }

  const skills = [];
  for (const client of clients)
    for (const name of names) {
      const target = globalSkillTarget(home, client, name);
      await parents(home, target);
      const { suffix, ...state } = await classifyLink({
        target,
        suffix: `skills/${name}`,
        activeRoots,
        isOwned,
      });
      skills.push({ client, name, ...state });
    }

  // Origins are never mixed: if most links already use another valid copy, that copy stays the root to link to.
  const activeRoot = chooseActiveRoot(skills, linkRoot);
  const usingOtherCopy = activeRoot !== linkRoot;
  const missingInActive = [];
  if (usingOtherCopy) {
    for (const name of names)
      if (!(await stat(path.join(activeRoot, 'skills', name, 'SKILL.md')))) missingInActive.push(name);
  }
  for (const item of skills) item.source = path.join(activeRoot, 'skills', item.name);

  const mcpStates = {};
  for (const client of clients.filter((c) => MCP_CLIENTS.includes(c))) {
    mcpStates[client] = await inspectMcp(client, home, codexHome, { activeRoots, isOwned });
  }
  const mcpDeadRoot = Object.values(mcpStates).find((s) => s.state === 'roto-ajeno')?.root;
  const legacy = legacyGroups(skills, {
    skillNames: new Set([...names, ...(await catalogNames(sourceRoot))]),
    mcpDeadRoot,
  });

  const pending = skills.filter(
    (s) => ACTIONABLE_LINK_STATES.includes(s.state) && !missingInActive.includes(s.name),
  );
  const mcpPending = Object.keys(mcpStates).filter((client) =>
    ACTIONABLE_LINK_STATES.includes(mcpStates[client].state),
  );
  let applied = false,
    changed = 0,
    created = 0,
    stableInstall;
  if (apply) {
    const lock = await acquire(nexakitDir(home), lockOptions);
    try {
      if (ephemeral && !usingOtherCopy && (pending.length || mcpPending.length)) {
        stableInstall = await ensureStableInstall({
          homeDirectory: home,
          version: await packageVersion(sourceRoot),
          lock,
          ...(runNpm && { runNpm }),
          ...(packageSpec && { packageSpec }),
        });
      }
      for (const item of retiredSkills.filter((s) => s.owned)) {
        await lock.assertHeld();
        const current = await stat(item.target);
        if (current?.isSymbolicLink() && (await fs.readlink(item.target)) === item.literal)
          await fs.unlink(item.target);
      }
      const entries = [];
      for (const item of pending) {
        await parents(home, item.target, true);
        await lock.assertHeld();
        const outcome = await relinkIfUnchanged({
          target: item.target,
          expectedLiteral: item.state === 'falta' ? null : item.literal,
          source: item.source,
        });
        if (outcome === 'cambio') {
          changed++;
          continue;
        }
        // The registry keeps what readlink returns, the value later compared.
        const literal = await fs.readlink(item.target);
        entries.push({ destino: item.target, apunta: literal, raiz: activeRoot });
        Object.assign(item, { state: 'instalado', literal, root: activeRoot });
      }
      await recordEntries(nexakitDir(home), entries, lock);
      created = entries.length;
      applied = true;
    } finally {
      await lock.release();
    }
  }

  // A command is only suggested once the script it registers exists (after the stable copy is in place).
  const nodePath = await resolveNodeExecutable(environment);
  const entry = path.join(activeRoot, MCP_SUFFIX);
  const entryExists = Boolean(await stat(entry));
  const registrationCommands = {},
    registrationPending = [];
  for (const client of mcpPending) {
    if (entryExists)
      registrationCommands[client] = registrationCommand(client, mcpStates[client], nodePath, entry);
    else registrationPending.push(client);
  }

  const obsolete = Object.entries(mcpStates)
    .filter(([, state]) => state.name)
    .map(([client, state]) => ({
      message: 'Ya no se usa; si quieres quitarlo:',
      command:
        client === 'codex' ? `codex mcp remove ${state.name}` : `claude mcp remove ${state.name} -s user`,
    }));
  const agentsPath = path.join(codexHome, 'agents');
  for (const name of await fs.readdir(agentsPath).catch(() => [])) {
    if (!/^nivel-(ligero|normal|exigente|alto)\.(toml|md)$/u.test(name)) continue;
    const file = path.join(agentsPath, name);
    obsolete.push({
      message: 'Ya no se usa; si quieres quitarlo:',
      command: IS_WINDOWS
        ? `PowerShell: Remove-Item -LiteralPath '${file.replaceAll("'", "''")}'`
        : `rm -- ${quote(file)}`,
    });
  }
  return {
    applied,
    skills,
    retiredSkills,
    obsolete,
    conflicts:
      skills.filter((s) => ['conflicto', 'roto-ajeno'].includes(s.state)).length +
      retiredSkills.filter((s) => !s.owned).length,
    changed,
    clients,
    linkRoot,
    ephemeral,
    activeRoot,
    legacy,
    ...(usingOtherCopy && { otherCopy: { root: activeRoot, missing: missingInActive } }),
    ...(stableInstall && { stableInstall }),
    mcp: {
      applied: false,
      states: mcpStates,
      registrationCommands,
      ...(registrationPending.length && { registrationPending }),
    },
    restartRequired: created > 0,
    ...(clients.includes('codex') && { codexSandbox: await codexSandbox(home, codexHome, codexProfile) }),
    superpowers: { included: false, required: false },
    codexHome,
  };
}
// Codex runs commands in a workspace-write sandbox by default, so `registrar` cannot write its reviewer record
// under ~/.agent-toolkit unless that folder is inside a writable root. Only reported; the user runs the printed
// command. What cannot be evaluated (permission profiles) is reported as unknown instead of asking for a change.
// Resolves links through the deepest folder that exists, so a root written through a link still matches.
async function canonical(target) {
  let current = path.resolve(target),
    rest = [];
  while (true) {
    try {
      return path.join(await fs.realpath(current), ...rest);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      rest.unshift(path.basename(current));
      current = parent;
    }
  }
}
const PROFILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const layer = (base, top) => {
  const out = { ...base };
  for (const [key, value] of Object.entries(top)) {
    out[key] =
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      out[key] &&
      typeof out[key] === 'object' &&
      !Array.isArray(out[key])
        ? layer(out[key], value)
        : value;
  }
  return out;
};
const readToml = async (file) => {
  const bytes = await boundedConfig(file);
  return bytes ? getStaticTOMLValue(parseTOML(bytes.toString('utf8'), { tomlVersion: '1.0.0' })) : null;
};
async function codexSandbox(home, codexHome, codexProfile) {
  const state = path.join(home, '.agent-toolkit'),
    file = path.join(codexHome, 'config.toml');
  // A base64 payload keeps paths and JavaScript out of shell interpolation in cmd, PowerShell and POSIX shells.
  const script =
    `const fs = require('node:fs'); const file = ${JSON.stringify(file)}; ` +
    `let content = ''; try { content = fs.readFileSync(file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; } ` +
    `if (/^\\[sandbox_workspace_write\\]/mu.test(content)) console.log('Ya existe la sección: añade la ruta a writable_roots a mano'); ` +
    `else fs.appendFileSync(file, ${JSON.stringify(`\n[sandbox_workspace_write]\nwritable_roots = [${JSON.stringify(state)}]\n`)});`;
  const command = `node -e "eval(Buffer.from('${Buffer.from(script).toString('base64')}','base64').toString())"`;
  const unknown = (reason) => ({
    state: 'unknown',
    writableRoot: state,
    hint: `${reason}: no se puede saber si Codex deja escribir en ${state}. Si $revisar no consigue registrarse, permite esa carpeta.`,
  });
  let config = {},
    profileFiles = [];
  try {
    config = (await readToml(file)) ?? {};
    // `codex --profile <name>` layers $CODEX_HOME/<name>.config.toml over config.toml at launch time.
    profileFiles = (await fs.readdir(codexHome).catch(() => []))
      .filter((n) => n.endsWith('.config.toml'))
      .map((n) => n.slice(0, -12))
      .filter((n) => PROFILE.test(n))
      .sort();
  } catch {
    return { state: 'unreadable', writableRoot: state };
  }
  let effective = config;
  if (codexProfile !== undefined) {
    if (!PROFILE.test(codexProfile)) throw new Error('Nombre de perfil de Codex no válido.');
    let overlay;
    try {
      overlay = await readToml(path.join(codexHome, `${codexProfile}.config.toml`));
    } catch {
      return { state: 'unreadable', writableRoot: state };
    }
    if (!overlay) return unknown(`No existe ${codexProfile}.config.toml en ${codexHome}`);
    effective = layer(config, overlay);
  } else if (config.profile !== undefined) {
    // Older layout: a [profiles.<name>] table selected with `profile = "<name>"`.
    const profile = typeof config.profile === 'string' ? config.profiles?.[config.profile] : undefined;
    if (!profile || typeof profile !== 'object')
      return unknown('El perfil de configuración elegido no se encuentra');
    effective = layer(config, profile);
  }
  const result = (value) =>
    codexProfile === undefined && profileFiles.length
      ? {
          ...value,
          profileFiles,
          profileHint: `Hay perfiles de Codex (${profileFiles.join(', ')}). Si abres Codex con --profile, revisa con --perfil-codex <nombre>.`,
        }
      : value;
  return result(await sandboxState(effective, home, state, file, command, unknown));
}
async function sandboxState(effective, home, state, file, command, unknown) {
  const mode = effective.sandbox_mode;
  // When sandbox_mode is present, Codex uses the legacy options and ignores default_permissions.
  if (mode === undefined && effective.default_permissions !== undefined) {
    if (effective.default_permissions === ':danger-full-access')
      return { state: 'not-needed', writableRoot: state };
    if (effective.default_permissions === ':read-only')
      return {
        state: 'read-only',
        writableRoot: state,
        hint: `El perfil de permisos :read-only no deja escribir: $revisar no puede registrarse. Usa sandbox_mode = "workspace-write" con ${state} en writable_roots.`,
      };
    return unknown('Codex usa un perfil de permisos propio');
  }
  if (mode === undefined && effective.permissions !== undefined)
    return unknown('Codex usa perfiles de permisos');
  if (mode === 'danger-full-access') return { state: 'not-needed', writableRoot: state };
  if (mode === 'read-only')
    return {
      state: 'read-only',
      writableRoot: state,
      hint: `Codex está en solo lectura: $revisar no puede registrarse. Usa sandbox_mode = "workspace-write" con ${state} en writable_roots.`,
    };
  if (mode !== undefined && mode !== 'workspace-write')
    return unknown(`sandbox_mode = ${JSON.stringify(mode)} no es conocido`);
  const roots = effective.sandbox_workspace_write?.writable_roots;
  const target = await canonical(state);
  for (const root of Array.isArray(roots) ? roots : []) {
    if (typeof root !== 'string' || !root) continue;
    const relative = path.relative(await canonical(root.replace(/^~(?=$|\/)/u, home)), target);
    if (
      relative === '' ||
      (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))
    ) {
      return { state: 'allowed', writableRoot: state };
    }
  }
  return effective.sandbox_workspace_write
    ? {
        state: 'missing-root',
        writableRoot: state,
        hint: `Añade ${JSON.stringify(state)} a writable_roots de [sandbox_workspace_write] en ${file}.`,
      }
    : { state: 'missing', writableRoot: state, command };
}
async function boundedConfig(file) {
  const info = await stat(file);
  if (!info) return null;
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1_048_576) throw new Error('config');
  return fs.readFile(file);
}
// The entry is recognized by the script it runs (`…/bin/agent-toolkit-mcp.js` under `node`), then classified like
// a link: installed only if that script exists in a root in use.
async function inspectMcp(client, home, codexHome, { activeRoots, isOwned }) {
  let servers;
  try {
    const bytes = await boundedConfig(
      client === 'codex' ? path.join(codexHome, 'config.toml') : path.join(home, '.claude.json'),
    );
    if (!bytes) return { state: 'falta' };
    servers =
      client === 'codex'
        ? getStaticTOMLValue(parseTOML(bytes.toString('utf8'), { tomlVersion: '1.0.0' })).mcp_servers
        : JSON.parse(bytes.toString('utf8')).mcpServers;
  } catch {
    return { state: 'unreadable' };
  }
  for (const name of ['agent-toolkit-workflow', 'agent-toolkit']) {
    const server = servers?.[name];
    if (!server) continue;
    if (server.enabled === false) return { state: 'disabled', name };
    const entry = Array.isArray(server.args)
      ? server.args.find(
          (arg) => typeof arg === 'string' && arg.replaceAll('\\', '/').endsWith(`/${MCP_SUFFIX}`),
        )
      : undefined;
    const runsNode =
      typeof server.command === 'string' && /^node(\.exe)?$/iu.test(path.basename(server.command));
    if (!entry || !runsNode) return { state: 'conflicto', name };
    const { state, root } = await classifyReference({
      target: mcpRegistryTarget(client, name),
      literal: entry,
      suffix: MCP_SUFFIX,
      activeRoots,
      isOwned,
    });
    return { state, name, literal: entry, ...(root && { root }) };
  }
  return { state: 'falta' };
}
async function findExecutable(name, environment, accept = () => true) {
  const extensions = IS_WINDOWS
    ? [
        '',
        ...(environment.PATHEXT || '.COM;.EXE;.BAT;.CMD')
          .split(';')
          .filter(Boolean)
          .map((extension) => extension.toLowerCase()),
      ]
    : [''];
  for (const folder of (environment.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      try {
        const file = path.join(folder, name + extension);
        await fs.access(file, constants.X_OK);
        if ((await fs.stat(file)).isFile() && (await accept(file))) return file;
      } catch {}
    }
  }
  return null;
}
export async function executable(name, environment) {
  return Boolean(await findExecutable(name, environment));
}
export async function doctorToolkit({
  agent = 'all',
  homeDirectory = os.homedir(),
  toolkitRoot = TOOLKIT_ROOT,
  environment = process.env,
  codexHome = environment.CODEX_HOME ?? path.join(homeDirectory, '.codex'),
  codexProfile,
} = {}) {
  const setup = await setupToolkit({
    agent,
    homeDirectory,
    toolkitRoot,
    environment,
    codexHome,
    codexProfile,
  });
  const clients = {};
  for (const name of setup.clients)
    clients[name] = { available: await executable(COMMANDS[name], environment) };
  const mcp = setup.mcp.states;
  const dependencies = {};
  const require = createRequire(path.join(toolkitRoot, 'package.json'));
  for (const name of [
    '@modelcontextprotocol/server',
    '@modelcontextprotocol/sdk',
    'zod',
    'ajv',
    'toml-eslint-parser',
  ]) {
    try {
      require.resolve(name === '@modelcontextprotocol/sdk' ? name + '/client/index.js' : name);
      dependencies[name] = true;
    } catch {
      dependencies[name] = false;
    }
  }
  return {
    node: { version: process.version, supported: isNodeSupported(process.versions.node) },
    dependencies,
    clients,
    mcp,
    skills: setup.skills,
    obsolete: setup.obsolete,
    retiredSkills: setup.retiredSkills,
    registrationCommands: setup.mcp.registrationCommands,
    ...(setup.mcp.registrationPending && { registrationPending: setup.mcp.registrationPending }),
    activeRoot: setup.activeRoot,
    legacy: setup.legacy,
    ...(setup.otherCopy && { otherCopy: setup.otherCopy }),
    ...(setup.codexSandbox && { codexSandbox: setup.codexSandbox }),
    gemini: { available: await executable('agy', environment), provider: 'antigravity', apiFallback: false },
    superpowers: { included: false, required: false, detection: 'check-client-plugin-manager' },
    nativeConnectionVerified: false,
  };
}
