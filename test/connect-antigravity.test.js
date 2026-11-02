import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { connectMemory } from '../src/connect.js';
import { diagnoseMemory } from '../src/doctor.js';
import { initializeMemory } from '../src/init.js';

function fixture(context, agents = ['codex', 'claude', 'antigravity']) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'connect-antigravity-')));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'), memory = path.join(root, 'memory'), home = path.join(root, 'home');
  const toolkitRoot = path.join(root, 'toolkit');
  fs.mkdirSync(source, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(toolkitRoot, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(toolkitRoot, 'bin', 'project-memory-mcp.js'), '');
  execFileSync('git', ['-C', source, 'init', '-q']);
  const report = initializeMemory({ destination: memory, projectId: 'demo', projectName: 'Demo', sourcePath: source, syncMode: 'none', ...(agents && { agents }), apply: true },
    { now: new Date('2026-11-01T12:00:00Z') });
  return { root, source, memory, home, toolkitRoot, report, manifestPath: path.join(memory, 'project-memory.json') };
}
const configFile = home => path.join(home, '.gemini', 'config', 'mcp_config.json');
const context = (f, runCommand) => ({ homeDirectory: f.home, nodePath: '/usr/bin/node', toolkitRoot: f.toolkitRoot, runCommand });

test('init creates the antigravity agent when asked, and keeps codex and claude by default', async t => {
  const f = fixture(t);
  const manifest = JSON.parse(fs.readFileSync(f.manifestPath, 'utf8'));
  assert.deepEqual(manifest.agents.map(agent => agent.id), ['codex', 'claude', 'antigravity']);
  const plain = fixture(t, null);
  assert.deepEqual(JSON.parse(fs.readFileSync(plain.manifestPath, 'utf8')).agents.map(agent => agent.id), ['codex', 'claude']);
});

test('a memory created by init with syncMode none passes the strict doctor without Git', async t => {
  const f = fixture(t);
  const report = await diagnoseMemory(f.memory);
  assert.equal(report.summary.errors, 0, JSON.stringify(report.checks.filter(c => c.level === 'error')));
  assert.equal(report.summary.warnings, 0, JSON.stringify(report.checks.filter(c => c.level === 'warning')));
});

test('connect antigravity registers the read-only memory server with agy and links the skill', async t => {
  const f = fixture(t);
  const calls = [];
  const runner = (command, args) => {
    calls.push([command, ...args]);
    if (args[1] === 'list') return { status: 0, stdout: 'No MCP servers configured.\n', stderr: '' };
    const dash = args.indexOf('--');
    fs.mkdirSync(path.dirname(configFile(f.home)), { recursive: true });
    fs.writeFileSync(configFile(f.home), JSON.stringify({ mcpServers: { 'demo-memory': { command: args[dash + 1], args: args.slice(dash + 2) } } }));
    return { status: 0, stdout: '', stderr: '' };
  };
  const preview = await connectMemory({ targetPath: f.memory, agentId: 'antigravity' }, context(f, runner));
  assert.equal(preview.status, 'preview');
  assert.deepEqual(calls, [['agy', 'mcp', 'list']], 'the preview only checks that agy answers');

  const report = await connectMemory({ targetPath: f.memory, agentId: 'antigravity', apply: true }, context(f, runner));
  assert.equal(report.status, 'connected');
  assert.deepEqual(calls.filter(call => call[2] === 'add'), [['agy', 'mcp', 'add', 'demo-memory', '--', '/usr/bin/node',
    path.join(f.toolkitRoot, 'bin', 'project-memory-mcp.js'), '--manifest', f.manifestPath]]);
  const skill = path.join(f.home, '.gemini', 'antigravity-cli', 'skills', 'demo');
  assert.equal(fs.realpathSync(skill), path.join(f.memory, '07-AGENTES', 'skills', 'demo'));
  assert.equal(report.components.some(component => component.id === 'policy'), false, 'the server itself is read-only');
});

test('connect antigravity is unchanged when mcp_config.json already has it, and a conflict when the name points elsewhere', async t => {
  const f = fixture(t);
  const script = path.join(f.toolkitRoot, 'bin', 'project-memory-mcp.js');
  fs.mkdirSync(path.join(f.home, '.gemini', 'antigravity-cli', 'skills'), { recursive: true });
  fs.symlinkSync(path.join(f.memory, '07-AGENTES', 'skills', 'demo'), path.join(f.home, '.gemini', 'antigravity-cli', 'skills', 'demo'));
  const write = server => {
    fs.mkdirSync(path.dirname(configFile(f.home)), { recursive: true });
    fs.writeFileSync(configFile(f.home), JSON.stringify({ mcpServers: { 'demo-memory': server } }));
  };
  const never = (command, args) => {
    if (args[1] === 'list') return { status: 0, stdout: '', stderr: '' };
    throw new Error('nothing to write');
  };

  write({ command: '/usr/bin/node', args: [script, '--manifest', f.manifestPath] });
  const same = await connectMemory({ targetPath: f.memory, agentId: 'antigravity', apply: true }, context(f, never));
  assert.equal(same.status, 'unchanged');

  write({ command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/otra/boveda'] });
  const other = await connectMemory({ targetPath: f.memory, agentId: 'antigravity', apply: true }, context(f, never));
  assert.equal(other.status, 'conflict');
  assert.match(other.components.find(c => c.id === 'mcp').message, /Antigravity/u);
});

test('without agy the antigravity connection is reported as unavailable', async t => {
  const f = fixture(t);
  const missing = () => ({ status: null, stdout: '', stderr: '', errorCode: 'ENOENT' });
  const report = await connectMemory({ targetPath: f.memory, agentId: 'antigravity', apply: true }, context(f, missing));
  assert.equal(report.status, 'conflict');
  assert.match(report.components.find(c => c.id === 'mcp').message, /agy/u);
});
