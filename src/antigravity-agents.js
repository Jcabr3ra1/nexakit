import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_AGENTS_DIR = fileURLToPath(new URL('../plugins/niveles/agents', import.meta.url));
const MAX_BYTES = 128 * 1024;

export const ANTIGRAVITY_AGENT_NAMES = Object.freeze([
  'nivel-ligero',
  'nivel-normal',
  'nivel-exigente',
  'nivel-alto',
  'investigador',
  'revisor-de-calidad',
  'cierre-de-memoria',
  'subir-al-repo',
  'sincronizador-docs',
  'cazador-de-flakes',
]);

const MODEL_MAP = Object.freeze({
  'nivel-ligero': { model: 'flash_lite', effort: 'low' },
  'nivel-normal': { model: 'flash', effort: 'medium' },
  'nivel-exigente': { model: 'pro', effort: 'high' },
  'nivel-alto': { model: 'pro', effort: 'max' },
  'revisor-de-calidad': { model: 'pro', effort: 'high' },
});

const TOOL_MAP = Object.freeze({
  Bash: 'run_command',
  Read: 'read_file',
  Grep: 'run_command',
  Glob: 'run_command',
  Edit: 'edit_file',
  MultiEdit: 'edit_file',
  Write: 'write_file',
  WebSearch: 'search_web',
  WebFetch: 'search_web',
});

const EXTRA_TOOLS = Object.freeze({
  'cierre-de-memoria': ['call_mcp_tool', 'list_resources', 'read_resource'],
});

function parseSimpleFrontmatter(raw) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/u.exec(raw);
  if (!match) throw new Error('Frontmatter de agente inválido.');
  const fields = {};
  for (const line of match[1].split(/\r?\n/u)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    fields[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return { fields, body: match[2] };
}

function mapTools(rawTools, agentName) {
  if (!rawTools) return [];
  const mapped = [];
  const seen = new Set();
  const push = (tool) => {
    if (tool && !seen.has(tool)) {
      seen.add(tool);
      mapped.push(tool);
    }
  };
  for (const token of rawTools.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (token === 'Skill') continue;
    push(TOOL_MAP[token]);
  }
  for (const extra of EXTRA_TOOLS[agentName] ?? []) push(extra);
  return mapped;
}

function adaptText(text) {
  return String(text ?? '')
    .replaceAll('(haiku, low)', '(flash_lite, low)')
    .replaceAll('(sonnet, medium)', '(flash, medium)')
    .replaceAll('(sonnet, high)', '(pro, high)')
    .replaceAll('(opus, high)', '(pro, max)')
    .replaceAll('(herramienta Skill)', '(con read_file)')
    .replaceAll('CLAUDE.md, AGENTS.md', 'GEMINI.md, CLAUDE.md, AGENTS.md');
}

function renderAgentMarkdown(name, sourceRaw) {
  const { fields, body } = parseSimpleFrontmatter(sourceRaw);
  const spec = MODEL_MAP[name] ?? { model: 'flash', effort: fields.effort || 'medium' };
  const tools = mapTools(fields.tools, name);
  const lines = [
    '---',
    `name: ${name}`,
    `description: ${adaptText(fields.description || '')}`,
    `model: ${spec.model}`,
    `effort: ${spec.effort}`,
  ];
  if (fields.maxTurns) lines.push(`maxSteps: ${fields.maxTurns}`);
  if (tools.length) {
    lines.push('tools:');
    for (const tool of tools) lines.push(`  - ${tool}`);
  }
  lines.push('---', '');
  return `${lines.join('\n')}${adaptText(body).trimStart()}`;
}

/** Render all 10 NexaKit `niveles` agents adapted for Antigravity (`agy`). */
export async function renderAntigravityAgents({ sourceDirectory = SOURCE_AGENTS_DIR } = {}) {
  const agents = [];
  for (const name of ANTIGRAVITY_AGENT_NAMES) {
    const filename = `${name}.md`;
    const raw = await fs.readFile(path.join(sourceDirectory, filename), 'utf8');
    agents.push({ name, filename, content: renderAgentMarkdown(name, raw) });
  }
  return agents;
}

const digest = (text) => createHash('sha256').update(text).digest('hex');

async function statOrNull(target) {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function inspectTargetFile(target, expectedContent) {
  const stat = await statOrNull(target);
  if (!stat) return { state: 'falta', size: null };
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_BYTES) {
    return { state: 'bloqueado', size: stat.size ?? null };
  }
  let handle;
  try {
    handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const current = await handle.readFile('utf8');
    return {
      state: digest(current) === digest(expectedContent) ? 'igual' : 'distinto',
      size: stat.size,
    };
  } catch {
    return { state: 'bloqueado', size: null };
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function isDarwinSystemLink(current) {
  if (process.platform !== 'darwin' || (current !== '/tmp' && current !== '/var')) return false;
  return (await fs.realpath(current).catch(() => null)) === `/private${current}`;
}

async function hasSymlinkAncestor(target) {
  let current = path.resolve(target);
  while (true) {
    const stat = await statOrNull(current);
    if (stat && !(await isDarwinSystemLink(current)) && (stat.isSymbolicLink() || !stat.isDirectory())) return true;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return false;
}

/** Inspect target Antigravity agents directory and build an install/update plan. */
export async function planAntigravityAgents({
  homeDirectory = os.homedir(),
  projectRoot = process.cwd(),
  outputDirectory,
  project = false,
  sourceDirectory = SOURCE_AGENTS_DIR,
} = {}) {
  const targetDirectory = outputDirectory
    ? path.resolve(outputDirectory)
    : project
      ? path.join(path.resolve(projectRoot), '.agents', 'agents')
      : path.join(path.resolve(homeDirectory), '.gemini', 'config', 'agents');

  const dirBlocked = await hasSymlinkAncestor(targetDirectory);
  const rendered = await renderAntigravityAgents({ sourceDirectory });
  const files = [];
  for (const agent of rendered) {
    const targetPath = path.join(targetDirectory, agent.filename);
    const inspected = dirBlocked
      ? { state: 'bloqueado', size: null }
      : await inspectTargetFile(targetPath, agent.content);
    files.push({
      name: agent.name,
      filename: agent.filename,
      path: targetPath,
      model: (MODEL_MAP[agent.name] ?? { model: 'flash' }).model,
      effort: (MODEL_MAP[agent.name] ?? { effort: 'medium' }).effort,
      state: inspected.state,
      content: agent.content,
    });
  }
  return {
    targetDirectory,
    files,
    limitations: [
      'Los presupuestos de pasos y límites de palabras en las instrucciones son guías para el subagente.',
      'No modifica configuraciones de plugins ni hooks; instala los hooks por separado con `nexakit antigravity preparar`.',
    ],
  };
}

/** Apply an Antigravity agents plan safely with atomic writes and optional `.bak` backup on update. */
export async function writeAntigravityAgents(plan, { apply = false, update = false } = {}) {
  if (!apply) return plan;
  if (await hasSymlinkAncestor(plan.targetDirectory)) {
    return {
      ...plan,
      files: plan.files.map((f) => ({ ...f, state: 'bloqueado' })),
    };
  }
  await fs.mkdir(plan.targetDirectory, { recursive: true, mode: 0o700 });
  const nextFiles = [];
  for (const file of plan.files) {
    if (file.state === 'bloqueado' || file.state === 'igual' || (file.state === 'distinto' && !update)) {
      nextFiles.push({ ...file });
      continue;
    }
    let backupPath;
    if (file.state === 'distinto' && update) {
      backupPath = `${file.path}.${Date.now()}.bak`;
      await fs.copyFile(file.path, backupPath, constants.COPYFILE_EXCL);
      await fs.chmod(backupPath, 0o600);
    }
    const temp = path.join(plan.targetDirectory, `.tmp-${file.name}-${randomUUID()}.md`);
    try {
      await fs.writeFile(temp, file.content, { flag: 'wx', mode: 0o600 });
      await fs.rename(temp, file.path);
      nextFiles.push({ ...file, state: 'igual', ...(backupPath ? { backupPath } : {}) });
    } finally {
      await fs.rm(temp, { force: true }).catch(() => {});
    }
  }
  return { ...plan, files: nextFiles };
}
