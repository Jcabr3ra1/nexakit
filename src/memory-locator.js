// Finds the project memories this person already has, from the memory MCP servers registered in Claude Code, Codex
// and Antigravity, so a repository reuses its memory and a new one goes next to the others. Read-only. No new
// registry: the clients' own configuration is the source of truth.
import fs from 'node:fs/promises';
import path from 'node:path';
import { getStaticTOMLValue, parseTOML } from 'toml-eslint-parser';

const MAX_CONFIG_BYTES = 2 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 512 * 1024;
const CLIENT_ORDER = ['claude', 'codex', 'antigravity'];
const FILESYSTEM_PACKAGE = /^@modelcontextprotocol\/server-filesystem(?:@[^/]+)?$/u;
const MEMORY_SCRIPT = 'project-memory-mcp.js';

async function readBounded(file, maxBytes) {
  try {
    const info = await fs.lstat(file);
    if (!info.isFile() || info.size > maxBytes) return null;
    return await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

async function serversOf(client, { homeDirectory, codexHome }) {
  try {
    if (client === 'claude') {
      const config = JSON.parse(await readBounded(path.join(homeDirectory, '.claude.json'), MAX_CONFIG_BYTES) ?? 'null');
      const projects = Object.values(config?.projects ?? {}).map(project => project?.mcpServers ?? {});
      return [config?.mcpServers ?? {}, ...projects].flatMap(Object.entries);
    }
    if (client === 'codex') {
      const text = await readBounded(path.join(codexHome, 'config.toml'), MAX_CONFIG_BYTES);
      return text ? Object.entries(getStaticTOMLValue(parseTOML(text, { tomlVersion: '1.0.0' }))?.mcp_servers ?? {}) : [];
    }
    const config = JSON.parse(await readBounded(path.join(homeDirectory, '.gemini', 'config', 'mcp_config.json'), MAX_CONFIG_BYTES) ?? 'null');
    return Object.entries(config?.mcpServers ?? {});
  } catch {
    return []; // An unreadable configuration means no known memories from that client, never an error.
  }
}

// The manifest a server points at: the last argument of server-filesystem, or the --manifest of project-memory-mcp.
function manifestCandidate(server) {
  const args = Array.isArray(server?.args) ? server.args.filter(arg => typeof arg === 'string') : [];
  const script = args.findIndex(arg => arg.replaceAll('\\', '/').endsWith(`/${MEMORY_SCRIPT}`));
  if (script >= 0 && args[script + 1] === '--manifest' && path.isAbsolute(args[script + 2] ?? '')) return args[script + 2];
  if (args.some(arg => FILESYSTEM_PACKAGE.test(arg))) {
    const last = args.at(-1);
    if (last && path.isAbsolute(last)) return path.join(last, 'project-memory.json');
  }
  return null;
}

async function readManifest(manifestPath) {
  const text = await readBounded(manifestPath, MAX_MANIFEST_BYTES); // lstat: a linked manifest is not accepted.
  if (text === null) return null;
  try {
    const manifest = JSON.parse(text);
    const id = manifest?.project?.id;
    const repositoryPath = manifest?.source?.repositoryPath;
    if (typeof id !== 'string' || typeof repositoryPath !== 'string') return null;
    return manifest;
  } catch {
    return null;
  }
}

// Every MCP server name registered in each agent, with the vault it serves when it is a memory (else null).
export async function registeredServers({ homeDirectory, codexHome = path.join(homeDirectory, '.codex') } = {}) {
  const result = {};
  for (const client of CLIENT_ORDER) {
    result[client] = {};
    for (const [name, server] of await serversOf(client, { homeDirectory, codexHome })) {
      const candidate = manifestCandidate(server);
      result[client][name] = candidate ? await fs.realpath(path.dirname(candidate)).catch(() => null) : null;
    }
  }
  return result;
}

export async function findKnownMemories({ homeDirectory, codexHome = path.join(homeDirectory, '.codex') } = {}) {
  const byVault = new Map();
  for (const client of CLIENT_ORDER) {
    for (const [name, server] of await serversOf(client, { homeDirectory, codexHome })) {
      const candidate = manifestCandidate(server);
      if (!candidate) continue;
      const manifest = await readManifest(candidate);
      if (!manifest) continue;
      const vaultPath = await fs.realpath(path.dirname(candidate)).catch(() => null);
      if (!vaultPath) continue;
      const entry = byVault.get(vaultPath) ?? {
        vaultPath,
        manifestPath: path.join(vaultPath, 'project-memory.json'),
        projectId: manifest.project.id,
        repositoryPath: manifest.source.repositoryPath,
        mcpName: typeof manifest.memory?.mcpServerName === 'string' ? manifest.memory.mcpServerName : name,
        clients: []
      };
      if (!entry.clients.includes(client)) entry.clients.push(client);
      byVault.set(vaultPath, entry);
    }
  }
  return [...byVault.values()].sort((a, b) => (a.vaultPath < b.vaultPath ? -1 : a.vaultPath > b.vaultPath ? 1 : 0));
}

export function memoryForRepository(known, root) {
  return known.find(entry => path.resolve(entry.repositoryPath) === path.resolve(root)) ?? null;
}

// Next to the memories already known when they share one parent folder; otherwise a folder of its own.
export function suggestMemoryLocation(known, { id, homeDirectory }) {
  const parents = [...new Set(known.map(entry => path.dirname(entry.vaultPath)))];
  return parents.length === 1
    ? path.join(parents[0], `${id.toUpperCase()}-MEMORY`)
    : path.join(homeDirectory, 'nexakit-memorias', id);
}
