import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { acquireLock } from './install-lock.js';
import { recordEntries } from './install-registry.js';
import { relinkIfUnchanged } from './link-states.js';
import { actualRoot, ensureStableInstall, nexakitDir } from './stable-install.js';
import { TOOLKIT_ROOT, packageVersion, registrationCommand, resolveNodeExecutable, setupToolkit } from './toolkit-setup.js';

const samePath = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
const exists = file => fs.access(file).then(() => true, () => false);

// Finds the global links that point into a root that no longer exists, `from`, and that nexakit cannot prove
// are its own (no entry in the install registry). Only skill names this version ships are considered.
// Nothing is written here: the person has to confirm what this lists.
export async function planLegacyRepair({
  from, agent = 'all', homeDirectory = os.homedir(), toolkitRoot = TOOLKIT_ROOT, environment = process.env, codexHome
} = {}) {
  const dead = path.resolve(from);
  const setup = await setupToolkit({ agent, homeDirectory, toolkitRoot, environment, ...(codexHome && { codexHome }) });
  const links = setup.skills
    .filter(skill => skill.state === 'roto-ajeno' && skill.root && samePath(skill.root, dead))
    .map(({ client, name, target, literal }) => ({ client, name, target, literal }))
    .sort((a, b) => a.client.localeCompare(b.client) || a.name.localeCompare(b.name));
  const mcp = {};
  for (const [client, state] of Object.entries(setup.mcp.states)) {
    if (state.state === 'roto-ajeno' && state.root && samePath(state.root, dead)) mcp[client] = { name: state.name, literal: state.literal };
  }
  return { from: dead, agent, activeRoot: setup.activeRoot, ephemeral: setup.ephemeral && !setup.otherCopy, links, mcp };
}

// Repoints the links of the plan to the copy of nexakit in use and records them as nexakit's own.
// Each link is read again right before writing: one that changed since the plan is left alone.
export async function applyLegacyRepair(plan, {
  homeDirectory = os.homedir(), toolkitRoot = TOOLKIT_ROOT, environment = process.env, runNpm, packageSpec, lockOptions,
  acquire = acquireLock
} = {}) {
  const home = await fs.realpath(homeDirectory);
  const lock = await acquire(nexakitDir(home), lockOptions);
  try {
    if (plan.ephemeral && plan.links.length) {
      await ensureStableInstall({
        homeDirectory: home, version: await packageVersion(await fs.realpath(toolkitRoot)), lock,
        ...(runNpm && { runNpm }), ...(packageSpec && { packageSpec })
      });
    }
    const entries = [], skipped = [];
    let changed = 0;
    for (const link of plan.links) {
      const source = path.join(plan.activeRoot, 'skills', link.name);
      if (!(await exists(path.join(source, 'SKILL.md')))) { skipped.push(link.name); continue; }
      await lock.assertHeld();
      if (await relinkIfUnchanged({ target: link.target, expectedLiteral: link.literal, source }) === 'cambio') { changed++; continue; }
      entries.push({ destino: link.target, apunta: await fs.readlink(link.target), raiz: plan.activeRoot });
    }
    await recordEntries(nexakitDir(home), entries, lock);

    // The MCP entry is not rewritten here: its client owns that file, so only the exact commands are given.
    const mcpCommands = [];
    const script = path.join(plan.activeRoot, 'bin/agent-toolkit-mcp.js');
    if (Object.keys(plan.mcp ?? {}).length && await exists(script)) {
      const nodePath = await resolveNodeExecutable(environment);
      for (const [client, current] of Object.entries(plan.mcp)) {
        mcpCommands.push(registrationCommand(client, { state: 'roto-ajeno', name: current.name }, nodePath, script));
      }
    }
    return { repaired: entries.length, changed, skipped, mcpCommands, stableRoot: actualRoot(home) };
  } finally {
    await lock.release();
  }
}
