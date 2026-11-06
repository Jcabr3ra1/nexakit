import { ownedReviewInstructions, removeReviewInstructions } from './review-instructions.js';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { acquireLock } from './install-lock.js';
import { isRegistered, readRegistry, recordEntries } from './install-registry.js';
import { classifyLink, relinkIfUnchanged } from './link-states.js';
import { IS_WINDOWS } from './platform.js';
import { detectSignals, SIGNAL_LABELS } from './project-signals.js';
import { resolveProjectRoot } from './project-root.js';
import { loadSkillCatalog } from './skill-catalog.js';
import { actualRoot, ensureStableInstall, nexakitDir } from './stable-install.js';
import { TOOLKIT_ROOT, globalSkillTarget, resolveRoots } from './toolkit-setup.js';

const MAX_MANIFEST_BYTES = 512 * 1024;
const MAX_SKILL_FILES = 256;
const VALID_PROFILES = new Set(['frontend', 'backend', 'mcp', 'security']);
const VALID_CLIENTS = new Set(['codex', 'claude']);
const VALID_INSTALL_MODES = new Set(['symlink', 'copy']);
const VALID_GIT_IGNORE = new Set(['gitignore', 'git-exclude', 'none']);
const SKILL_NAME_RE = /^[a-z0-9-]+$/u;
// Antigravity reads project skills from `.agents/skills`, the folder Codex uses: one link serves both.
const projectClientsFor = agent => (agent === 'all' ? ['codex', 'claude'] : [agent === 'antigravity' ? 'codex' : agent]);
const servesFor = (client, agent) => (client === 'claude' ? ['claude'] : agent === 'all' ? ['codex', 'antigravity'] : [agent === 'antigravity' ? 'antigravity' : 'codex']);
// The coarse vocabulary the rest of the code reads; `linkState` keeps the detailed one.
const COARSE_STATE = Object.freeze({
  falta: 'missing', efimero: 'replace', 'roto-propio': 'replace', instalado: 'installed',
  'otra-copia': 'installed', conflicto: 'conflict', 'roto-ajeno': 'conflict'
});

export const PROJECT_TOOLKIT_DIR = '.agent-toolkit';
const PROJECT_MANIFEST_FILE = 'manifest.json';
const PROJECT_LOCKFILE_NAME = 'skills-lock.json';
const IGNORE_BLOCK_START = '# >>> agent-toolkit (managed) >>>';
const IGNORE_BLOCK_END = '# <<< agent-toolkit (managed) <<<';
const LEVEL_AGENT_HEADER = '# Generado por `agent-toolkit-inbox agentes`.';
const LEVEL_AGENT_NAMES = ['nivel_ligero.toml', 'nivel_normal.toml', 'nivel_exigente.toml', 'nivel_alto.toml'];

export { SIGNAL_LABELS };

const normalizedPath = value => (IS_WINDOWS ? value.toLowerCase() : value);
const lstatOrNull = target => fs.lstat(target).catch(err => {
  if (err.code === 'ENOENT') return null;
  throw err;
});

function isWithinRoot(candidate, allowedRoot) {
  const rel = path.relative(normalizedPath(allowedRoot), normalizedPath(candidate));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

async function hashDirectoryFiles(dir, prefix = '', maxFiles = MAX_SKILL_FILES) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) return null;
    if (entry.isDirectory()) {
      const nested = await hashDirectoryFiles(full, rel, maxFiles - files.length);
      if (!nested) return null;
      files.push(...nested);
    } else if (entry.isFile()) {
      if (files.length >= maxFiles) return null;
      const info = await fs.lstat(full);
      if (info.size > MAX_MANIFEST_BYTES) return null;
      const sha256 = createHash('sha256').update(await fs.readFile(full)).digest('hex');
      files.push({ path: rel, sha256 });
    }
  }
  return files;
}

async function verifyCatalogIntegrity(canonicalDir, catalogEntry) {
  if (!catalogEntry) return 'untracked';
  try {
    const actual = await hashDirectoryFiles(canonicalDir);
    if (!actual || actual.length !== catalogEntry.files.length) return 'modified';
    const expected = [...catalogEntry.files].sort((a, b) => a.path.localeCompare(b.path));
    for (let i = 0; i < expected.length; i++) {
      if (actual[i].path !== expected[i].path || actual[i].sha256 !== expected[i].sha256) return 'modified';
    }
    return 'verified';
  } catch {
    return 'modified';
  }
}

export async function verifyBundledSkillHashes({ skillEntry, toolkitRoot = TOOLKIT_ROOT } = {}) {
  if (!skillEntry || !skillEntry.installedPath || !Array.isArray(skillEntry.files)) {
    return { ok: false, reason: 'Entrada de skill inválida.' };
  }
  try {
    const resolvedToolkit = await fs.realpath(toolkitRoot);
    const sourceDir = path.join(resolvedToolkit, skillEntry.installedPath);
    if (!isWithinRoot(sourceDir, resolvedToolkit)) {
      return { ok: false, reason: 'Ruta instalada fuera de la raíz de Agent Toolkit.' };
    }
    const dirInfo = await lstatOrNull(sourceDir);
    if (!dirInfo || !dirInfo.isDirectory() || dirInfo.isSymbolicLink()) {
      return { ok: false, reason: `No existe la carpeta fuente de ${skillEntry.name}.` };
    }
    const integrity = await verifyCatalogIntegrity(sourceDir, skillEntry);
    if (integrity !== 'verified') {
      return { ok: false, reason: `Integridad SHA-256 rechazada para ${skillEntry.name}.` };
    }
    return { ok: true, filesCount: skillEntry.files.length, sourceDir };
  } catch {
    return { ok: false, reason: `No se pudo comprobar SHA-256 para ${skillEntry.name}.` };
  }
}

async function inspectProjectSkills(projectRoot, toolkitRoot, catalogByName, clientFilter) {
  const locations = [
    ['codex', path.join(projectRoot, '.agents', 'skills')],
    ['claude', path.join(projectRoot, '.claude', 'skills')]
  ].filter(([c]) => !clientFilter || c === clientFilter);

  const merged = new Map();
  for (const [client, skillsDir] of locations) {
    const dirInfo = await lstatOrNull(skillsDir);
    if (!dirInfo || !dirInfo.isDirectory() || dirInfo.isSymbolicLink()) continue;
    const entries = await fs.readdir(skillsDir, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!SKILL_NAME_RE.test(entry.name)) continue;
      const entryPath = path.join(skillsDir, entry.name);
      const info = await lstatOrNull(entryPath);
      if (!info) continue;

      if (info.isSymbolicLink()) {
        let canonicalTarget;
        try {
          canonicalTarget = await fs.realpath(entryPath);
        } catch (err) {
          if (err.code === 'ENOENT') {
            const key = `broken:${client}:${entry.name}`;
            merged.set(key, { name: entry.name, clients: [client], state: 'broken-link', integrity: 'unknown' });
            continue;
          }
          throw err;
        }
        const insideAllowed = isWithinRoot(canonicalTarget, projectRoot) || isWithinRoot(canonicalTarget, toolkitRoot);
        if (!insideAllowed) {
          const key = `external:${entry.name}:${normalizedPath(canonicalTarget)}`;
          const prev = merged.get(key);
          if (prev) {
            if (!prev.clients.includes(client)) prev.clients.push(client);
          } else {
            merged.set(key, { name: entry.name, clients: [client], state: 'external-link', integrity: 'unknown' });
          }
          continue;
        }
        const key = `canonical:${entry.name}:${normalizedPath(canonicalTarget)}`;
        const prev = merged.get(key);
        if (prev) {
          if (!prev.clients.includes(client)) prev.clients.push(client);
        } else {
          const integrity = await verifyCatalogIntegrity(canonicalTarget, catalogByName.get(entry.name));
          merged.set(key, { name: entry.name, clients: [client], state: 'linked', integrity });
        }
      } else if (info.isDirectory()) {
        const canonicalTarget = await fs.realpath(entryPath);
        const integrity = await verifyCatalogIntegrity(canonicalTarget, catalogByName.get(entry.name));
        const key = integrity === 'verified'
          ? `verified-copy:${entry.name}`
          : `canonical:${entry.name}:${normalizedPath(canonicalTarget)}`;
        const prev = merged.get(key);
        if (prev) {
          if (!prev.clients.includes(client)) prev.clients.push(client);
        } else {
          merged.set(key, { name: entry.name, clients: [client], state: 'directory', integrity });
        }
      }
    }
  }

  return [...merged.values()].map(item => ({
    ...item,
    clients: [...item.clients].sort()
  }));
}

async function rootPackageName(root) {
  const info = await lstatOrNull(path.join(root, 'package.json'));
  if (!info?.isFile() || info.isSymbolicLink() || info.size > MAX_MANIFEST_BYTES) return null;
  try {
    const name = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))?.name;
    return typeof name === 'string' && name.trim() ? name.trim() : null;
  } catch {
    return null;
  }
}

export async function inspectSkillProject(projectRoot, { client, toolkitRoot = TOOLKIT_ROOT, catalog, homeDirectory } = {}) {
  if (client !== undefined && !VALID_CLIENTS.has(client)) {
    throw new Error('El filtro --client solo admite codex o claude.');
  }
  // The project is the whole Git repository, even when nexakit runs from one of its subfolders.
  const project = await resolveProjectRoot(projectRoot, homeDirectory ? { homeDirectory } : {});
  const root = project.root;
  const resolvedToolkit = await fs.realpath(toolkitRoot);
  const activeCatalog = catalog ?? await loadSkillCatalog();
  const catalogByName = new Map(activeCatalog.skills.map(s => [s.name, s]));
  const { signals, limits } = await detectSignals(root, { git: project.git });
  const projectName = await rootPackageName(root) ?? project.displayName;

  const installed = await inspectProjectSkills(root, resolvedToolkit, catalogByName, client);
  const coupling = await inspectProjectCoupling(root, resolvedToolkit);

  return {
    projectRoot: root,
    project,
    projectName,
    signals,
    installed,
    coupling,
    limits
  };
}

export function upsertManagedIgnoreBlock(existingContent, relativePaths) {
  const normalized = (existingContent ?? '').replace(/\r\n/gu, '\n');
  const uniquePaths = ['.agent-toolkit/', ...new Set(relativePaths.map(p => p.replaceAll('\\', '/')))];
  const block = [IGNORE_BLOCK_START, ...uniquePaths, IGNORE_BLOCK_END].join('\n');

  const startIdx = normalized.indexOf(IGNORE_BLOCK_START);
  const endIdx = startIdx >= 0 ? normalized.indexOf(IGNORE_BLOCK_END, startIdx) : -1;

  if (startIdx >= 0 && endIdx > startIdx) {
    const before = normalized.slice(0, startIdx);
    const after = normalized.slice(endIdx + IGNORE_BLOCK_END.length);
    const merged = `${before}${block}${after}`;
    return merged.endsWith('\n') ? merged : `${merged}\n`;
  }

  const trimmedEnd = normalized.replace(/\s+$/u, '');
  if (!trimmedEnd) return `${block}\n`;
  return `${trimmedEnd}\n\n${block}\n`;
}

export function removeManagedIgnoreBlock(existingContent) {
  const normalized = (existingContent ?? '').replace(/\r\n/gu, '\n');
  const startIdx = normalized.indexOf(IGNORE_BLOCK_START);
  const endIdx = startIdx >= 0 ? normalized.indexOf(IGNORE_BLOCK_END, startIdx) : -1;
  if (startIdx < 0 || endIdx < startIdx) {
    return { changed: false, content: existingContent ?? '' };
  }

  let before = normalized.slice(0, startIdx);
  let after = normalized.slice(endIdx + IGNORE_BLOCK_END.length);

  if (after.startsWith('\n')) after = after.slice(1);
  if (!after.trim()) {
    before = before.replace(/\s+$/u, '');
    return { changed: true, content: before ? `${before}\n` : '' };
  }
  before = before.replace(/\n{2,}$/u, '\n');
  const joined = `${before}${after}`.replace(/^\n+/u, '');
  return { changed: true, content: joined.trim() ? (joined.endsWith('\n') ? joined : `${joined}\n`) : '' };
}

async function resolveGitExcludeTarget(projectRoot) {
  const dotGit = path.join(projectRoot, '.git');
  const gitInfo = await lstatOrNull(dotGit);
  if (!gitInfo || gitInfo.isSymbolicLink()) {
    return { targetPath: null, conflict: Boolean(gitInfo?.isSymbolicLink()), unavailable: !gitInfo };
  }
  let gitDir = null;
  if (gitInfo.isDirectory()) {
    gitDir = dotGit;
  } else if (gitInfo.isFile() && gitInfo.size <= 4096) {
    const text = await fs.readFile(dotGit, 'utf8').catch(() => '');
    const match = text.match(/^gitdir:\s*(.+)\s*$/mu);
    if (match) {
      const candidate = path.resolve(projectRoot, match[1].trim());
      const candInfo = await lstatOrNull(candidate);
      if (candInfo?.isDirectory() && !candInfo.isSymbolicLink()) gitDir = candidate;
    }
  }
  if (!gitDir) return { targetPath: null, conflict: false, unavailable: true };

  const infoDir = path.join(gitDir, 'info');
  const infoStat = await lstatOrNull(infoDir);
  if (infoStat && (!infoStat.isDirectory() || infoStat.isSymbolicLink())) {
    return { targetPath: path.join(infoDir, 'exclude'), conflict: true, unavailable: false };
  }
  const excludePath = path.join(infoDir, 'exclude');
  const excludeStat = await lstatOrNull(excludePath);
  if (excludeStat && (!excludeStat.isFile() || excludeStat.isSymbolicLink() || excludeStat.size > MAX_MANIFEST_BYTES)) {
    return { targetPath: excludePath, conflict: true, unavailable: false };
  }
  return { targetPath: excludePath, conflict: false, unavailable: false };
}

async function inspectGitIgnoreTarget(projectRoot, strategy) {
  if (strategy === 'none') return { strategy, targetPath: null, conflict: false, unavailable: false };
  if (strategy === 'git-exclude') {
    const res = await resolveGitExcludeTarget(projectRoot);
    return { strategy, ...res };
  }
  const gitignorePath = path.join(projectRoot, '.gitignore');
  const info = await lstatOrNull(gitignorePath);
  if (info && (!info.isFile() || info.isSymbolicLink() || info.size > MAX_MANIFEST_BYTES)) {
    return { strategy: 'gitignore', targetPath: gitignorePath, conflict: true, unavailable: false };
  }
  return { strategy: 'gitignore', targetPath: gitignorePath, conflict: false, unavailable: false, existedBefore: Boolean(info) };
}

const VALID_MANAGED_BY = new Set(['nexakit', '@jcabr3ra1/agent-toolkit']);

async function readProjectToolkitManifest(projectRoot) {
  const manifestPath = path.join(projectRoot, PROJECT_TOOLKIT_DIR, PROJECT_MANIFEST_FILE);
  const info = await lstatOrNull(manifestPath);
  if (!info || !info.isFile() || info.isSymbolicLink() || info.size > MAX_MANIFEST_BYTES) return null;
  try {
    const parsed = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    if (
      parsed &&
      VALID_MANAGED_BY.has(parsed.managedBy) &&
      Array.isArray(parsed.entries)
    ) {
      return parsed;
    }
  } catch {}
  return null;
}

async function isLegacyToolkitLockfile(lockPath) {
  const info = await lstatOrNull(lockPath);
  if (!info || !info.isFile() || info.isSymbolicLink() || info.size > MAX_MANIFEST_BYTES) return null;
  try {
    const parsed = JSON.parse(await fs.readFile(lockPath, 'utf8'));
    if (parsed && VALID_MANAGED_BY.has(parsed.generatedBy) && typeof parsed.skills === 'object') {
      return parsed;
    }
  } catch {}
  return null;
}

async function hasManagedBlockInFile(filePath) {
  if (!filePath) return false;
  const info = await lstatOrNull(filePath);
  if (!info || !info.isFile() || info.isSymbolicLink() || info.size > MAX_MANIFEST_BYTES) return false;
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return content.includes(IGNORE_BLOCK_START) && content.includes(IGNORE_BLOCK_END);
  } catch {
    return false;
  }
}

async function findFallbackExternalToolkitLinks(projectRoot, resolvedToolkit, clients = ['codex', 'claude'], homeDir = os.homedir()) {
  try {
    const resolvedHome = await fs.realpath(homeDir);
    if (normalizedPath(projectRoot) === normalizedPath(resolvedHome)) return [];
  } catch {}
  const found = [];
  for (const client of clients) {
    const skillsDir = path.join(projectRoot, client === 'codex' ? '.agents' : '.claude', 'skills');
    const dirInfo = await lstatOrNull(skillsDir);
    if (!dirInfo || !dirInfo.isDirectory() || dirInfo.isSymbolicLink()) continue;
    const entries = await fs.readdir(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!SKILL_NAME_RE.test(entry.name)) continue;
      const full = path.join(skillsDir, entry.name);
      const info = await lstatOrNull(full);
      if (!info?.isSymbolicLink()) continue;
      try {
        const real = await fs.realpath(full);
        if (isWithinRoot(real, resolvedToolkit) && !isWithinRoot(real, projectRoot)) {
          found.push({
            client,
            name: entry.name,
            relativePath: `${client === 'codex' ? '.agents' : '.claude'}/skills/${entry.name}`,
            mode: 'symlink'
          });
        }
      } catch {}
    }
  }
  return found;
}

async function inspectProjectCoupling(projectRoot, resolvedToolkit) {
  const stateDir = path.join(projectRoot, PROJECT_TOOLKIT_DIR);
  const stateDirInfo = await lstatOrNull(stateDir);
  const hasStateDir = Boolean(stateDirInfo?.isDirectory() && !stateDirInfo.isSymbolicLink());
  const manifest = await readProjectToolkitManifest(projectRoot);
  const legacyLock = await isLegacyToolkitLockfile(path.join(projectRoot, PROJECT_LOCKFILE_NAME));
  const fallbackLinks = manifest ? [] : await findFallbackExternalToolkitLinks(projectRoot, resolvedToolkit);

  const gitignoreHasBlock = await hasManagedBlockInFile(path.join(projectRoot, '.gitignore'));
  const excludeRes = await resolveGitExcludeTarget(projectRoot);
  const excludeHasBlock = await hasManagedBlockInFile(excludeRes.targetPath);

  const managedEntriesCount = manifest
    ? manifest.entries.length
    : fallbackLinks.length + (legacyLock ? Object.keys(legacyLock.skills ?? {}).length : 0);

  return {
    coupled: Boolean(hasStateDir || managedEntriesCount > 0 || legacyLock || gitignoreHasBlock || excludeHasBlock),
    hasStateDir,
    gitIgnoreStrategy: manifest?.gitIgnoreStrategy ?? (excludeHasBlock ? 'git-exclude' : 'gitignore'),
    mode: manifest?.mode ?? null,
    managedEntriesCount
  };
}

function findApplicableScenario(skill, observedSignalIds, profile, client) {
  if (!client) return null;
  for (const scenario of skill.scenarios) {
    if (scenario.status !== 'passed') continue;
    if (scenario.revision !== skill.revision) continue;
    if (profile && scenario.profile !== profile) continue;
    if (!skill.matching.profiles.includes(scenario.profile)) continue;
    if (!skill.matching.taskClasses.includes(scenario.taskClass)) continue;
    if (scenario.client !== client) continue;
    if (!scenario.requiredSignals.every(req => observedSignalIds.has(req))) continue;
    return scenario;
  }
  return null;
}

export function recommendSkills({ catalog, inspection, profile, client, clients } = {}) {
  if (!catalog || !inspection) throw new Error('Se requieren catalog e inspection.');
  if (profile !== undefined && !VALID_PROFILES.has(profile)) {
    throw new Error('El perfil debe ser frontend, backend, mcp o security.');
  }
  if (client !== undefined && !VALID_CLIENTS.has(client)) {
    throw new Error('El filtro --client solo admite codex o claude.');
  }
  if (clients !== undefined && (!Array.isArray(clients) || clients.length === 0 || clients.some(value => !VALID_CLIENTS.has(value)) || new Set(clients).size !== clients.length)) {
    throw new Error('Los agentes destino deben ser una lista de codex y/o claude sin duplicados.');
  }
  const targetClients = clients ?? (client ? [client] : []);
  if (client && clients && (clients.length !== 1 || clients[0] !== client)) {
    throw new Error('Los filtros client y clients deben indicar el mismo agente.');
  }

  const observedIds = new Set(inspection.signals.map(s => s.id));
  const signalMap = new Map(inspection.signals.map(s => [s.id, s]));
  const installedByName = new Map();
  for (const inst of inspection.installed) {
    if (!installedByName.has(inst.name) || inst.integrity === 'verified') {
      installedByName.set(inst.name, inst);
    }
  }

  const recommended = [];
  const candidates = [];
  const optional = [];
  const coveredSignals = new Set(['nodejs', 'typescript']);

  for (const skill of catalog.skills) {
    if (skill.review.status === 'rejected') continue;

    const matchedSignals = skill.matching.anySignals.filter(sig => observedIds.has(sig));
    for (const sig of matchedSignals) coveredSignals.add(sig);
    const matchedProfile = Boolean(profile && skill.matching.profiles.includes(profile));
    const installed = installedByName.get(skill.name) ?? null;

    if (matchedSignals.length === 0 && !matchedProfile) {
      optional.push({
        name: skill.name,
        summary: skill.summary,
        license: skill.license,
        revision: skill.revision,
        installedPath: skill.installedPath,
        profiles: [...skill.matching.profiles],
        recommendationStatus: 'optional',
        reasons: [],
        overlapsWith: [...skill.overlapsWith],
        reviewStatus: skill.review.status,
        reviewNotes: skill.review.notes,
        filesCount: skill.files.length,
        installed,
        installableFromToolkit: true
      });
      continue;
    }

    const reasons = [
      ...matchedSignals.map(sig => `${SIGNAL_LABELS[sig] ?? sig} (${signalMap.get(sig).sources[0]})`),
      ...(matchedProfile ? [`perfil ${profile}`] : [])
    ];
    const scenarios = targetClients.map(target => ({ client: target, scenario: findApplicableScenario(skill, observedIds, profile, target) }));
    const allScenariosPassed = scenarios.length > 0 && scenarios.every(item => item.scenario);

    const baseItem = {
      name: skill.name,
      summary: skill.summary,
      license: skill.license,
      revision: skill.revision,
      installedPath: skill.installedPath,
      reasons,
      matchedSignals,
      overlapsWith: [...skill.overlapsWith],
      reviewStatus: skill.review.status,
      reviewNotes: skill.review.notes,
      filesCount: skill.files.length,
      installed,
      installableFromToolkit: true
    };

    if (allScenariosPassed && skill.review.status !== 'pending') {
      recommended.push({
        ...baseItem,
        recommendationStatus: 'validated',
        taskClass: scenarios[0].scenario.taskClass,
        evidencePath: scenarios[0].scenario.evidencePath,
        evidence: scenarios.map(({ client: target, scenario }) => ({ client: target, scenarioId: scenario.id, taskClass: scenario.taskClass, evidencePath: scenario.evidencePath }))
      });
    } else {
      const pendingReasons = [];
      if (skill.review.status === 'pending') pendingReasons.push('revisión de contenido pendiente');
      if (targetClients.length === 0) pendingReasons.push('indica --client para comprobar un escenario del agente destino');
      for (const item of scenarios) {
        if (!item.scenario) pendingReasons.push(`sin escenario funcional pasado aplicable a ${item.client}`);
      }
      candidates.push({
        ...baseItem,
        recommendationStatus: 'compatible',
        pendingReasons
      });
    }
  }

  optional.sort((a, b) => a.name.localeCompare(b.name));
  // The skills that match more of what was detected come first; ties by name.
  const byMatches = (a, b) => b.matchedSignals.length - a.matchedSignals.length || a.name.localeCompare(b.name);
  recommended.sort(byMatches);
  candidates.sort(byMatches);

  const externalCandidates = [];
  for (const ref of catalog.externalReferences) {
    const matchedSignals = ref.anySignals.filter(sig => observedIds.has(sig));
    for (const sig of matchedSignals) coveredSignals.add(sig);
    const matchedProfile = Boolean(profile && ref.profiles.includes(profile));
    if (matchedSignals.length === 0 && !matchedProfile) continue;
    externalCandidates.push({
      name: ref.name,
      summary: ref.summary,
      sourceUrl: ref.sourceUrl,
      reasons: [
        ...matchedSignals.map(sig => SIGNAL_LABELS[sig] ?? sig),
        ...(matchedProfile ? [`perfil ${profile}`] : [])
      ],
      statusNote: ref.statusNote,
      installableFromToolkit: false
    });
  }

  const unmatchedSignals = inspection.signals
    .filter(sig => !coveredSignals.has(sig.id))
    .map(sig => ({ id: sig.id, label: sig.label }));

  return {
    projectName: inspection.projectName,
    projectRoot: inspection.projectRoot,
    profile: profile ?? null,
    client: client ?? null,
    clients: [...targetClients],
    signals: inspection.signals,
    recommended,
    candidates,
    optional,
    externalCandidates,
    unmatchedSignals,
    addons: catalog.addons,
    installed: inspection.installed,
    coupling: inspection.coupling ?? null,
    limits: inspection.limits
  };
}

async function ensureSafeProjectParents(projectRoot, target, create = false) {
  let current = projectRoot;
  for (const part of path.relative(projectRoot, path.dirname(target)).split(path.sep)) {
    if (!part) continue;
    current = path.join(current, part);
    let info = await lstatOrNull(current);
    if (!info && create) {
      await fs.mkdir(current, { mode: 0o755 }).catch(err => {
        if (err.code !== 'EEXIST') throw err;
      });
      info = await lstatOrNull(current);
    }
    if (info && (!info.isDirectory() || info.isSymbolicLink())) {
      throw new Error(`Un directorio padre en el proyecto está ocupado o es un enlace: ${current}`);
    }
  }
}

async function projectTargetState(source, target, mode, catalogEntry) {
  const info = await lstatOrNull(target);
  if (!info) return 'missing';
  if (mode === 'symlink') {
    if (!info.isSymbolicLink()) return 'conflict';
    try {
      const [actual, expected] = await Promise.all([fs.realpath(target), fs.realpath(source)]);
      return normalizedPath(actual) === normalizedPath(expected) ? 'installed' : 'replace';
    } catch (err) {
      if (err.code === 'ENOENT') return 'replace';
      throw err;
    }
  }
  // mode === 'copy': links are classified by the planner; here one is never assumed replaceable.
  if (info.isSymbolicLink()) return 'conflict';
  if (info.isDirectory() && catalogEntry) {
    const integrity = await verifyCatalogIntegrity(target, catalogEntry);
    return integrity === 'verified' ? 'installed' : 'conflict';
  }
  return 'conflict';
}

export async function planProjectSkillInstall({
  projectRoot,
  skillNames,
  agent = 'all',
  mode = 'symlink',
  gitIgnore = 'gitignore',
  catalog,
  toolkitRoot = TOOLKIT_ROOT,
  linkRoot,
  homeDirectory = os.homedir()
} = {}) {
  if (!['codex', 'claude', 'antigravity', 'all'].includes(agent)) {
    throw new Error('El agente debe ser codex, claude, antigravity o all.');
  }
  if (!VALID_INSTALL_MODES.has(mode)) {
    throw new Error('El modo de instalación debe ser symlink o copy.');
  }
  if (!VALID_GIT_IGNORE.has(gitIgnore)) {
    throw new Error('La estrategia gitIgnore debe ser gitignore, git-exclude o none.');
  }
  const clients = projectClientsFor(agent);
  const root = await fs.realpath(projectRoot);
  const resolvedToolkit = await fs.realpath(toolkitRoot);
  const home = await fs.realpath(homeDirectory).catch(() => path.resolve(homeDirectory));
  const roots = await resolveRoots({ toolkitRoot: resolvedToolkit, homeDirectory: home });
  // An explicit linkRoot means the caller chose where to link, so no stable copy is made.
  const linkRootPath = linkRoot ? path.resolve(linkRoot) : roots.linkRoot;
  const ephemeral = !linkRoot && roots.ephemeral;
  const activeCatalog = catalog ?? await loadSkillCatalog();
  const catalogByName = new Map(activeCatalog.skills.map(s => [s.name, s]));
  const uniqueSkills = [...new Set(skillNames ?? [])].sort();

  // A broken link is nexakit's only with proof: the install registry (the exact link), or this project's
  // manifest. An entry written by this version records the exact link too; one from 0.1.0 only has the path,
  // so its link must at least have nexakit's own shape: `<root>/<where this skill lives in nexakit>`.
  const registry = await readRegistry(nexakitDir(home));
  const previousManifest = await readProjectToolkitManifest(root);
  const manifested = new Map((previousManifest?.entries ?? []).filter(entry => entry?.relativePath).map(entry => [entry.relativePath, entry]));
  const ownedBy = suffix => (target, literal) => {
    if (isRegistered(registry, target, literal)) return true;
    const entry = manifested.get(path.relative(root, target).split(path.sep).join('/'));
    if (!entry) return false;
    if (typeof entry.apunta === 'string') return entry.apunta === literal;
    return path.resolve(path.dirname(target), literal).endsWith(path.sep + path.normalize(suffix));
  };
  const activeRoots = [linkRootPath, resolvedToolkit, actualRoot(home)];

  const links = [];
  const verifiedCatalogEntries = new Map();

  for (const skillName of uniqueSkills) {
    if (!SKILL_NAME_RE.test(skillName)) throw new Error(`Nombre de skill inválido: ${skillName}`);
    const catalogEntry = catalogByName.get(skillName) ?? null;
    let source;

    if (catalogEntry) {
      const check = await verifyBundledSkillHashes({ skillEntry: catalogEntry, toolkitRoot: resolvedToolkit });
      if (!check.ok) throw new Error(check.reason);
      source = check.sourceDir;
      verifiedCatalogEntries.set(skillName, catalogEntry);
    } else {
      source = path.join(resolvedToolkit, 'skills', skillName);
      const skillMd = await lstatOrNull(path.join(source, 'SKILL.md'));
      if (!skillMd?.isFile() || skillMd.isSymbolicLink()) {
        throw new Error(`No existe la skill empaquetada ${skillName} en Agent Toolkit.`);
      }
    }

    for (const client of clients) {
      const target = path.join(root, client === 'codex' ? '.agents' : '.claude', 'skills', skillName);
      await ensureSafeProjectParents(root, target, false);
      const serves = servesFor(client, agent);
      const suffix = path.relative(resolvedToolkit, source);
      if (mode === 'symlink') {
        const info = await classifyLink({ target, suffix, activeRoots, isOwned: ownedBy(suffix) });
        links.push({
          client, serves, name: skillName, source: path.join(linkRootPath, suffix), target, mode,
          state: COARSE_STATE[info.state], linkState: info.state,
          ...(info.literal && { literal: info.literal }), ...(info.root && { root: info.root })
        });
        continue;
      }
      if ((await lstatOrNull(target))?.isSymbolicLink()) {
        // A link where a copy goes is replaced only when it is provably nexakit's; any other link is the user's.
        const info = await classifyLink({ target, suffix, activeRoots, isOwned: ownedBy(suffix) });
        const ours = ['instalado', 'otra-copia', 'efimero', 'roto-propio'].includes(info.state);
        links.push({
          client, serves, name: skillName, source, target, mode, state: ours ? 'replace' : 'conflict',
          linkState: info.state, ...(info.literal && { literal: info.literal })
        });
        continue;
      }
      const state = await projectTargetState(source, target, mode, catalogEntry);
      links.push({ client, serves, name: skillName, source, target, state, mode });
    }
  }

  const stateDirPath = path.join(root, PROJECT_TOOLKIT_DIR);
  const stateDirInfo = await lstatOrNull(stateDirPath);
  const manifestPath = path.join(stateDirPath, PROJECT_MANIFEST_FILE);
  const manifestInfo = stateDirInfo?.isDirectory() && !stateDirInfo.isSymbolicLink()
    ? await lstatOrNull(manifestPath)
    : null;
  const stateDirConflict = Boolean(
    (stateDirInfo && (!stateDirInfo.isDirectory() || stateDirInfo.isSymbolicLink())) ||
    (manifestInfo && (!manifestInfo.isFile() || manifestInfo.isSymbolicLink()))
  );

  const lockfilePath = path.join(stateDirPath, PROJECT_LOCKFILE_NAME);
  const lockInfo = stateDirInfo?.isDirectory() && !stateDirInfo.isSymbolicLink()
    ? await lstatOrNull(lockfilePath)
    : null;
  const lockfileConflict = Boolean(mode === 'copy' && lockInfo && (!lockInfo.isFile() || lockInfo.isSymbolicLink()));

  const hasValidTargets = uniqueSkills.length > 0 && links.some(l => ['missing', 'replace', 'installed'].includes(l.state));
  const willWriteManifest = Boolean(!stateDirConflict && hasValidTargets);
  const willWriteLockfile = Boolean(mode === 'copy' && !stateDirConflict && !lockfileConflict && hasValidTargets);

  const gitIgnoreInfo = await inspectGitIgnoreTarget(root, gitIgnore);
  const gitIgnoreConflict = Boolean(gitIgnore !== 'none' && gitIgnoreInfo.conflict);
  const willUpdateGitIgnore = Boolean(
    gitIgnore !== 'none' &&
    !gitIgnoreConflict &&
    !gitIgnoreInfo.unavailable &&
    willWriteManifest
  );

  return {
    applied: false,
    mode,
    gitIgnore,
    projectRoot: root,
    toolkitRoot: resolvedToolkit,
    linkRoot: linkRootPath,
    ephemeral,
    homeDirectory: home,
    agent,
    links,
    stateDirPath,
    manifestPath,
    stateDirConflict,
    lockfilePath,
    willWriteManifest,
    willWriteLockfile,
    lockfileConflict,
    gitIgnoreTarget: gitIgnoreInfo.targetPath,
    gitIgnoreUnavailable: Boolean(gitIgnoreInfo.unavailable),
    gitIgnoreConflict,
    willUpdateGitIgnore,
    verifiedCatalogEntries: Object.fromEntries(verifiedCatalogEntries),
    created: 0,
    conflicts:
      links.filter(l => l.state === 'conflict').length +
      (stateDirConflict ? 1 : 0) +
      (lockfileConflict ? 1 : 0) +
      (gitIgnoreConflict ? 1 : 0)
  };
}

async function copyVerifiedSkillDirectory(sourceDir, targetDir, catalogEntry, lock) {
  await lock?.assertHeld();
  await fs.mkdir(targetDir, { recursive: true, mode: 0o755 });
  if (catalogEntry) {
    for (const file of catalogEntry.files) {
      const srcFile = path.join(sourceDir, file.path);
      const dstFile = path.join(targetDir, file.path);
      const bytes = await fs.readFile(srcFile);
      const actualHash = createHash('sha256').update(bytes).digest('hex');
      if (actualHash !== file.sha256) {
        throw new Error(`Integridad SHA-256 rechazada durante la copia de ${catalogEntry.name} (${file.path}).`);
      }
      await lock?.assertHeld();
      await fs.mkdir(path.dirname(dstFile), { recursive: true, mode: 0o755 });
      await fs.writeFile(dstFile, bytes, { mode: 0o644 });
    }
  } else {
    await lock?.assertHeld();
    await fs.cp(sourceDir, targetDir, { recursive: true, dereference: false });
  }
}

async function writeSkillsLockfile(lockfilePath, activeEntriesBySkill, lock) {
  await lock?.assertHeld();
  await fs.mkdir(path.dirname(lockfilePath), { recursive: true, mode: 0o755 });
  const existingInfo = await lstatOrNull(lockfilePath);
  if (existingInfo && (!existingInfo.isFile() || existingInfo.isSymbolicLink())) {
    return false;
  }
  let baseSkills = {};
  if (existingInfo) {
    try {
      const parsed = JSON.parse(await fs.readFile(lockfilePath, 'utf8'));
      if (parsed && typeof parsed.skills === 'object' && !Array.isArray(parsed.skills)) {
        baseSkills = { ...parsed.skills };
      }
    } catch {
      return false;
    }
  }

  for (const [name, { catalogEntry, clients }] of activeEntriesBySkill.entries()) {
    if (!catalogEntry) continue;
    const prevClients = Array.isArray(baseSkills[name]?.clients) ? baseSkills[name].clients : [];
    const mergedClients = [...new Set([...prevClients, ...clients])].sort();
    baseSkills[name] = {
      repository: catalogEntry.repository,
      sourcePath: catalogEntry.sourcePath,
      revision: catalogEntry.revision,
      license: catalogEntry.license,
      clients: mergedClients,
      files: catalogEntry.files.map(f => ({ path: f.path, sha256: f.sha256 }))
    };
  }

  const sortedSkills = Object.fromEntries(
    Object.keys(baseSkills).sort().map(k => [k, baseSkills[k]])
  );

  const payload = {
    lockfileVersion: 1,
    generatedBy: 'nexakit',
    skills: sortedSkills
  };
  await lock?.assertHeld();
  await fs.writeFile(lockfilePath, JSON.stringify(payload, null, 2) + '\n', { mode: 0o644 });
  return true;
}

async function writeProjectManifestAndIgnore({
  projectRoot,
  mode,
  gitIgnore,
  prevManifest,
  coupledEntriesMap,
  lock,
  answers = prevManifest?.answers
}) {
  const stateDir = path.join(projectRoot, PROJECT_TOOLKIT_DIR);
  const stateStat = await lstatOrNull(stateDir);
  if (stateStat && (!stateStat.isDirectory() || stateStat.isSymbolicLink())) {
    return { manifestWritten: false, gitIgnoreUpdated: false };
  }
  await lock?.assertHeld();
  await fs.mkdir(stateDir, { recursive: true, mode: 0o755 });

  const entries = [...coupledEntriesMap.values()].sort((a, b) =>
    a.relativePath.localeCompare(b.relativePath)
  );

  let createdIgnoreFile = Boolean(prevManifest?.createdIgnoreFile);
  let gitIgnoreUpdated = false;

  if (gitIgnore !== 'none') {
    const info = await inspectGitIgnoreTarget(projectRoot, gitIgnore);
    if (!info.conflict && !info.unavailable && info.targetPath) {
      await lock?.assertHeld();
      await fs.mkdir(path.dirname(info.targetPath), { recursive: true, mode: 0o755 });
      const currentStat = await lstatOrNull(info.targetPath);
      if (!currentStat) {
        if (gitIgnore === 'gitignore') createdIgnoreFile = true;
        const nextText = upsertManagedIgnoreBlock('', entries.map(e => e.relativePath));
        await lock?.assertHeld();
        await fs.writeFile(info.targetPath, nextText, { mode: 0o644 });
        gitIgnoreUpdated = true;
      } else if (currentStat.isFile() && !currentStat.isSymbolicLink()) {
        const prevText = await fs.readFile(info.targetPath, 'utf8');
        const nextText = upsertManagedIgnoreBlock(prevText, entries.map(e => e.relativePath));
        if (nextText !== prevText) {
          await lock?.assertHeld();
          await fs.writeFile(info.targetPath, nextText, { mode: 0o644 });
        }
        gitIgnoreUpdated = true;
      }

      // Clean stale block from the other ignore location if user switched strategy
      const otherStrategy = gitIgnore === 'gitignore' ? 'git-exclude' : 'gitignore';
      const otherInfo = await inspectGitIgnoreTarget(projectRoot, otherStrategy);
      if (!otherInfo.conflict && !otherInfo.unavailable && otherInfo.targetPath) {
        const otherStat = await lstatOrNull(otherInfo.targetPath);
        if (otherStat?.isFile() && !otherStat.isSymbolicLink()) {
          const otherText = await fs.readFile(otherInfo.targetPath, 'utf8');
          const cleaned = removeManagedIgnoreBlock(otherText);
          if (cleaned.changed) {
            await lock?.assertHeld();
            if (!cleaned.content && otherStrategy === 'gitignore' && prevManifest?.createdIgnoreFile) {
              await fs.unlink(otherInfo.targetPath).catch(() => {});
              createdIgnoreFile = false;
            } else {
              await fs.writeFile(otherInfo.targetPath, cleaned.content, { mode: 0o644 });
            }
          }
        }
      }
    }
  }

  const manifestPayload = {
    manifestVersion: 1,
    managedBy: 'nexakit',
    mode,
    gitIgnoreStrategy: gitIgnore,
    createdIgnoreFile,
    entries,
    ...(answers && { answers })
  };
  // A manifest that is a link or not a regular file is not nexakit's: it is never written through.
  const manifestPath = path.join(stateDir, PROJECT_MANIFEST_FILE);
  const manifestStat = await lstatOrNull(manifestPath);
  if (manifestStat && (!manifestStat.isFile() || manifestStat.isSymbolicLink())) {
    return { manifestWritten: false, gitIgnoreUpdated };
  }
  const temporary = `${manifestPath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(manifestPayload, null, 2) + '\n', { mode: 0o644, flag: 'wx' });
  try {
    await lock?.assertHeld();
    await fs.rename(temporary, manifestPath);
  } finally {
    await fs.rm(temporary, { force: true }); // ours: created exclusively above
  }
  return { manifestWritten: true, gitIgnoreUpdated };
}

// Links are written under the install lock: it prepares the stable copy when running from an npx cache,
// re-checks the hashes where the links will point, and records every link so a broken one can be proven ours.
export async function applyProjectSkillInstall(plan, { runNpm, packageSpec, lockOptions, acquire = acquireLock } = {}) {
  if (!plan || !Array.isArray(plan.links) || !plan.projectRoot) {
    throw new Error('Se requiere una vista previa válida de instalación de skills.');
  }
  const mode = plan.mode ?? 'symlink';
  const gitIgnore = plan.gitIgnore ?? 'gitignore';
  // Anything that writes (links, copies, the manifest, ignore rules or the lockfile) runs under the lock.
  // With nothing to write, nothing is written, so a run that changes nothing never creates ~/.nexakit.
  const pending = plan.links.some(l => ['missing', 'replace'].includes(l.state));
  const previous = await readProjectToolkitManifest(plan.projectRoot);
  const settingsChanged = Boolean(previous) && (previous.mode !== mode || previous.gitIgnoreStrategy !== gitIgnore);
  if (!pending && !settingsChanged) return applyProjectSkillInstallLocked(plan, { registryEntries: [], lock: null, writeMetadata: false });

  const home = plan.homeDirectory ?? os.homedir();
  const lock = await acquire(nexakitDir(home), lockOptions);
  const registryEntries = [];
  try {
    if (mode === 'symlink' && pending) {
      if (plan.ephemeral) {
        const { version } = JSON.parse(await fs.readFile(path.join(plan.toolkitRoot ?? TOOLKIT_ROOT, 'package.json'), 'utf8'));
        await ensureStableInstall({
          homeDirectory: home, version, lock, ...(runNpm && { runNpm }), ...(packageSpec && { packageSpec })
        });
      }
      const linkRoot = plan.linkRoot ?? plan.toolkitRoot ?? TOOLKIT_ROOT;
      if (path.resolve(linkRoot) !== path.resolve(plan.toolkitRoot ?? TOOLKIT_ROOT)) {
        // The files that get linked are the ones in linkRoot, so their hashes must hold there too.
        for (const entry of Object.values(plan.verifiedCatalogEntries ?? {})) {
          const check = await verifyBundledSkillHashes({ skillEntry: entry, toolkitRoot: linkRoot });
          if (!check.ok) throw new Error(check.reason);
        }
      }
    }
    const result = await applyProjectSkillInstallLocked(plan, { registryEntries, lock, writeMetadata: true });
    await recordEntries(nexakitDir(home), registryEntries, lock);
    return result;
  } finally {
    await lock.release();
  }
}

// `lock` is null only when nothing will be written; every write checks it still holds the lock just before.
async function applyProjectSkillInstallLocked(plan, { registryEntries, lock, writeMetadata }) {
  const mode = plan.mode ?? 'symlink';
  const gitIgnore = plan.gitIgnore ?? 'gitignore';
  const catalogEntries = plan.verifiedCatalogEntries ?? {};

  // Re-verify SHA-256 of every catalog skill right before writing
  for (const entry of Object.values(catalogEntries)) {
    const check = await verifyBundledSkillHashes({
      skillEntry: entry,
      toolkitRoot: plan.toolkitRoot ?? TOOLKIT_ROOT
    });
    if (!check.ok) throw new Error(check.reason);
  }

  const prevManifest = await readProjectToolkitManifest(plan.projectRoot);
  const coupledEntriesMap = new Map();
  if (prevManifest) {
    for (const entry of prevManifest.entries) {
      if (!entry?.relativePath) continue;
      const existing = await lstatOrNull(path.join(plan.projectRoot, entry.relativePath));
      if (existing) coupledEntriesMap.set(`${entry.client}:${entry.name}`, entry);
    }
  }

  let created = 0;
  const updatedLinks = [];
  const installedClientsBySkill = new Map();

  for (const item of plan.links) {
    const catalogEntry = catalogEntries[item.name] ?? null;
    const relPath = `${item.client === 'codex' ? '.agents' : '.claude'}/skills/${item.name}`;

    if (!['missing', 'replace'].includes(item.state)) {
      if (item.state === 'installed' && coupledEntriesMap.has(`${item.client}:${item.name}`)) {
        const list = installedClientsBySkill.get(item.name) ?? [];
        list.push(item.client);
        installedClientsBySkill.set(item.name, list);
      }
      updatedLinks.push({ ...item });
      continue;
    }

    await lock?.assertHeld();
    await ensureSafeProjectParents(plan.projectRoot, item.target, true);
    let literal;
    if (mode === 'symlink') {
      // Re-reads the link right before writing: if it is no longer what the plan saw, it is left alone.
      await lock?.assertHeld();
      const outcome = await relinkIfUnchanged({
        target: item.target, expectedLiteral: item.linkState === 'falta' ? null : item.literal, source: item.source, relative: true
      });
      if (outcome === 'cambio') {
        updatedLinks.push({ ...item, state: 'conflict', changed: true });
        continue;
      }
      // The registry and the manifest keep what readlink returns, the value that is compared later.
      literal = await fs.readlink(item.target);
      registryEntries.push({ destino: item.target, apunta: literal, raiz: plan.linkRoot ?? plan.toolkitRoot });
    } else {
      const current = await lstatOrNull(item.target);
      if (current?.isSymbolicLink()) {
        // Only a link the plan proved to be nexakit's becomes a copy, and only if it did not change since.
        if (item.state !== 'replace' || !item.literal || await fs.readlink(item.target) !== item.literal) {
          updatedLinks.push({ ...item, state: 'conflict', changed: true });
          continue;
        }
        await lock?.assertHeld();
        await fs.unlink(item.target);
      } else {
        const currentState = await projectTargetState(item.source, item.target, mode, catalogEntry);
        if (currentState === 'conflict') {
          updatedLinks.push({ ...item, state: 'conflict' });
          continue;
        }
        if (currentState === 'installed') {
          if (coupledEntriesMap.has(`${item.client}:${item.name}`)) {
            const list = installedClientsBySkill.get(item.name) ?? [];
            list.push(item.client);
            installedClientsBySkill.set(item.name, list);
          }
          updatedLinks.push({ ...item, state: 'installed' });
          continue;
        }
      }
      await copyVerifiedSkillDirectory(item.source, item.target, catalogEntry, lock);
    }

    created++;
    coupledEntriesMap.set(`${item.client}:${item.name}`, {
      client: item.client,
      name: item.name,
      relativePath: relPath,
      mode,
      ...(literal && { apunta: literal }),
      ...(catalogEntry?.revision && { revision: catalogEntry.revision })
    });
    const list = installedClientsBySkill.get(item.name) ?? [];
    list.push(item.client);
    installedClientsBySkill.set(item.name, list);
    updatedLinks.push({ ...item, state: 'installed' });
  }

  let lockfileWritten = false;
  if (writeMetadata && mode === 'copy' && !plan.stateDirConflict && !plan.lockfileConflict && installedClientsBySkill.size > 0) {
    const activeMap = new Map();
    for (const [skillName, clients] of installedClientsBySkill.entries()) {
      const catalogEntry = catalogEntries[skillName];
      if (catalogEntry) activeMap.set(skillName, { catalogEntry, clients });
    }
    if (activeMap.size > 0) {
      lockfileWritten = await writeSkillsLockfile(
        plan.lockfilePath ?? path.join(plan.projectRoot, PROJECT_TOOLKIT_DIR, PROJECT_LOCKFILE_NAME),
        activeMap,
        lock
      );
    }
  }

  let manifestWritten = false;
  let gitIgnoreUpdated = false;
  if (writeMetadata && !plan.stateDirConflict && (coupledEntriesMap.size > 0 || lockfileWritten)) {
    const res = await writeProjectManifestAndIgnore({
      projectRoot: plan.projectRoot,
      mode,
      gitIgnore,
      prevManifest,
      coupledEntriesMap,
      lock
    });
    manifestWritten = res.manifestWritten;
    gitIgnoreUpdated = res.gitIgnoreUpdated;
  }

  return {
    applied: true,
    mode,
    gitIgnore,
    projectRoot: plan.projectRoot,
    links: updatedLinks,
    manifestWritten,
    lockfileWritten,
    gitIgnoreUpdated,
    created,
    conflicts:
      updatedLinks.filter(l => l.state === 'conflict').length +
      (plan.stateDirConflict ? 1 : 0) +
      (plan.lockfileConflict ? 1 : 0) +
      (plan.gitIgnoreConflict ? 1 : 0)
  };
}

export async function planProjectSkillLinks(options = {}) {
  return planProjectSkillInstall({ ...options, mode: 'symlink' });
}

export async function applyProjectSkillLinks(plan) {
  return applyProjectSkillInstall({ ...plan, mode: 'symlink' });
}

// The answers given to `npx nexakit` (skills chosen and discarded, agents, memory), kept in the project manifest
// so a second run knows what was decided and does not ask again.
const isNameList = value => Array.isArray(value) && value.every(item => typeof item === 'string' && SKILL_NAME_RE.test(item));
function validSetupAnswers(answers) {
  return Boolean(answers && answers.version === 1 &&
    isNameList(answers.skills?.chosen) && isNameList(answers.skills?.discarded) &&
    Array.isArray(answers.agents) && answers.agents.every(agent => ['claude', 'codex', 'antigravity'].includes(agent)) &&
    (answers.memory?.decision === 'later' ||
      (answers.memory?.decision === 'path' && typeof answers.memory.path === 'string' && path.isAbsolute(answers.memory.path))));
}

export async function readSetupAnswers(projectRoot) {
  const manifest = await readProjectToolkitManifest(projectRoot);
  return validSetupAnswers(manifest?.answers) ? manifest.answers : null;
}

export async function writeSetupAnswers(projectRoot, answers, lock) {
  if (!validSetupAnswers(answers)) throw new Error('Respuestas de nexakit no válidas.');
  await lock.assertHeld();
  const prevManifest = await readProjectToolkitManifest(projectRoot);
  const result = await writeProjectManifestAndIgnore({
    projectRoot,
    mode: prevManifest?.mode ?? 'symlink',
    gitIgnore: prevManifest?.gitIgnoreStrategy ?? 'gitignore',
    prevManifest,
    coupledEntriesMap: new Map((prevManifest?.entries ?? []).map(entry => [entry.relativePath, entry])),
    lock,
    answers
  });
  if (!result.manifestWritten) throw new Error(`${PROJECT_TOOLKIT_DIR} no es una carpeta normal; no se guardaron las respuestas.`);
}

export async function planToolkitDetach({
  projectRoot,
  includeGlobal = false,
  agent = 'all',
  catalog,
  toolkitRoot = TOOLKIT_ROOT,
  homeDirectory = os.homedir(),
  codexHome,
  environment = {},
  skillNames
} = {}) {
  if (!['codex', 'claude', 'antigravity', 'all'].includes(agent)) {
    throw new Error('El agente debe ser codex, claude, antigravity o all.');
  }
  const clients = agent === 'all' ? ['codex', 'claude', 'antigravity'] : [agent];
  // Antigravity shares Codex's project folder, so removing one's project links removes the other's.
  const projectClients = [...new Set(clients.map(c => (c === 'antigravity' ? 'codex' : c)))];
  const resolvedToolkit = await fs.realpath(toolkitRoot);
  const homeReal = await fs.realpath(homeDirectory).catch(() => path.resolve(homeDirectory));
  // Links made from an npx run point into the stable copy, which is nexakit's too.
  const stableVersions = path.join(nexakitDir(homeReal), 'versiones');
  const registry = await readRegistry(nexakitDir(homeReal));
  const activeCatalog = catalog ?? await loadSkillCatalog();
  const catalogByName = new Map(activeCatalog.skills.map(s => [s.name, s]));

  const items = [];
  const gitIgnoreUpdates = [];
  let root = null;
  let manifest = null;
  let removeStateDir = false;
  let removeLegacyLockfile = false;
  let remainingManifestEntries = [];

  if (projectRoot) {
    root = await fs.realpath(projectRoot);
    manifest = await readProjectToolkitManifest(root);
    const legacyLockPath = path.join(root, PROJECT_LOCKFILE_NAME);
    const legacyLock = await isLegacyToolkitLockfile(legacyLockPath);

    let candidateEntries = [];
    if (manifest) {
      // With skillNames only those skills go; the rest of the entries stay in the manifest.
      const removing = e => projectClients.includes(e.client) && (!skillNames || skillNames.includes(e.name));
      candidateEntries = manifest.entries.filter(removing);
      remainingManifestEntries = manifest.entries.filter(e => !removing(e));
    } else {
      const extLinks = await findFallbackExternalToolkitLinks(root, resolvedToolkit, projectClients, homeDirectory);
      const seenKeys = new Set(extLinks.map(e => `${e.client}:${e.name}`));
      candidateEntries = [...extLinks];
      if (legacyLock) {
        for (const [skillName, meta] of Object.entries(legacyLock.skills ?? {})) {
          const lockClients = Array.isArray(meta?.clients) ? meta.clients : ['codex', 'claude'];
          for (const client of lockClients) {
            if (!projectClients.includes(client) || seenKeys.has(`${client}:${skillName}`)) continue;
            candidateEntries.push({
              client,
              name: skillName,
              relativePath: `${client === 'codex' ? '.agents' : '.claude'}/skills/${skillName}`,
              mode: 'copy'
            });
          }
        }
      }
    }

    if (skillNames) candidateEntries = candidateEntries.filter(entry => skillNames.includes(entry.name));
    for (const entry of candidateEntries) {
      if (!SKILL_NAME_RE.test(entry.name)) continue;
      const target = path.join(root, entry.client === 'codex' ? '.agents' : '.claude', 'skills', entry.name);
      const relTarget = `${entry.client === 'codex' ? '.agents' : '.claude'}/skills/${entry.name}`;
      const info = await lstatOrNull(target);
      if (!info) continue;

      if (info.isSymbolicLink()) {
        let safeToUnlink = Boolean(manifest);
        try {
          const real = await fs.realpath(target);
          safeToUnlink = (isWithinRoot(real, resolvedToolkit) || isWithinRoot(real, stableVersions)) && !isWithinRoot(real, root);
        } catch (err) {
          if (err.code !== 'ENOENT') throw err;
        }
        items.push({
          scope: 'project',
          client: entry.client,
          name: entry.name,
          target,
          relativePath: relTarget,
          action: safeToUnlink ? 'remove-link' : 'conflict',
          reason: safeToUnlink ? 'enlace gestionado por Agent Toolkit' : 'enlace apunta fuera de Agent Toolkit'
        });
      } else if (info.isDirectory()) {
        const catEntry = catalogByName.get(entry.name) ?? null;
        const integrity = await verifyCatalogIntegrity(target, catEntry);
        items.push({
          scope: 'project',
          client: entry.client,
          name: entry.name,
          target,
          relativePath: relTarget,
          action: integrity === 'verified' ? 'remove-copy' : 'conflict',
          reason: integrity === 'verified' ? 'copia verificada sin cambios locales' : 'carpeta modificada localmente (no se borra)',
          ...(catEntry && { catalogEntry: catEntry })
        });
      } else {
        items.push({
          scope: 'project',
          client: entry.client,
          name: entry.name,
          target,
          relativePath: relTarget,
          action: 'conflict',
          reason: 'archivo no esperado (no se borra)'
        });
      }
    }

    const projectConflicts = items.filter(i => i.scope === 'project' && i.action === 'conflict').length;
    const stateDir = path.join(root, PROJECT_TOOLKIT_DIR);
    const stateDirInfo = await lstatOrNull(stateDir);
    if (stateDirInfo?.isDirectory() && !stateDirInfo.isSymbolicLink() && remainingManifestEntries.length === 0 && projectConflicts === 0) {
      removeStateDir = true;
    }
    if (legacyLock && remainingManifestEntries.length === 0 && projectConflicts === 0) {
      removeLegacyLockfile = true;
    }

    // Check .gitignore and .git/info/exclude for managed blocks
    const gitignorePath = path.join(root, '.gitignore');
    if (await hasManagedBlockInFile(gitignorePath)) {
      gitIgnoreUpdates.push({
        strategy: 'gitignore',
        targetPath: gitignorePath,
        relativePath: '.gitignore',
        action: remainingManifestEntries.length > 0 ? 'update-block' : 'remove-block',
        deleteIfEmpty: Boolean(manifest?.createdIgnoreFile && remainingManifestEntries.length === 0)
      });
    }
    const excludeRes = await resolveGitExcludeTarget(root);
    if (!excludeRes.conflict && !excludeRes.unavailable && await hasManagedBlockInFile(excludeRes.targetPath)) {
      gitIgnoreUpdates.push({
        strategy: 'git-exclude',
        targetPath: excludeRes.targetPath,
        relativePath: '.git/info/exclude',
        action: remainingManifestEntries.length > 0 ? 'update-block' : 'remove-block',
        deleteIfEmpty: false
      });
    }
  }

  const manualCommands = [];
  if (includeGlobal) {
    const home = await fs.realpath(homeDirectory);
    const resolvedCodexHome = codexHome ?? environment.CODEX_HOME ?? path.join(home, '.codex');
    const bundledSkillsDir = path.join(resolvedToolkit, 'skills');
    const bundledNames = (await fs.readdir(bundledSkillsDir, { withFileTypes: true }).catch(() => []))
      .filter(e => e.isDirectory() && SKILL_NAME_RE.test(e.name))
      .map(e => e.name)
      .sort();

    for (const client of clients) {
      for (const name of bundledNames) {
        const target = globalSkillTarget(home, client, name);
        const info = await lstatOrNull(target);
        if (!info?.isSymbolicLink()) continue;
        // Only links that are provably nexakit's: into this copy, the stable copy, an npx cache, or recorded broken.
        const link = await classifyLink({
          target, suffix: `skills/${name}`, activeRoots: [resolvedToolkit, actualRoot(home)],
          isOwned: (at, literal) => isRegistered(registry, at, literal)
        });
        if (['instalado', 'efimero', 'roto-propio'].includes(link.state)) {
          items.push({
            scope: 'global',
            client,
            name,
            target,
            relativePath: target,
            action: 'remove-global-link',
            reason: 'enlace global de Agent Toolkit'
          });
        }
      }
    }

    if (clients.includes('codex')) {
      for (const fileName of LEVEL_AGENT_NAMES) {
        const target = path.join(resolvedCodexHome, 'agents', fileName);
        const info = await lstatOrNull(target);
        if (!info?.isFile() || info.isSymbolicLink() || info.size > 65536) continue;
        const content = await fs.readFile(target, 'utf8').catch(() => '');
        if (content.startsWith(LEVEL_AGENT_HEADER)) {
          items.push({
            scope: 'global',
            client: 'codex',
            name: fileName,
            target,
            relativePath: target,
            action: 'remove-level-agent',
            reason: 'agente por nivel generado por Agent Toolkit'
          });
        }
      }
      manualCommands.push('codex mcp remove agent-toolkit-workflow');
    }
    if (clients.includes('claude')) {
      manualCommands.push('claude mcp remove --scope user agent-toolkit-workflow');
    }
  }

  return {
    reviewInstructions: includeGlobal && !skillNames
      ? await ownedReviewInstructions({
          homeDirectory: homeReal,
          codexHome: codexHome ?? environment.CODEX_HOME ?? path.join(homeReal, '.codex'),
          agents: clients
        })
      : [],
    homeDirectory: homeReal,
    reviewCodexHome: codexHome ?? environment.CODEX_HOME ?? path.join(homeReal, ".codex"),
    reviewAgents: clients,
    applied: false,
    projectRoot: root,
    toolkitRoot: resolvedToolkit,
    includeGlobal,
    agent,
    items,
    gitIgnoreUpdates,
    removeStateDir,
    removeLegacyLockfile,
    remainingManifestEntries,
    prevManifest: manifest,
    manualCommands,
    conflicts: items.filter(i => i.action === 'conflict').length
  };
}

async function removeVerifiedSkillCopy(targetDir, catalogEntry) {
  if (!catalogEntry) return false;
  const integrity = await verifyCatalogIntegrity(targetDir, catalogEntry);
  if (integrity !== 'verified') return false;

  const subdirs = new Set();
  for (const file of catalogEntry.files) {
    const fullFile = path.join(targetDir, file.path);
    const bytes = await fs.readFile(fullFile);
    const actualHash = createHash('sha256').update(bytes).digest('hex');
    if (actualHash !== file.sha256) return false;
    await fs.unlink(fullFile);
    let parent = path.dirname(fullFile);
    while (normalizedPath(parent) !== normalizedPath(targetDir) && isWithinRoot(parent, targetDir)) {
      subdirs.add(parent);
      parent = path.dirname(parent);
    }
  }
  const sortedDirs = [...subdirs].sort((a, b) => b.length - a.length);
  for (const dir of sortedDirs) {
    await fs.rmdir(dir).catch(() => {});
  }
  await fs.rmdir(targetDir).catch(() => {});
  return (await lstatOrNull(targetDir)) === null;
}

async function pruneEmptyDirIfSafe(dirPath) {
  const info = await lstatOrNull(dirPath);
  if (!info || !info.isDirectory() || info.isSymbolicLink()) return false;
  try {
    await fs.rmdir(dirPath);
    return true;
  } catch {
    return false;
  }
}

export async function applyToolkitDetach(plan) {
  if (!plan || !Array.isArray(plan.items)) {
    throw new Error('Se requiere una vista previa válida de desacoplado.');
  }

  if (plan.reviewInstructions?.length) {
    const lock = await acquireLock(nexakitDir(plan.homeDirectory));
    try {
      await removeReviewInstructions({
        homeDirectory: plan.homeDirectory,
        codexHome: plan.reviewCodexHome,
        agents: plan.reviewAgents
      }, lock);
    } finally {
      await lock.release();
    }
  }
  let removedCount = 0;
  let conflicts = 0;
  const updatedItems = [];

  for (const item of plan.items) {
    if (item.action === 'conflict') {
      conflicts++;
      updatedItems.push({ ...item });
      continue;
    }

    const info = await lstatOrNull(item.target);
    if (!info) {
      updatedItems.push({ ...item, action: 'already-absent' });
      continue;
    }

    if (item.action === 'remove-link' || item.action === 'remove-global-link') {
      if (!info.isSymbolicLink()) {
        conflicts++;
        updatedItems.push({ ...item, action: 'conflict' });
        continue;
      }
      await fs.unlink(item.target);
      removedCount++;
      updatedItems.push({ ...item, action: 'removed' });
      continue;
    }

    if (item.action === 'remove-copy') {
      if (!info.isDirectory() || info.isSymbolicLink()) {
        conflicts++;
        updatedItems.push({ ...item, action: 'conflict' });
        continue;
      }
      const ok = await removeVerifiedSkillCopy(item.target, item.catalogEntry);
      if (!ok) {
        conflicts++;
        updatedItems.push({ ...item, action: 'conflict' });
        continue;
      }
      removedCount++;
      updatedItems.push({ ...item, action: 'removed' });
      continue;
    }

    if (item.action === 'remove-level-agent') {
      if (!info.isFile() || info.isSymbolicLink()) {
        conflicts++;
        updatedItems.push({ ...item, action: 'conflict' });
        continue;
      }
      const text = await fs.readFile(item.target, 'utf8').catch(() => '');
      if (!text.startsWith(LEVEL_AGENT_HEADER)) {
        conflicts++;
        updatedItems.push({ ...item, action: 'conflict' });
        continue;
      }
      await fs.unlink(item.target);
      removedCount++;
      updatedItems.push({ ...item, action: 'removed' });
    }
  }

  let gitIgnoreCleanedCount = 0;
  if (plan.projectRoot) {
    for (const upd of plan.gitIgnoreUpdates ?? []) {
      const stat = await lstatOrNull(upd.targetPath);
      if (!stat?.isFile() || stat.isSymbolicLink()) continue;
      const prevText = await fs.readFile(upd.targetPath, 'utf8');
      if (upd.action === 'update-block' && plan.remainingManifestEntries?.length > 0) {
        const nextText = upsertManagedIgnoreBlock(
          prevText,
          plan.remainingManifestEntries.map(e => e.relativePath)
        );
        await fs.writeFile(upd.targetPath, nextText, { mode: 0o644 });
        gitIgnoreCleanedCount++;
      } else if (upd.action === 'remove-block' && conflicts === 0) {
        const cleaned = removeManagedIgnoreBlock(prevText);
        if (cleaned.changed) {
          if (!cleaned.content && upd.deleteIfEmpty) {
            await fs.unlink(upd.targetPath).catch(() => {});
          } else {
            await fs.writeFile(upd.targetPath, cleaned.content, { mode: 0o644 });
          }
          gitIgnoreCleanedCount++;
        }
      }
    }
  }

  let stateDirRemoved = false;
  if (plan.projectRoot && conflicts === 0) {
    const stateDir = path.join(plan.projectRoot, PROJECT_TOOLKIT_DIR);
    if (plan.remainingManifestEntries?.length > 0 && plan.prevManifest) {
      await fs.writeFile(
        path.join(stateDir, PROJECT_MANIFEST_FILE),
        JSON.stringify({ ...plan.prevManifest, entries: plan.remainingManifestEntries }, null, 2) + '\n',
        { mode: 0o644 }
      );
    } else if (plan.removeStateDir) {
      const lockFile = path.join(stateDir, PROJECT_LOCKFILE_NAME);
      const manifestFile = path.join(stateDir, PROJECT_MANIFEST_FILE);
      if ((await lstatOrNull(lockFile))?.isFile()) await fs.unlink(lockFile).catch(() => {});
      if ((await lstatOrNull(manifestFile))?.isFile()) await fs.unlink(manifestFile).catch(() => {});
      stateDirRemoved = await pruneEmptyDirIfSafe(stateDir);
    }

    if (plan.removeLegacyLockfile) {
      const legacyPath = path.join(plan.projectRoot, PROJECT_LOCKFILE_NAME);
      if (await isLegacyToolkitLockfile(legacyPath)) {
        await fs.unlink(legacyPath).catch(() => {});
      }
    }

    // Prune empty .agents/skills, .agents, .claude/skills, .claude
    await pruneEmptyDirIfSafe(path.join(plan.projectRoot, '.agents', 'skills'));
    await pruneEmptyDirIfSafe(path.join(plan.projectRoot, '.agents'));
    await pruneEmptyDirIfSafe(path.join(plan.projectRoot, '.claude', 'skills'));
    await pruneEmptyDirIfSafe(path.join(plan.projectRoot, '.claude'));
  }

  return {
    applied: true,
    projectRoot: plan.projectRoot,
    includeGlobal: plan.includeGlobal,
    items: updatedItems,
    removedCount,
    gitIgnoreCleanedCount,
    stateDirRemoved,
    conflicts,
    manualCommands: plan.manualCommands ?? []
  };
}

export function formatDetachReport(report) {
  const isPreview = !report.applied;
  const header = isPreview
    ? 'Agent Toolkit · Vista previa de desacoplado (sin cambios en disco)'
    : 'Agent Toolkit · Desacoplado completado';
  const lines = [header];
  if (report.projectRoot) lines.push(`Proyecto: ${report.projectRoot}`);
  if (report.includeGlobal) lines.push('Alcance global: incluido (~/.agents, ~/.claude, ~/.codex/agents)');
  lines.push('');

  if (isPreview) {
    const actionable = report.items.filter(i => i.action !== 'conflict');
    if (
      actionable.length === 0 &&
      !report.removeStateDir &&
      !report.removeLegacyLockfile &&
      (report.gitIgnoreUpdates?.length ?? 0) === 0
    ) {
      lines.push('No se encontraron artefactos acoplados por Agent Toolkit para retirar.');
    } else {
      lines.push('Elementos que se retirarán:');
      for (const item of actionable) {
        lines.push(`  - [${item.scope} ${item.client}] ${item.relativePath} (${item.reason})`);
      }
      if (report.removeStateDir) {
        lines.push(`  - [estado] ${PROJECT_TOOLKIT_DIR}/ (manifiesto y lockfile locales)`);
      }
      if (report.removeLegacyLockfile) {
        lines.push('  - [legacy] skills-lock.json en raíz');
      }
      for (const upd of report.gitIgnoreUpdates ?? []) {
        lines.push(`  - [git] Limpiar bloque gestionado en ${upd.relativePath}`);
      }
    }
    const conflictItems = report.items.filter(i => i.action === 'conflict');
    if (conflictItems.length > 0) {
      lines.push('', 'Conflictos respetados (no se tocarán):');
      for (const c of conflictItems) {
        lines.push(`  ! ${c.relativePath} — ${c.reason}`);
      }
    }
    lines.push('', 'Ejecuta con --apply para confirmar el desacoplado.');
  } else {
    lines.push(`Elementos retirados: ${report.removedCount}`);
    if (report.projectRoot) {
      lines.push(`Carpeta ${PROJECT_TOOLKIT_DIR}/ retirada: ${report.stateDirRemoved ? 'sí' : 'sin cambios'}`);
      lines.push(`Archivos ignore limpiados: ${report.gitIgnoreCleanedCount}`);
    }
    if (report.conflicts > 0) {
      lines.push(`Conflictos respetados intactos: ${report.conflicts}`);
    }
  }

  if ((report.manualCommands?.length ?? 0) > 0) {
    lines.push('', 'Para retirar también el servidor MCP de tus clientes (opcional):');
    for (const cmd of report.manualCommands) lines.push(`  $ ${cmd}`);
  }

  if (report.reviewInstructions?.length) lines.push(`  - Quitar solo el bloque de revisión de ${report.reviewInstructions.join(', ')}`);
  return lines.join('\n') + '\n';
}

// Generic signals: almost every project has them, and the useful skill is the framework's.
const GENERIC_SIGNALS = new Set(['nodejs', 'typescript']);

// The technologies found in the project that no catalog skill (nor external reference) covers. Only reported:
// finding a skill for one is a request the person makes to revisar-skill, never a search nexakit starts alone.
export function uncoveredSignals({ signals = [], catalog }) {
  const covered = new Set([
    ...(catalog?.skills ?? []).flatMap((skill) => skill.matching?.anySignals ?? []),
    ...(catalog?.externalReferences ?? []).flatMap((ref) => ref.anySignals ?? []),
  ]);
  return signals
    .filter((signal) => !GENERIC_SIGNALS.has(signal.id) && !covered.has(signal.id))
    .map((signal) => ({ id: signal.id, label: signal.label }));
}
