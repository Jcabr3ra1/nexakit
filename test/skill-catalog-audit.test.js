import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { loadSkillCatalog } from '../src/skill-catalog.js';

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'catalog-audit-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const base = await loadSkillCatalog();
  const catalog = structuredClone(base);
  catalog.skills = Array.from({ length: 11 }, (_, i) => ({ ...structuredClone(base.skills[0]), name: i === 0 ? base.skills[0].name : i === 1 ? 'custom-react-helper' : `custom-react-helper-${i}` }));
  catalog.externalReferences = []; catalog.addons = [];
  for (const skill of catalog.skills) {
    skill.installedPath = `catalogs/skills/${skill.name}`;
    skill.overlapsWith = [];
    const dir = path.join(root, skill.installedPath);
    await fs.mkdir(dir, { recursive: true });
    const bytes = `# ${skill.name}\nSynthetic test fixture, no real usefulness evaluation.\n`;
    await fs.writeFile(path.join(dir, 'SKILL.md'), bytes);
    skill.files = [{ path: 'SKILL.md', sha256: createHash('sha256').update(bytes).digest('hex') }];
  }
  await fs.mkdir(path.join(root, 'catalogs'), { recursive: true });
  const save = () => fs.writeFile(path.join(root, 'catalogs/skills.json'), JSON.stringify(catalog));
  await save();
  return { root, catalog, save };
}

test('audit accepts additional catalog entries, verifies their files, and never writes', async t => {
  const { auditSkillCatalog } = await import('../src/skill-catalog-audit.js');
  const { inspectSkillProject, recommendSkills } = await import('../src/skill-recommendations.js');
  const f = await fixture(t);
  const before = await fs.readFile(path.join(f.root, 'catalogs/skills.json'), 'utf8');
  const report = await auditSkillCatalog({ toolkitRoot: f.root });
  assert.equal(report.ok, true);
  assert.equal(report.verifiedSkillsCount, 11);
  assert.deepEqual(report.errors, []);
  await fs.writeFile(path.join(f.root, 'package.json'), JSON.stringify({ dependencies: { react: '19' } }));
  const catalog = await loadSkillCatalog({ catalogUrl: pathToFileURL(path.join(f.root, 'catalogs/skills.json')) });
  const inspection = await inspectSkillProject(f.root, { toolkitRoot: f.root, catalog });
  assert.ok(recommendSkills({ catalog, inspection }).candidates.some(skill => skill.name === 'custom-react-helper'));
  assert.equal(await fs.readFile(path.join(f.root, 'catalogs/skills.json'), 'utf8'), before);
});

for (const mutation of ['hash', 'extra-file', 'symlink', 'parent-symlink']) {
  test(`audit rejects ${mutation} without changing the manifest or source`, async t => {
    const { auditSkillCatalog } = await import('../src/skill-catalog-audit.js');
    const f = await fixture(t);
    const skillDir = path.join(f.root, f.catalog.skills[0].installedPath);
    if (mutation === 'hash') await fs.appendFile(path.join(skillDir, 'SKILL.md'), 'changed');
    if (mutation === 'extra-file') await fs.writeFile(path.join(skillDir, 'extra.txt'), 'extra');
    if (mutation === 'symlink') await fs.symlink('SKILL.md', path.join(skillDir, 'alias.md'));
    if (mutation === 'parent-symlink') {
      await fs.rename(path.join(f.root, 'catalogs/skills'), path.join(f.root, 'physical-skills'));
      await fs.symlink('../physical-skills', path.join(f.root, 'catalogs/skills'), process.platform === 'win32' ? 'junction' : 'dir');
    }
    const before = await fs.readFile(path.join(f.root, 'catalogs/skills.json'), 'utf8');
    const result = await auditSkillCatalog({ toolkitRoot: f.root });
    assert.equal(result.ok, false);
    assert.ok(result.errors.length > 0);
    assert.equal(await fs.readFile(path.join(f.root, 'catalogs/skills.json'), 'utf8'), before);
  });
}

test('passed scenarios require a present regular evidence file and duplicate ids are rejected', async t => {
  const { auditSkillCatalog } = await import('../src/skill-catalog-audit.js');
  const f = await fixture(t);
  const skill = f.catalog.skills[0];
  skill.scenarios = [{ id: 'synthetic-test', revision: skill.revision, profile: 'frontend', taskClass: 'ui-authoring', requiredSignals: ['react'], client: 'claude', status: 'passed', evidencePath: 'docs/skills/evidencias/evidence.md' }];
  await f.save();
  assert.equal((await auditSkillCatalog({ toolkitRoot: f.root })).ok, false);
  await fs.mkdir(path.join(f.root, 'docs/skills/evidencias'), { recursive: true });
  await fs.writeFile(path.join(f.root, 'docs/skills/evidencias/evidence.md'), 'Synthetic test fixture evidence, not a real evaluation.');
  assert.equal((await auditSkillCatalog({ toolkitRoot: f.root })).ok, true);
  skill.scenarios.push({ ...skill.scenarios[0] });
  await f.save();
  assert.equal((await auditSkillCatalog({ toolkitRoot: f.root })).ok, false);
});

test('validator CLI returns useful exit codes and inventories new skill files without updating hashes', async t => {
  const { runSkillCatalogValidation } = await import('../scripts/validate-skill-catalog.js');
  const f = await fixture(t);
  let output = '', errors = '';
  const io = { out: text => { output += text; }, err: text => { errors += text; } };
  assert.equal(await runSkillCatalogValidation(['--root', f.root, '--json'], io), 0);
  assert.equal(JSON.parse(output).verifiedSkillsCount, 11);
  output = '';
  assert.equal(await runSkillCatalogValidation(['--root', f.root, '--files', f.catalog.skills[1].installedPath], io), 0);
  assert.deepEqual(JSON.parse(output), f.catalog.skills[1].files);
  const before = await fs.readFile(path.join(f.root, 'catalogs/skills.json'), 'utf8');
  await fs.appendFile(path.join(f.root, f.catalog.skills[1].installedPath, 'SKILL.md'), 'changed');
  output = '';
  assert.equal(await runSkillCatalogValidation(['--root', f.root, '--json'], io), 1);
  assert.equal(JSON.parse(output).ok, false);
  assert.equal(await fs.readFile(path.join(f.root, 'catalogs/skills.json'), 'utf8'), before);
  assert.equal(await runSkillCatalogValidation(['--files', '../escape'], io), 2);
  assert.equal(await runSkillCatalogValidation(['--unknown'], io), 2);
  assert.ok(errors.length > 0);
});

test('catalog loading rejects non-regular resources before attempting to read them', async t => {
  const { auditSkillCatalog } = await import('../src/skill-catalog-audit.js');
  const f = await fixture(t);
  const catalogPath = path.join(f.root, 'catalogs/skills.json');
  await fs.unlink(catalogPath);
  await fs.mkdir(catalogPath);
  const readFile = fs.readFile.bind(fs);
  let attemptedRead = false;
  t.mock.method(fs, 'readFile', (file, ...args) => {
    const actualPath = file instanceof URL ? fileURLToPath(file) : path.resolve(file);
    if (actualPath === catalogPath) { attemptedRead = true; throw new Error('Special resource read attempted'); }
    return readFile(file, ...args);
  });
  const report = await auditSkillCatalog({ toolkitRoot: f.root });
  assert.equal(report.ok, false);
  assert.equal(attemptedRead, false, 'a FIFO must be rejected by the same type guard before readFile can block');
});

async function rewriteSkill(f, index, files) {
  const skill = f.catalog.skills[index];
  const dir = path.join(f.root, skill.installedPath);
  await fs.rm(dir, { recursive: true, force: true });
  skill.files = [];
  for (const [rel, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), text);
    skill.files.push({ path: rel, sha256: createHash('sha256').update(text).digest('hex') });
  }
  await f.save();
  return skill;
}

test('audit fails when the scanner blocks a skill', async t => {
  const { auditSkillCatalog } = await import('../src/skill-catalog-audit.js');
  const f = await fixture(t);
  const skill = await rewriteSkill(f, 1, { 'SKILL.md': '# A\nhola​mundo\n' });
  const report = await auditSkillCatalog({ toolkitRoot: f.root });
  assert.equal(report.ok, false);
  assert.ok(report.errors.includes(`${skill.name}: bloqueo del escáner (unicode-oculto en SKILL.md:2).`));
});

test('audit keeps scanner warnings as pending items', async t => {
  const { auditSkillCatalog } = await import('../src/skill-catalog-audit.js');
  const f = await fixture(t);
  const skill = await rewriteSkill(f, 1, { 'SKILL.md': '# A\n<!-- nota -->\n' });
  const report = await auditSkillCatalog({ toolkitRoot: f.root });
  assert.equal(report.ok, true);
  assert.ok(report.warnings.includes(`${skill.name}: aviso del escáner (instruccion-oculta en SKILL.md:2).`));
});

test('audit warns about undeclared capabilities', async t => {
  const { auditSkillCatalog } = await import('../src/skill-catalog-audit.js');
  const f = await fixture(t);
  f.catalog.skills[1].review.capabilities = { filesystem: 'none', processes: 'optional', network: 'none', paidApi: 'none' };
  const skill = await rewriteSkill(f, 1, { 'SKILL.md': '# A\n', 'scripts/a.js': "await fetch('https://x.test');\n" });
  const report = await auditSkillCatalog({ toolkitRoot: f.root });
  assert.equal(report.ok, true);
  assert.ok(report.warnings.includes(`${skill.name}: capacidad no declarada: network.`));
  assert.ok(!report.warnings.includes(`${skill.name}: capacidad no declarada: processes.`));
});

test('audit warns about folders in catalogs/skills that the catalog does not list', async t => {
  const { auditSkillCatalog } = await import('../src/skill-catalog-audit.js');
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, 'catalogs/skills/huerfana.anterior-123'), { recursive: true });
  const report = await auditSkillCatalog({ toolkitRoot: f.root });
  assert.ok(report.warnings.includes('Carpeta sin entrada en el catálogo: catalogs/skills/huerfana.anterior-123.'));
});
