import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function walkFiles(dir, prefix = '') {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walkFiles(full, rel));
    else if (entry.isFile()) files.push({ path: rel, sha256: sha256(await fs.readFile(full)) });
  }
  return files;
}

test('loadSkillCatalog loads all bundled skills matching real disk hashes without polluting global setupToolkit', async t => {
  const { loadSkillCatalog } = await import('../src/skill-catalog.js');
  const { setupToolkit } = await import('../src/toolkit-setup.js');
  const catalog = await loadSkillCatalog();
  assert.equal(Object.isFrozen(catalog), true);
  assert.equal(Object.isFrozen(catalog.skills), true);
  assert.equal(Object.isFrozen(catalog.addons), true);

  const names = catalog.skills.filter(s => s.bundled).map(s => s.name).sort();
  const originalSkills = [
    'api-design-principles',
    'differential-review',
    'frontend-design',
    'mcp-builder',
    'nodejs-backend-patterns',
    'supabase-postgres-best-practices',
    'vercel-composition-patterns',
    'vercel-react-best-practices',
    'web-design-guidelines',
    'webapp-testing'
  ];
  for (const name of originalSkills) assert.ok(names.includes(name), `missing bundled skill: ${name}`);
  assert.equal(new Set(names).size, names.length);

  for (const entry of catalog.skills.filter(s => s.bundled)) {
    const diskFiles = await walkFiles(path.join(ROOT, entry.installedPath));
    const manifestFiles = [...entry.files].map(({ path: p, sha256: h }) => ({ path: p, sha256: h }))
      .sort((a, b) => a.path.localeCompare(b.path));
    assert.deepEqual(manifestFiles, diskFiles, `hash mismatch for ${entry.name}`);
  }

  // Stack-specific skills under catalogs/skills/ must NOT be globally linked by setupToolkit
  const tmpHome = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'catalog-global-')));
  t.after(() => fs.rm(tmpHome, { recursive: true, force: true }));
  const globalPreview = await setupToolkit({ homeDirectory: tmpHome, toolkitRoot: ROOT, agent: 'codex', apply: false });
  const globalSkillNames = globalPreview.skills.map(s => s.name);
  assert.equal(globalSkillNames.includes('vercel-react-best-practices'), false);
  assert.equal(globalSkillNames.includes('supabase-postgres-best-practices'), false);

  const superpowers = catalog.addons.find(a => a.id === 'superpowers');
  assert.ok(superpowers, 'includes the required superpowers addon');
  assert.equal(superpowers.optional, false);
  assert.equal(superpowers.autoInstall, true);
  assert.deepEqual(superpowers.adaptedSkills, ['quality-gate']);
  assert.equal(superpowers.license, 'MIT');

  const pkg = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.files.includes('catalogs/'), true, 'package.json files includes catalogs/');
});

test('validateSkillCatalog rejects duplicates, bad hashes, path traversal and mismatched scenario revisions', async () => {
  const { loadSkillCatalog, validateSkillCatalog, SkillCatalogError } = await import('../src/skill-catalog.js');
  const base = JSON.parse(JSON.stringify(await loadSkillCatalog()));

  const validated = validateSkillCatalog(structuredClone(base));
  assert.equal(Object.isFrozen(validated), true);

  // 1. Duplicate skill names
  const dupSkill = structuredClone(base);
  dupSkill.skills.push(structuredClone(dupSkill.skills[0]));
  assert.throws(() => validateSkillCatalog(dupSkill), err => err instanceof SkillCatalogError && err.code === 'SKILL_CATALOG_INVALID');

  // 2. Invalid SHA-256 hash
  const badHash = structuredClone(base);
  badHash.skills[0].files[0].sha256 = 'not-a-sha256';
  assert.throws(() => validateSkillCatalog(badHash), err => err instanceof SkillCatalogError && err.code === 'SKILL_CATALOG_INVALID');

  // 3. Invalid git revision
  const badRevision = structuredClone(base);
  badRevision.skills[0].revision = 'main';
  assert.throws(() => validateSkillCatalog(badRevision), err => err instanceof SkillCatalogError && err.code === 'SKILL_CATALOG_INVALID');

  // 4. Duplicate file path inside manifest
  const dupFile = structuredClone(base);
  dupFile.skills[0].files.push({ ...dupFile.skills[0].files[0] });
  assert.throws(() => validateSkillCatalog(dupFile), err => err instanceof SkillCatalogError && err.code === 'SKILL_CATALOG_INVALID');

  // 5. Path traversal in file path or installedPath
  const traversal = structuredClone(base);
  traversal.skills[0].files[0].path = '../secret.txt';
  assert.throws(() => validateSkillCatalog(traversal), err => err instanceof SkillCatalogError && err.code === 'SKILL_CATALOG_INVALID');

  const badInstalledPath = structuredClone(base);
  badInstalledPath.skills[0].installedPath = `outside/${badInstalledPath.skills[0].name}`;
  assert.throws(() => validateSkillCatalog(badInstalledPath), err => err instanceof SkillCatalogError && err.code === 'SKILL_CATALOG_INVALID');

  // 6. Scenario referencing a different revision than the entry
  const mismatchedScenario = structuredClone(base);
  mismatchedScenario.skills[0].scenarios = [{
    id: 'ui-build',
    revision: '0'.repeat(40),
    profile: mismatchedScenario.skills[0].matching.profiles[0],
    taskClass: mismatchedScenario.skills[0].matching.taskClasses[0],
    requiredSignals: ['react'],
    client: 'claude',
    status: 'passed',
    evidencePath: 'docs/skills/evidencias/2026-10-28-evaluacion-inicial-mcp-seguridad.md'
  }];
  assert.throws(() => validateSkillCatalog(mismatchedScenario), err => err instanceof SkillCatalogError && err.code === 'SKILL_CATALOG_INVALID');
});
