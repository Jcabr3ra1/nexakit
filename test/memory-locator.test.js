import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { findKnownMemories, memoryForRepository, suggestMemoryLocation } from '../src/memory-locator.js';

async function home(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'memory-locator-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
async function vault(dir, { id, repositoryPath, mcpName = `${id}-memory` }) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'project-memory.json'), JSON.stringify({
    schemaVersion: '1.0.0',
    project: { id, name: id },
    source: { repositoryPath },
    memory: { vaultPath: dir, mcpServerName: mcpName }
  }));
  return dir;
}
const filesystem = dir => ({ type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem@2026.8.31', dir] });
async function write(file, content) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}

test('finds memories registered in Claude, Codex and Antigravity', async t => {
  const h = await home(t);
  const a = await vault(path.join(h, 'vaults', 'A-MEMORY'), { id: 'a', repositoryPath: path.join(h, 'code', 'a') });
  const b = await vault(path.join(h, 'vaults', 'B-MEMORY'), { id: 'b', repositoryPath: path.join(h, 'code', 'b') });
  const c = await vault(path.join(h, 'vaults', 'C-MEMORY'), { id: 'c', repositoryPath: path.join(h, 'code', 'c') });
  await write(path.join(h, '.claude.json'), JSON.stringify({ mcpServers: { 'a-memory': filesystem(a), railway: { command: 'railway', args: ['mcp'] } } }));
  await write(path.join(h, '.codex', 'config.toml'), [
    '[mcp_servers.a-memory]', 'command = "npx"', `args = ["-y", "@modelcontextprotocol/server-filesystem", "${a}"]`, '',
    '[mcp_servers.b-memory]', 'command = "/usr/local/bin/node"',
    `args = ["/x/nexakit/bin/project-memory-mcp.js", "--manifest", "${path.join(b, 'project-memory.json')}"]`, ''
  ].join('\n'));
  await write(path.join(h, '.gemini', 'config', 'mcp_config.json'), JSON.stringify({ mcpServers: { 'c-memory': { command: 'npx', args: filesystem(c).args } } }));

  const known = await findKnownMemories({ homeDirectory: h });
  assert.deepEqual(known.map(m => [m.projectId, m.clients]), [['a', ['claude', 'codex']], ['b', ['codex']], ['c', ['antigravity']]]);
  assert.equal(known[0].vaultPath, a);
  assert.equal(known[0].manifestPath, path.join(a, 'project-memory.json'));
  assert.equal(known[0].repositoryPath, path.join(h, 'code', 'a'));
  assert.equal(known[1].mcpName, 'b-memory');
});

test('ignores servers that are not memories, broken manifests and links', async t => {
  const h = await home(t);
  const noManifest = path.join(h, 'vaults', 'EMPTY');
  await fs.mkdir(noManifest, { recursive: true });
  const broken = path.join(h, 'vaults', 'BROKEN');
  await write(path.join(broken, 'project-memory.json'), '{ not json');
  const real = await vault(path.join(h, 'vaults', 'REAL'), { id: 'real', repositoryPath: '/r' });
  const linked = path.join(h, 'vaults', 'LINKED');
  await fs.mkdir(linked);
  await fs.symlink(path.join(real, 'project-memory.json'), path.join(linked, 'project-memory.json'));
  await write(path.join(h, '.claude.json'), JSON.stringify({ mcpServers: {
    one: filesystem(noManifest), two: filesystem(broken), three: filesystem(linked), four: { command: 'npx', args: ['-y', 'other-server', real] }
  } }));
  await write(path.join(h, '.codex', 'config.toml'), 'this is = = not toml');
  assert.deepEqual(await findKnownMemories({ homeDirectory: h }), []);
});

test('the repository already has a memory when its source path matches', async t => {
  const h = await home(t);
  const repo = path.join(h, 'code', 'Punto_Motos');
  await fs.mkdir(repo, { recursive: true });
  const v = await vault(path.join(h, 'vaults', 'PM'), { id: 'punto-motos', repositoryPath: repo });
  await write(path.join(h, '.claude.json'), JSON.stringify({ mcpServers: { 'punto-motos-memory': filesystem(v) } }));
  const known = await findKnownMemories({ homeDirectory: h });
  assert.equal(memoryForRepository(known, repo)?.vaultPath, v);
  assert.equal(memoryForRepository(known, path.join(h, 'code')), null);
});

test('suggests the common parent of known memories, or ~/nexakit-memorias', () => {
  const h = '/home/u';
  const at = vaultPath => ({ vaultPath });
  assert.equal(suggestMemoryLocation([at('/home/u/vaults/A-MEMORY'), at('/home/u/vaults/B-MEMORY')], { id: 'punto-motos', homeDirectory: h }),
    path.join('/home/u/vaults', 'PUNTO-MOTOS-MEMORY'));
  assert.equal(suggestMemoryLocation([], { id: 'punto-motos', homeDirectory: h }), path.join(h, 'nexakit-memorias', 'punto-motos'));
  assert.equal(suggestMemoryLocation([at('/home/u/x/A'), at('/home/u/y/B')], { id: 'punto-motos', homeDirectory: h }),
    path.join(h, 'nexakit-memorias', 'punto-motos'));
});
