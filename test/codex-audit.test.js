import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SECRET = 'FAKE_SECRET_TOKEN_DO_NOT_DISCLOSE_123';
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'codex-audit-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const options = { projectRoot: join(root, 'project'), homeDirectory: join(root, 'home'), codexHome: join(root, 'codex') };
  const put = (path, content) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, content); };
  const skill = (base, dir, name, description, body = SECRET) => put(join(base, dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n${body}`);
  const { auditCodex } = await import('../src/codex-audit.js');
  return { root, options, put, skill, auditCodex };
}

test('missing inputs produce serializable diagnostics and fixed proposals', async t => {
  const { options, auditCodex } = await fixture(t);
  const report = await auditCodex(options);
  assert.deepEqual(report.settings, {});
  assert.equal(report.summary.skills, 0);
  assert.ok(report.findings.some(f => f.code === 'CONFIG_MISSING'));
  assert.ok(report.recommendations.some(r => r.setting === 'skills.max_context_tokens' && r.proposedValue === 2000 && r.officialDefault === false));
  assert.ok(report.recommendations.some(r => r.setting === 'tool_output_token_limit' && r.proposedValue === 4000));
  assert.doesNotThrow(() => JSON.stringify(report));
});

test('configuration whitelist excludes credentials, raw config, MCP/plugin names and parser errors', async t => {
  const { options, put, auditCodex } = await fixture(t);
  const path = join(options.codexHome, 'config.toml');
  put(path, `model = "gpt-6.1"\nmodel_reasoning_effort = "high"\nservice_tier = "fast"\ntool_output_token_limit = 9000\napi_key = "${SECRET}"\n[skills]\nmax_context_tokens = 8000\n[agents]\nmax_concurrent_threads_per_session = 3\n[mcp_servers.${SECRET}]\ntoken = "${SECRET}"\n[plugins.${SECRET}]\nenabled = true\n`);
  const report = await auditCodex(options);
  assert.equal(report.settings.model, 'gpt-6.1');
  assert.equal(report.settings.skills.max_context_tokens, 8000);
  assert.equal(report.settings.agents.max_concurrent_threads_per_session, 3);
  assert.equal(report.summary.mcpServers, 1);
  assert.equal(report.summary.plugins, 1);
  assert.ok(!JSON.stringify(report).includes(SECRET));
  put(path, `model = "${SECRET}\n`);
  const invalid = await auditCodex(options);
  assert.ok(invalid.findings.some(f => f.code === 'CONFIG_INVALID'));
  assert.ok(!JSON.stringify(invalid).includes(SECRET));
});

test('catalog metadata detects duplicates, long/broad descriptions and identical instructions', async t => {
  const { options, put, skill, auditCodex } = await fixture(t);
  skill(join(options.homeDirectory, '.agents/skills'), 'one', 'same', 'Use for everything');
  skill(join(options.codexHome, 'skills'), 'two', 'same', 'x'.repeat(1100));
  skill(join(options.projectRoot, '.agents/skills'), 'three', 'third', 'Specific task');
  put(join(options.homeDirectory, '.codex/AGENTS.md'), SECRET);
  put(join(options.codexHome, 'AGENTS.md'), SECRET);
  put(join(options.projectRoot, 'AGENTS.md'), SECRET);
  const report = await auditCodex(options);
  assert.equal(report.summary.skills, 3);
  for (const code of ['SKILL_DUPLICATE_NAME', 'SKILL_DESCRIPTION_BROAD', 'SKILL_DESCRIPTION_LONG', 'INSTRUCTIONS_DUPLICATE']) {
    assert.ok(report.findings.some(f => f.code === code), code);
  }
  assert.ok(report.summary.skillBytes > 1100);
  assert.ok(!JSON.stringify(report).includes(SECRET));
});

test('symlinks stay inside catalog roots; external roots, files and cycles are omitted', async t => {
  const { root, options, put, skill, auditCodex } = await fixture(t);
  const base = join(options.codexHome, 'skills');
  skill(base, 'real', 'allowed', 'Specific');
  symlinkSync(join(base, 'real'), join(base, 'alias'));
  symlinkSync(base, join(base, 'cycle'));
  skill(join(root, 'outside'), 'external', SECRET, SECRET);
  symlinkSync(join(root, 'outside/external'), join(base, 'escape'));
  mkdirSync(join(base, 'file-link'));
  symlinkSync(join(root, 'outside/external/SKILL.md'), join(base, 'file-link/SKILL.md'));
  mkdirSync(join(options.projectRoot, '.agents'), { recursive: true });
  symlinkSync(join(root, 'outside'), join(options.projectRoot, '.agents/skills'));
  put(join(options.codexHome, 'auth.json'), SECRET);
  symlinkSync(join(options.codexHome, 'auth.json'), join(options.codexHome, 'config.toml'));
  const report = await auditCodex(options);
  assert.equal(report.summary.skills, 1);
  assert.ok(report.findings.some(f => f.code === 'PATH_OMITTED'));
  assert.ok(!JSON.stringify(report).includes(SECRET));
});

test('large files, metadata and catalogs are bounded and reported', async t => {
  const { options, put, skill, auditCodex } = await fixture(t);
  put(join(options.codexHome, 'config.toml'), '#'.repeat(300_000));
  put(join(options.projectRoot, 'AGENTS.md'), 'x'.repeat(300_000));
  const base = join(options.codexHome, 'skills');
  skill(base, 'large', 'large', 'x'.repeat(20_000));
  for (let i = 0; i < 520; i++) skill(base, `s${i}`, `skill-${i}`, 'Specific');
  const report = await auditCodex(options);
  assert.ok(report.findings.some(f => f.code === 'READ_LIMIT'));
  assert.ok(report.findings.some(f => f.code === 'CATALOG_LIMIT'));
  assert.ok(report.summary.skills <= 512);
  assert.ok(!JSON.stringify(report).includes(SECRET));
});

test('CODEX_HOME is used unless explicitly overridden', async t => {
  const { root, options, put, auditCodex } = await fixture(t);
  const previous = process.env.CODEX_HOME;
  t.after(() => { if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous; });
  process.env.CODEX_HOME = join(root, 'environment');
  put(join(process.env.CODEX_HOME, 'config.toml'), 'model = "gpt-6.1"');
  const { codexHome, ...withoutOverride } = options;
  assert.equal((await auditCodex(withoutOverride)).settings.model, 'gpt-6.1');
  assert.deepEqual((await auditCodex(options)).settings, {});
});

test('broken links do not abort the catalog; root links cannot authorize other home trees', async t => {
  const { options, put, skill, auditCodex } = await fixture(t);
  const base = join(options.codexHome, 'skills');
  mkdirSync(base, { recursive: true });
  symlinkSync(join(base, 'missing'), join(base, 'broken'));
  skill(base, 'valid', 'valid', 'Specific');
  skill(join(options.homeDirectory, 'plugins'), 'hidden', 'hidden', 'Specific');
  mkdirSync(join(options.homeDirectory, '.agents'), { recursive: true });
  symlinkSync(join(options.homeDirectory, 'plugins'), join(options.homeDirectory, '.agents/skills'));
  put(join(options.projectRoot, '.agents/skills/eof/SKILL.md'), '---\nname: eof\ndescription: Specific\n---');
  const report = await auditCodex(options);
  assert.equal(report.summary.skills, 2);
  assert.ok(report.findings.some(f => f.code === 'PATH_OMITTED'));
  assert.ok(!report.findings.some(f => f.code === 'SKILL_METADATA_INVALID'));
});

test('actionable findings expose only validated slugs and relative catalog locations', async t => {
  const { options, skill, auditCodex } = await fixture(t);
  skill(join(options.codexHome, 'skills'), 'first', 'same', 'Use for everything');
  skill(join(options.projectRoot, '.agents/skills'), 'second', 'same', 'x'.repeat(1100));
  skill(join(options.codexHome, 'skills'), SECRET, SECRET, 'Use for everything');
  skill(join(options.projectRoot, '.agents/skills'), 'invalid', SECRET, 'Use for everything');
  const report = await auditCodex(options);
  const duplicate = report.findings.find(f => f.code === 'SKILL_DUPLICATE_NAME' && f.skillName === 'same');
  assert.ok(duplicate);
  assert.deepEqual(duplicate.locations, [
    { scope: 'codex-skills', directory: 'first' },
    { scope: 'project-skills', directory: 'second' },
  ]);
  const broad = report.findings.find(f => f.code === 'SKILL_DESCRIPTION_BROAD' && f.skillName === 'same');
  assert.equal(broad.locations[0].directory, 'first');
  assert.equal(report.findings.find(f => f.code === 'SKILL_DESCRIPTION_LONG').locations[0].directory, 'second');
  assert.ok(report.findings.some(f => f.skillName === 'omitido'));
  assert.ok(!JSON.stringify(report).includes(SECRET));
  assert.equal(report.coverage.partial, true);
  for (const scope of ['remote-plugins', 'profiles', 'project-config', 'ancestor-instructions']) assert.ok(report.coverage.notInspected.includes(scope));
});

test('effort whitelist preserves max and ultra without model lookup', async t => {
  const { options, put, auditCodex } = await fixture(t);
  for (const effort of ['max', 'ultra']) {
    put(join(options.codexHome, 'config.toml'), `model_reasoning_effort = "${effort}"`);
    assert.equal((await auditCodex(options)).settings.model_reasoning_effort, effort);
  }
});
