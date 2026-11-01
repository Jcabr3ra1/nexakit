// Gathers, read-only, everything the setup questions and the confirmation need: the project and what it uses, the
// skills and their links, the agents installed, their base skills, the stable command and the project memory.
// Nothing here writes; setup-apply.js does, after the person confirms.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { connectMemory } from './connect.js';
import { ACTIONABLE_LINK_STATES } from './link-states.js';
import { findKnownMemories, memoryForRepository, suggestMemoryLocation } from './memory-locator.js';
import { AGENTS, shortReason } from './setup-plan.js';
import { loadSkillCatalog } from './skill-catalog.js';
import { inspectSkillProject, planProjectSkillInstall, readSetupAnswers, recommendSkills } from './skill-recommendations.js';
import { planStableCommand } from './stable-command.js';
import { compareVersions, readActualVersion } from './stable-install.js';
import { TOOLKIT_ROOT, executable, packageVersion, resolveNodeExecutable, setupToolkit } from './toolkit-setup.js';

const CONFLICT_LINK_STATES = new Set(['conflicto', 'roto-ajeno']);

// What is at a memory path: an existing memory, a place for a new one, or something else that is not touched.
export async function inspectMemoryPath(target) {
  const info = await fs.lstat(target).catch(error => (error.code === 'ENOENT' ? null : Promise.reject(error)));
  if (!info) return 'new';
  if (!info.isDirectory() || info.isSymbolicLink()) return 'invalid';
  const manifest = await fs.lstat(path.join(target, 'project-memory.json')).catch(() => null);
  if (manifest?.isFile() && !manifest.isSymbolicLink()) return 'memory';
  return (await fs.readdir(target)).length === 0 ? 'new' : 'invalid';
}

async function declaredAgents(vaultPath) {
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(vaultPath, 'project-memory.json'), 'utf8'));
    return (manifest.agents ?? []).filter(agent => agent.enabled).map(agent => agent.id);
  } catch {
    return [];
  }
}

// How an existing memory is connected to each agent: unchanged, create, conflict or unavailable (no CLI). An agent
// the memory does not declare yet (an older memory without Antigravity) is "create": connecting it declares it.
export async function memoryConnections(vaultPath, { homeDirectory, runCommand, nodePath, toolkitRoot, agentsFound }) {
  const declared = await declaredAgents(vaultPath);
  const result = {};
  for (const agent of AGENTS) {
    if (!declared.includes(agent)) {
      result[agent] = agentsFound[agent] ? 'create' : 'unavailable';
      continue;
    }
    try {
      const report = await connectMemory({ targetPath: vaultPath, agentId: agent },
        { homeDirectory, nodePath, toolkitRoot, ...(runCommand && { runCommand }) });
      const mcp = report.components.find(component => component.id === 'mcp');
      if (/No se encontró el comando/u.test(mcp?.message ?? '')) result[agent] = 'unavailable';
      else if (report.components.some(component => component.action === 'conflict')) result[agent] = 'conflict';
      else result[agent] = report.components.every(component => component.action === 'unchanged') ? 'unchanged' : 'create';
    } catch {
      result[agent] = 'conflict';
    }
  }
  return result;
}

export async function gatherSetupState({
  start = process.cwd(), homeDirectory = os.homedir(), environment = process.env, toolkitRoot = TOOLKIT_ROOT,
  codexHome = environment.CODEX_HOME ?? path.join(homeDirectory, '.codex'), runCommand
} = {}) {
  const catalog = await loadSkillCatalog(toolkitRoot === TOOLKIT_ROOT ? {} : { catalogUrl: pathToFileURL(path.join(toolkitRoot, 'catalogs/skills.json')) });
  const inspection = await inspectSkillProject(start, { toolkitRoot, catalog, homeDirectory });
  const project = inspection.project;
  const recommendation = recommendSkills({ catalog, inspection });
  const projectPlan = await planProjectSkillInstall({
    projectRoot: project.root, skillNames: catalog.skills.map(skill => skill.name), agent: 'all', mode: 'symlink',
    catalog, toolkitRoot, homeDirectory
  });
  const signalById = new Map(inspection.signals.map(signal => [signal.id, signal]));
  const linkState = (name, client) => projectPlan.links.find(link => link.name === name && link.client === client)?.state ?? 'missing';
  const skills = [...recommendation.recommended, ...recommendation.candidates, ...recommendation.optional].map(entry => {
    const first = entry.matchedSignals?.[0];
    const signal = first && signalById.get(first);
    return {
      name: entry.name,
      summary: entry.summary,
      reason: signal ? shortReason(signal.label, signal.sources[0]) : null,
      matchCount: entry.matchedSignals?.length ?? 0,
      suggested: (entry.matchedSignals?.length ?? 0) > 0,
      license: entry.license,
      links: { claude: linkState(entry.name, 'claude'), codex: linkState(entry.name, 'codex') }
    };
  });

  const setup = await setupToolkit({ agent: 'all', apply: false, homeDirectory, toolkitRoot, environment, codexHome });
  const globalSkills = Object.fromEntries(AGENTS.map(agent => {
    const items = setup.skills.filter(item => item.client === agent);
    return [agent, {
      pending: items.filter(item => ACTIONABLE_LINK_STATES.includes(item.state)).length,
      conflicts: items.filter(item => CONFLICT_LINK_STATES.has(item.state)).length
    }];
  }));
  const agentsFound = {
    claude: await executable('claude', environment),
    codex: await executable('codex', environment),
    antigravity: setup.clients.includes('antigravity')
  };

  const version = await packageVersion(toolkitRoot);
  const actualVersion = setup.ephemeral ? await readActualVersion(homeDirectory) : null;
  const stableCopy = { needed: Boolean(setup.ephemeral) && (!actualVersion || compareVersions(actualVersion, version) < 0) };
  const nodePath = await resolveNodeExecutable(environment);
  const stableCommand = await planStableCommand({ homeDirectory, nodePath, toolkitRoot: setup.linkRoot });

  const savedAnswers = await readSetupAnswers(project.root);
  const known = await findKnownMemories({ homeDirectory, codexHome });
  const existingEntry = memoryForRepository(known, project.root);
  const suggestedPath = suggestMemoryLocation(known, { id: project.id, homeDirectory });
  const memory = { existing: existingEntry && { vaultPath: existingEntry.vaultPath }, suggestedPath, kinds: {}, connections: {} };
  const candidates = [existingEntry?.vaultPath, suggestedPath, savedAnswers?.memory?.path].filter(Boolean);
  const context = { homeDirectory, runCommand, nodePath, toolkitRoot: setup.linkRoot, agentsFound };
  for (const candidate of [...new Set(candidates)]) {
    memory.kinds[candidate] = await inspectMemoryPath(candidate);
    if (memory.kinds[candidate] === 'memory') memory.connections[candidate] = await memoryConnections(candidate, context);
  }

  return {
    homeDirectory, version, project, signals: inspection.signals, skills, agentsFound, globalSkills,
    stableCopy, stableCommand, memory, savedAnswers,
    // For setup-apply.js and the detail screen; not part of the summary.
    internal: { catalog, inspection, projectPlan, setup, nodePath, toolkitRoot, linkRoot: setup.linkRoot, codexHome, environment, runCommand }
  };
}
