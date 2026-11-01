import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { initializeMemory } from '../src/init.js';
import { gatherSetupState, inspectMemoryPath } from '../src/setup-state.js';

const TOOLKIT_ROOT = fileURLToPath(new URL('../', import.meta.url));

function snapshot(root) {
  const result = {};
  (function walk(dir) {
    for (const entry of fsSync.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isSymbolicLink()) result[path.relative(root, full)] = fsSync.readlinkSync(full);
      else result[path.relative(root, full)] = createHash('sha256').update(fsSync.readFileSync(full)).digest('hex');
    }
  })(root);
  return result;
}

async function world(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'setup-state-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const home = path.join(base, 'home'), repo = path.join(base, 'Punto_Motos'), bin = path.join(base, 'bin');
  await fs.mkdir(home);
  await fs.mkdir(bin);
  await fs.mkdir(path.join(repo, 'frontend'), { recursive: true });
  await fs.writeFile(path.join(repo, 'frontend', 'README.md'), 'Interfaz en React.\n');
  execFileSync('git', ['init', '-q', repo]);
  return { base, home, repo, bin, environment: { PATH: bin, HOME: home } };
}
const notFound = () => ({ status: 1, stdout: '', stderr: 'not found' });

test('gathers the project, its suggested skills, the agents and the memory without writing anything', async t => {
  const w = await world(t);
  const before = { home: snapshot(w.home), repo: snapshot(w.repo) };
  const state = await gatherSetupState({ start: path.join(w.repo, 'frontend'), homeDirectory: w.home, environment: w.environment, toolkitRoot: TOOLKIT_ROOT, runCommand: notFound });
  assert.equal(state.project.root, w.repo);
  assert.equal(state.project.fromSubfolder, true);
  assert.equal(state.project.displayName, 'Punto Motos');
  assert.deepEqual(state.agentsFound, { claude: false, codex: false, antigravity: false });
  const frontend = state.skills.find(skill => skill.name === 'frontend-design');
  assert.equal(frontend.suggested, true);
  assert.equal(frontend.reason, 'frontend/README menciona React');
  assert.deepEqual(frontend.links, { claude: 'missing', codex: 'missing' });
  assert.equal(state.skills.find(skill => skill.name === 'differential-review').suggested, false);
  assert.ok(state.globalSkills.claude.pending > 0);
  assert.equal(state.stableCommand.state, 'falta');
  assert.equal(state.memory.existing, null);
  assert.equal(state.memory.suggestedPath, path.join(w.home, 'nexakit-memorias', 'punto-motos'));
  assert.equal(state.memory.kinds[state.memory.suggestedPath], 'new');
  assert.equal(state.savedAnswers, null);
  assert.deepEqual({ home: snapshot(w.home), repo: snapshot(w.repo) }, before);
});

test('an existing memory for the repository is found with how it is connected to each agent', async t => {
  const w = await world(t);
  const vault = path.join(w.home, 'vaults', 'PUNTO-MOTOS-MEMORY');
  initializeMemory({ destination: vault, projectId: 'punto-motos', projectName: 'Punto Motos', sourcePath: w.repo, syncMode: 'none', apply: true });
  await fs.writeFile(path.join(w.home, '.claude.json'), JSON.stringify({ mcpServers: { 'punto-motos-memory': {
    type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem@2026.8.31', vault] } } }));
  const state = await gatherSetupState({ start: w.repo, homeDirectory: w.home, environment: w.environment, toolkitRoot: TOOLKIT_ROOT, runCommand: notFound });
  assert.equal(state.memory.existing.vaultPath, vault);
  assert.equal(state.memory.kinds[vault], 'memory');
  // The memory declares Codex and Claude, but neither CLI is installed here; Antigravity is not declared nor found.
  assert.deepEqual(state.memory.connections[vault], { claude: 'create', codex: 'create', antigravity: 'unavailable' });
});

test('a memory path is new, an existing memory, or something else that is not touched', async t => {
  const w = await world(t);
  assert.equal(await inspectMemoryPath(path.join(w.base, 'nada')), 'new');
  await fs.mkdir(path.join(w.base, 'vacia'));
  assert.equal(await inspectMemoryPath(path.join(w.base, 'vacia')), 'new');
  await fs.writeFile(path.join(w.base, 'vacia', 'nota.md'), 'x');
  assert.equal(await inspectMemoryPath(path.join(w.base, 'vacia')), 'invalid');
  await fs.writeFile(path.join(w.base, 'archivo'), 'x');
  assert.equal(await inspectMemoryPath(path.join(w.base, 'archivo')), 'invalid');
});
