import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const modUrl = new URL('../src/antigravity-agents.js', import.meta.url);

test('renderAntigravityAgents maps all 10 niveles agents with valid Antigravity models and tools', async () => {
  const { renderAntigravityAgents, ANTIGRAVITY_AGENT_NAMES } = await import(modUrl);
  const agents = await renderAntigravityAgents();
  assert.equal(agents.length, 10);
  assert.deepEqual(
    agents.map((a) => a.name),
    ANTIGRAVITY_AGENT_NAMES,
  );

  const byName = new Map(agents.map((a) => [a.name, a.content]));
  assert.match(byName.get('nivel-ligero'), /^model: flash_lite$/mu);
  assert.match(byName.get('nivel-ligero'), /^effort: low$/mu);
  assert.match(byName.get('nivel-normal'), /^model: flash$/mu);
  assert.match(byName.get('nivel-normal'), /^effort: medium$/mu);
  assert.match(byName.get('nivel-exigente'), /^model: pro$/mu);
  assert.match(byName.get('nivel-exigente'), /^effort: high$/mu);
  assert.match(byName.get('nivel-alto'), /^model: pro$/mu);
  assert.match(byName.get('nivel-alto'), /^effort: max$/mu);

  for (const agent of agents) {
    assert.doesNotMatch(agent.content, /^model: (?:haiku|sonnet|opus)$/mu, agent.name);
    assert.doesNotMatch(agent.content, /herramienta Skill/u, agent.name);
  }
  assert.match(byName.get('investigador'), /read_file/u);
  assert.match(byName.get('investigador'), /search_web/u);
  assert.match(byName.get('cierre-de-memoria'), /call_mcp_tool/u);
});

test('planAntigravityAgents and writeAntigravityAgents preview, apply, update with backup, and block symlinks', async (t) => {
  const { planAntigravityAgents, writeAntigravityAgents } = await import(modUrl);
  const homeDirectory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agy-agents-')));
  t.after(() => fs.rm(homeDirectory, { recursive: true, force: true }));

  const preview = await planAntigravityAgents({ homeDirectory });
  assert.equal(preview.targetDirectory, path.join(homeDirectory, '.gemini', 'config', 'agents'));
  assert.equal(preview.files.every((f) => f.state === 'falta'), true);
  await assert.rejects(fs.stat(path.join(homeDirectory, '.gemini')), { code: 'ENOENT' });

  const applied = await writeAntigravityAgents(preview, { apply: true });
  assert.equal(applied.files.every((f) => f.state === 'igual'), true);

  const customFile = path.join(preview.targetDirectory, 'nivel-ligero.md');
  await fs.writeFile(customFile, '# personalizado\n', 'utf8');

  const withoutUpdate = await writeAntigravityAgents(await planAntigravityAgents({ homeDirectory }), { apply: true, update: false });
  assert.equal(withoutUpdate.files.find((f) => f.name === 'nivel-ligero').state, 'distinto');
  assert.equal(await fs.readFile(customFile, 'utf8'), '# personalizado\n');

  const withUpdate = await writeAntigravityAgents(await planAntigravityAgents({ homeDirectory }), { apply: true, update: true });
  const updated = withUpdate.files.find((f) => f.name === 'nivel-ligero');
  assert.equal(updated.state, 'igual');
  assert.ok(updated.backupPath);
  assert.equal(await fs.readFile(updated.backupPath, 'utf8'), '# personalizado\n');

  // Symlinked target file must be reported as blocked and never overwritten.
  const outside = path.join(homeDirectory, 'outside.md');
  await fs.writeFile(outside, 'secret\n', 'utf8');
  await fs.rm(customFile);
  try {
    await fs.symlink(outside, customFile);
    const blockedPlan = await planAntigravityAgents({ homeDirectory });
    assert.equal(blockedPlan.files.find((f) => f.name === 'nivel-ligero').state, 'bloqueado');
    const afterBlocked = await writeAntigravityAgents(blockedPlan, { apply: true, update: true });
    assert.equal(afterBlocked.files.find((f) => f.name === 'nivel-ligero').state, 'bloqueado');
    assert.equal(await fs.readFile(outside, 'utf8'), 'secret\n');
  } catch (error) {
    if (!(process.platform === 'win32' && error.code === 'EPERM')) throw error;
  }
});

test('rendered Antigravity agents pass agy plugin validate --strict when installed binary is available', async (t) => {
  const which = spawnSync('which', ['agy'], { encoding: 'utf8' });
  if (which.status !== 0) return;

  const { renderAntigravityAgents } = await import(modUrl);
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agy-validate-agents-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  await fs.mkdir(path.join(root, 'agents'), { recursive: true });
  await fs.writeFile(path.join(root, 'plugin.json'), JSON.stringify({ name: 'test-niveles', version: '0.1.0' }));
  for (const agent of await renderAntigravityAgents()) {
    await fs.writeFile(path.join(root, 'agents', agent.filename), agent.content);
  }
  const validate = spawnSync('agy', ['plugin', 'validate', '--strict', root], { encoding: 'utf8' });
  assert.equal(validate.status, 0, validate.stdout + validate.stderr);
  assert.match(validate.stdout, /agents 10\b/u);
});
