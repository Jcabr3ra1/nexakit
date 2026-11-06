import { inspectFolder } from './clean-project.js';
import { loadGeneratorsCatalog } from './generators-catalog.js';
import { readCleanProjectAnswers } from './skill-recommendations.js';
// Gathers, read-only, everything the setup questions and the confirmation need: the project and what it uses, the
// skills and their links, the agents installed, their base skills, the stable command and the project memory.
// Nothing here writes; setup-apply.js does, after the person confirms.
import fs from 'node:fs/promises';
import os from 'node:os';
import { planReviewInstructions } from './review-instructions.js';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { connectMemory } from './connect.js';
import { ACTIONABLE_LINK_STATES } from './link-states.js';
import {
  findKnownMemories,
  memoryForRepository,
  registeredServers,
  suggestMemoryLocation,
} from './memory-locator.js';
import { AGENTS, shortReason } from './setup-plan.js';
import { loadSkillCatalog } from './skill-catalog.js';
import {
  inspectSkillProject,
  planProjectSkillInstall,
  readSetupAnswers,
  recommendSkills,
  uncoveredSignals,
} from './skill-recommendations.js';
import { planStableCommand } from './stable-command.js';
import { inspectSuperpowers } from './superpowers.js';
import { compareVersions, readActualVersion } from './stable-install.js';
import {
  TOOLKIT_ROOT,
  executable,
  packageVersion,
  resolveNodeExecutable,
  setupToolkit,
} from './toolkit-setup.js';

const CONFLICT_LINK_STATES = new Set(['conflicto', 'roto-ajeno']);

// What is at a memory path: this repository's memory, a place for a new one, another project's memory ('foreign'),
// or something else ('invalid'). Only 'memory' and 'new' are ever written; the other two are left alone.
export async function inspectMemoryPath(target, { repositoryRoot } = {}) {
  const info = await fs
    .lstat(target)
    .catch((error) => (error.code === 'ENOENT' ? null : Promise.reject(error)));
  if (!info) return 'new';
  if (!info.isDirectory() || info.isSymbolicLink()) return 'invalid';
  const manifestPath = path.join(target, 'project-memory.json');
  const manifest = await fs.lstat(manifestPath).catch(() => null);
  if (manifest?.isFile() && !manifest.isSymbolicLink()) {
    if (!repositoryRoot) return 'memory';
    try {
      const source = JSON.parse(await fs.readFile(manifestPath, 'utf8'))?.source?.repositoryPath;
      const real =
        typeof source === 'string' ? await fs.realpath(source).catch(() => path.resolve(source)) : null;
      return real && real === (await fs.realpath(repositoryRoot).catch(() => repositoryRoot))
        ? 'memory'
        : 'foreign';
    } catch {
      return 'invalid';
    }
  }
  return (await fs.readdir(target)).length === 0 ? 'new' : 'invalid';
}

async function readMemoryManifest(vaultPath) {
  try {
    return JSON.parse(await fs.readFile(path.join(vaultPath, 'project-memory.json'), 'utf8'));
  } catch {
    return null;
  }
}

// For an agent the memory does not reach yet: its MCP name must be free in that agent, or already serve this vault.
async function newConnection(agent, { mcpName, vaultPath, servers, agentsFound }) {
  if (!agentsFound[agent]) return 'unavailable';
  if (!Object.hasOwn(servers[agent] ?? {}, mcpName)) return 'create';
  // Taken by this same vault with the server this agent's connection uses (Antigravity: nexakit's read-only
  // server; Claude and Codex: server-filesystem) is fine; anything else under that name is a conflict.
  const real = await fs.realpath(vaultPath).catch(() => path.resolve(vaultPath));
  const current = servers[agent][mcpName];
  const expected = agent === 'antigravity' ? 'guard' : 'filesystem';
  return current?.vault === real && current.kind === expected ? 'create' : 'conflict';
}

// How an existing memory is connected to each agent: unchanged, create, conflict or unavailable (no CLI). An agent
// the memory does not declare yet (an older memory without Antigravity) is "create": connecting it declares it.
export async function memoryConnections(
  vaultPath,
  { homeDirectory, codexHome, runCommand, nodePath, toolkitRoot, agentsFound, kind = 'memory', mcpName },
) {
  const servers = await registeredServers({ homeDirectory, ...(codexHome && { codexHome }) });
  const manifest = kind === 'memory' ? await readMemoryManifest(vaultPath) : null;
  const name = manifest?.memory?.mcpServerName ?? mcpName;
  const declared = (manifest?.agents ?? []).filter((agent) => agent.enabled).map((agent) => agent.id);
  const result = {};
  for (const agent of AGENTS) {
    if (!declared.includes(agent)) {
      result[agent] = await newConnection(agent, { mcpName: name, vaultPath, servers, agentsFound });
      continue;
    }
    try {
      const report = await connectMemory(
        { targetPath: vaultPath, agentId: agent },
        { homeDirectory, nodePath, toolkitRoot, ...(runCommand && { runCommand }) },
      );
      const mcp = report.components.find((component) => component.id === 'mcp');
      if (/No se encontró el comando/u.test(mcp?.message ?? '')) result[agent] = 'unavailable';
      else if (report.components.some((component) => component.action === 'conflict'))
        result[agent] = 'conflict';
      else
        result[agent] = report.components.every((component) => component.action === 'unchanged')
          ? 'unchanged'
          : 'create';
    } catch {
      result[agent] = 'conflict';
    }
  }
  return result;
}

export async function gatherSetupState({
  start = process.cwd(),
  homeDirectory = os.homedir(),
  environment = process.env,
  toolkitRoot = TOOLKIT_ROOT,
  codexHome = environment.CODEX_HOME ?? path.join(homeDirectory, '.codex'),
  runCommand,
  memoryPaths = [],
} = {}) {
  const catalog = await loadSkillCatalog(
    toolkitRoot === TOOLKIT_ROOT
      ? {}
      : { catalogUrl: pathToFileURL(path.join(toolkitRoot, 'catalogs/skills.json')) },
  );
  const inspection = await inspectSkillProject(start, { toolkitRoot, catalog, homeDirectory });
  const project = inspection.project;
  const recommendation = recommendSkills({ catalog, inspection });
  const projectPlan = await planProjectSkillInstall({
    projectRoot: project.root,
    skillNames: catalog.skills.map((skill) => skill.name),
    agent: 'all',
    mode: 'symlink',
    catalog,
    toolkitRoot,
    homeDirectory,
  });
  const signalById = new Map(inspection.signals.map((signal) => [signal.id, signal]));
  const linkState = (name, client) =>
    projectPlan.links.find((link) => link.name === name && link.client === client)?.state ?? 'missing';
  const skills = [
    ...recommendation.recommended,
    ...recommendation.candidates,
    ...recommendation.optional,
  ].map((entry) => {
    const first = entry.matchedSignals?.[0];
    const signal = first && signalById.get(first);
    return {
      name: entry.name,
      summary: entry.summary,
      reason: signal ? shortReason(signal.label, signal.sources[0]) : null,
      matchCount: entry.matchedSignals?.length ?? 0,
      suggested: (entry.matchedSignals?.length ?? 0) > 0,
      license: entry.license,
      tested: entry.recommendationStatus === 'validated',
      reviewNotes: entry.reviewStatus === 'reviewed-with-observations' ? entry.reviewNotes : null,
      links: { claude: linkState(entry.name, 'claude'), codex: linkState(entry.name, 'codex') },
    };
  });

  const setup = await setupToolkit({
    agent: 'all',
    apply: false,
    homeDirectory,
    toolkitRoot,
    environment,
    codexHome,
  });
  const globalSkills = Object.fromEntries(
    AGENTS.map((agent) => {
      const items = setup.skills.filter((item) => item.client === agent);
      return [
        agent,
        {
          pending: items.filter((item) => ACTIONABLE_LINK_STATES.includes(item.state)).length,
          conflicts:
            items.filter((item) => CONFLICT_LINK_STATES.has(item.state)).length +
            (setup.retiredSkills ?? []).filter((item) => item.client === agent && !item.owned).length,
        },
      ];
    }),
  );
  const agentsFound = {
    claude: await executable('claude', environment),
    codex: await executable('codex', environment),
    antigravity: setup.clients.includes('antigravity'),
  };

  const version = await packageVersion(toolkitRoot);
  const actualVersion = setup.ephemeral ? await readActualVersion(homeDirectory) : null;
  for (const agent of Object.keys(globalSkills))
    globalSkills[agent].retiredCount = (setup.retiredSkills ?? []).filter(
      (s) => s.client === agent && s.owned,
    ).length;
  const stableCopy = {
    needed: Boolean(setup.ephemeral) && (!actualVersion || compareVersions(actualVersion, version) < 0),
  };
  const nodePath = await resolveNodeExecutable(environment);
  const stableCommand = await planStableCommand({ homeDirectory, nodePath, toolkitRoot: setup.linkRoot });

  const savedAnswers = await readSetupAnswers(project.root);
  const known = await findKnownMemories({ homeDirectory, codexHome });
  const existingEntry = memoryForRepository(known, project.root);
  const suggestedPath = suggestMemoryLocation(known, { id: project.id, homeDirectory });
  const memory = {
    existing: existingEntry && { vaultPath: existingEntry.vaultPath },
    suggestedPath,
    kinds: {},
    connections: {},
  };
  // The chosen path is always inspected, also one typed in "otra carpeta…" (memoryPaths).
  const candidates = [
    existingEntry?.vaultPath,
    suggestedPath,
    savedAnswers?.memory?.path,
    ...memoryPaths,
  ].filter(Boolean);
  const context = {
    homeDirectory,
    codexHome,
    runCommand,
    nodePath,
    toolkitRoot: setup.linkRoot,
    agentsFound,
    mcpName: `${project.id}-memory`,
  };
  for (const candidate of [...new Set(candidates)]) {
    const kind = await inspectMemoryPath(candidate, { repositoryRoot: project.root });
    memory.kinds[candidate] = kind;
    if (kind === 'memory' || kind === 'new')
      memory.connections[candidate] = await memoryConnections(candidate, { ...context, kind });
  }

  const reviewInstructions = await planReviewInstructions({ homeDirectory, environment, codexHome });
  const superpowers = await inspectSuperpowers({ agentsFound, runCommand, environment });
  return {
    folder:await inspectFolder(start),
    creationRoot:await fs.realpath(start),
    generators:await loadGeneratorsCatalog(),
    cleanProject:await readCleanProjectAnswers(project.root),
    reviewInstructions,
    superpowers,
    homeDirectory,
    version,
    project,
    signals: inspection.signals,
    skills,
    // Suggested but installed outside NexaKit (for example as a Claude plugin): listed, never selectable.
    externalSkills: recommendation.externalCandidates.map(ref => ({ name: ref.name, reason: ref.reasons[0] ?? null })),
    // Found in the project but covered by no catalog skill: reported only, never searched for automatically.
    uncoveredTech: uncoveredSignals({ signals: inspection.signals, catalog }),
    agentsFound,
    globalSkills,
    stableCopy,
    stableCommand,
    memory,
    savedAnswers,
    // For setup-apply.js and the detail screen; not part of the summary.
    internal: {
      catalog,
      inspection,
      projectPlan,
      setup,
      nodePath,
      toolkitRoot,
      linkRoot: setup.linkRoot,
      codexHome,
      environment,
      runCommand,
    },
  };
}
