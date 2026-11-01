import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { loadSkillCatalog, validateSkillCatalog } from '../src/skill-catalog.js';
import { writeFakeInstall } from '../test-support/fake-npm.js';

const TOOLKIT_ROOT = fileURLToPath(new URL('../', import.meta.url));
const linkType = process.platform === 'win32' ? 'junction' : 'dir';

async function tempProject(t, files = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'skill-rec-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  return root;
}

async function snapshotTree(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out = [];
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, e.name);
    if (e.isSymbolicLink()) out.push({ name: e.name, type: 'link', target: await fs.readlink(full) });
    else if (e.isDirectory()) out.push({ name: e.name, type: 'dir', children: await snapshotTree(full) });
    else out.push({ name: e.name, type: 'file', content: await fs.readFile(full, 'utf8') });
  }
  return out;
}

test('Node-only and Node+MCP fixtures do not invent frontend, HTTP frameworks or databases, and perform zero writes', async t => {
  const { inspectSkillProject, recommendSkills } = await import('../src/skill-recommendations.js');
  const catalog = await loadSkillCatalog();

  const nodeOnly = await tempProject(t, {
    'package.json': { name: 'plain-cli', version: '1.0.0', dependencies: { zod: '^4.0.0' } },
    '.env': 'SECRET_TOKEN=must-never-be-read'
  });
  const before = await snapshotTree(nodeOnly);
  const nodeInspection = await inspectSkillProject(nodeOnly, { toolkitRoot: TOOLKIT_ROOT });
  assert.deepEqual(nodeInspection.signals.map(s => s.id), ['nodejs']);
  const nodeRec = recommendSkills({ catalog, inspection: nodeInspection });
  assert.deepEqual(nodeRec.recommended, []);
  assert.deepEqual(nodeRec.candidates, []);
  assert.equal(nodeRec.optional.length, catalog.skills.filter(skill => skill.review.status !== 'rejected').length);
  assert.equal(JSON.stringify({ nodeInspection, nodeRec }).includes('SECRET_TOKEN'), false);
  assert.deepEqual(await snapshotTree(nodeOnly), before);

  // Inspecting Agent Toolkit itself detects Node.js and MCP SDK without inventing React/Next/Hono
  const toolkitInspection = await inspectSkillProject(TOOLKIT_ROOT, { toolkitRoot: TOOLKIT_ROOT });
  assert.deepEqual(toolkitInspection.signals.map(s => s.id).sort(), ['mcp-sdk', 'nodejs']);
  const toolkitRec = recommendSkills({ catalog, inspection: toolkitInspection });
  assert.equal(toolkitRec.recommended.length, 0);
  assert.deepEqual(toolkitRec.candidates.map(c => c.name), ['mcp-builder']);
  assert.equal(toolkitRec.candidates[0].installed?.integrity, 'verified');
  assert.equal(toolkitRec.optional.some(o => o.name === 'differential-review'), true);
});

test('Full-stack fixture matches fundamental verified skills (Vercel React, Supabase, Node API) and separates optional skills', async t => {
  const { inspectSkillProject, recommendSkills } = await import('../src/skill-recommendations.js');
  const catalog = await loadSkillCatalog();

  const webApp = await tempProject(t, {
    'package.json': {
      name: 'modern-fullstack',
      dependencies: {
        next: '15.0.0',
        react: '19.0.0',
        '@supabase/supabase-js': '2.45.0',
        express: '5.0.0'
      },
      devDependencies: {
        tailwindcss: '4.0.0',
        vitest: '3.0.0'
      }
    },
    'tsconfig.json': '{"compilerOptions":{"strict":true}}'
  });

  const inspection = await inspectSkillProject(webApp, { toolkitRoot: TOOLKIT_ROOT });
  assert.deepEqual(
    inspection.signals.map(s => s.id).sort(),
    ['express', 'nextjs', 'nodejs', 'react', 'supabase', 'tailwindcss', 'typescript', 'vitest']
  );

  const rec = recommendSkills({ catalog, inspection });
  assert.deepEqual(
    rec.candidates.map(c => c.name).sort(),
    [
      'api-design-principles',
      'frontend-design',
      'nodejs-backend-patterns',
      'supabase-postgres-best-practices',
      'vercel-composition-patterns',
      'vercel-react-best-practices',
      'web-design-guidelines'
    ]
  );
  assert.deepEqual(
    rec.optional.map(o => o.name).sort(),
    ['differential-review', 'mcp-builder', 'webapp-testing']
  );
  assert.deepEqual(rec.unmatchedSignals.map(u => u.id), ['vitest']);
  assert.equal(rec.addons.some(a => a.id === 'superpowers'), true);
});

test('malformed package.json, unconfirmed config files, non-Node manifests and scenario 4-criteria gate are handled safely', async t => {
  const { inspectSkillProject, recommendSkills } = await import('../src/skill-recommendations.js');
  const baseCatalog = JSON.parse(JSON.stringify(await loadSkillCatalog()));

  const broken = await tempProject(t, {
    'package.json': '{ broken json ',
    'next.config.mjs': 'export default {};',
    'Cargo.toml': '[package]\nname = "rust-app"\n'
  });
  const brokenInspection = await inspectSkillProject(broken, { toolkitRoot: TOOLKIT_ROOT });
  assert.deepEqual(brokenInspection.signals, []);
  assert.equal(brokenInspection.limits.some(l => /package\.json/u.test(l)), true);
  assert.equal(brokenInspection.limits.some(l => /next\.config\.mjs/u.test(l)), true);
  assert.equal(brokenInspection.limits.some(l => /Cargo\.toml/u.test(l)), true);

  const customCatalogData = structuredClone(baseCatalog);
  const fd = customCatalogData.skills.find(s => s.name === 'frontend-design');
  fd.scenarios.push({
    id: 'react-ui-claude',
    revision: fd.revision,
    profile: 'frontend',
    taskClass: 'ui-authoring',
    requiredSignals: ['react'],
    client: 'claude',
    status: 'passed',
    evidencePath: 'docs/skills/evidencias/2026-10-28-evaluacion-inicial-mcp-seguridad.md'
  });
  const customCatalog = validateSkillCatalog(customCatalogData);

  const reactProject = await tempProject(t, {
    'package.json': { name: 'ui', dependencies: { react: '19.0.0' } }
  });
  const reactInspection = await inspectSkillProject(reactProject, { toolkitRoot: TOOLKIT_ROOT });
  assert.equal(recommendSkills({ catalog: customCatalog, inspection: reactInspection, profile: 'frontend' }).recommended.length, 0);
  assert.deepEqual(
    recommendSkills({ catalog: customCatalog, inspection: reactInspection, profile: 'frontend', client: 'claude' }).recommended.map(r => r.name),
    ['frontend-design']
  );
});

test('supports both symlink mode and verified copy + skills-lock.json mode, preserves conflicts and rejects tampered SHA-256', async t => {
  const {
    inspectSkillProject,
    planProjectSkillInstall,
    applyProjectSkillInstall,
    verifyBundledSkillHashes
  } = await import('../src/skill-recommendations.js');
  const catalog = await loadSkillCatalog();

  // 1. Symlink mode works for both skills/ and catalogs/skills/
  const symlinkProj = await tempProject(t, {
    'package.json': { name: 'sym-app', dependencies: { react: '19.0.0' } }
  });
  const symPlan = await planProjectSkillInstall({
    projectRoot: symlinkProj,
    skillNames: ['frontend-design', 'vercel-react-best-practices'],
    agent: 'all',
    mode: 'symlink',
    catalog,
    toolkitRoot: TOOLKIT_ROOT,
    homeDirectory: await tempProject(t)
  });
  assert.equal(symPlan.applied, false);
  const symApplied = await applyProjectSkillInstall(symPlan);
  assert.equal(symApplied.created, 4);
  assert.equal(
    await fs.realpath(path.join(symlinkProj, '.agents/skills/vercel-react-best-practices')),
    await fs.realpath(path.join(TOOLKIT_ROOT, 'catalogs/skills/vercel-react-best-practices'))
  );
  const symInspect = await inspectSkillProject(symlinkProj, { toolkitRoot: TOOLKIT_ROOT, catalog });
  const vrbp = symInspect.installed.find(i => i.name === 'vercel-react-best-practices');
  assert.equal(vrbp.integrity, 'verified');

  // 2. Copy + skills-lock.json mode copies verified files, is idempotent, and preserves conflicts
  const copyProj = await tempProject(t, {
    'package.json': { name: 'copy-app', dependencies: { express: '5.0.0' } },
    '.agents/skills/api-design-principles/SKILL.md': 'local user customization'
  });
  const copyPlan = await planProjectSkillInstall({
    projectRoot: copyProj,
    skillNames: ['nodejs-backend-patterns', 'api-design-principles'],
    agent: 'all',
    mode: 'copy',
    catalog,
    toolkitRoot: TOOLKIT_ROOT,
    homeDirectory: await tempProject(t)
  });
  assert.equal(copyPlan.conflicts, 1);
  assert.equal(copyPlan.willWriteLockfile, true);

  const copyApplied = await applyProjectSkillInstall(copyPlan);
  assert.equal(copyApplied.created, 3); // codex+claude nodejs-backend-patterns + claude api-design-principles
  assert.equal(copyApplied.conflicts, 1);
  assert.equal(copyApplied.lockfileWritten, true);

  // Conflict untouched
  assert.equal(
    await fs.readFile(path.join(copyProj, '.agents/skills/api-design-principles/SKILL.md'), 'utf8'),
    'local user customization'
  );
  // Copied directory is a real directory (not a symlink) and passes integrity verification
  const copiedStat = await fs.lstat(path.join(copyProj, '.claude/skills/nodejs-backend-patterns'));
  assert.equal(copiedStat.isDirectory() && !copiedStat.isSymbolicLink(), true);

  const lock = JSON.parse(await fs.readFile(path.join(copyProj, '.agent-toolkit/skills-lock.json'), 'utf8'));
  assert.equal(lock.lockfileVersion, 1);
  assert.equal(lock.skills['nodejs-backend-patterns'].license, 'MIT');
  assert.deepEqual(lock.skills['nodejs-backend-patterns'].clients, ['claude', 'codex']);
  assert.equal(await fs.access(path.join(copyProj, 'skills-lock.json')).then(() => true, () => false), false);

  // Repeating copy plan sees existing verified copies as 'installed' (0 new creations needed!)
  const repeatPlan = await planProjectSkillInstall({
    projectRoot: copyProj,
    skillNames: ['nodejs-backend-patterns'],
    agent: 'all',
    mode: 'copy',
    catalog,
    toolkitRoot: TOOLKIT_ROOT,
    homeDirectory: await tempProject(t)
  });
  assert.equal(repeatPlan.links.every(l => l.state === 'installed'), true);

  // 3. Tampered bundled file is rejected by SHA-256 check BEFORE writing anything
  const fakeToolkit = await tempProject(t, {});
  const nodePatternsEntry = catalog.skills.find(s => s.name === 'nodejs-backend-patterns');
  await fs.cp(
    path.join(TOOLKIT_ROOT, nodePatternsEntry.installedPath),
    path.join(fakeToolkit, nodePatternsEntry.installedPath),
    { recursive: true }
  );
  await fs.appendFile(path.join(fakeToolkit, nodePatternsEntry.installedPath, 'SKILL.md'), '\n<!-- tampered -->\n');

  const check = await verifyBundledSkillHashes({ skillEntry: nodePatternsEntry, toolkitRoot: fakeToolkit });
  assert.equal(check.ok, false);

  const cleanTargetProj = await tempProject(t, { 'package.json': { name: 'safe' } });
  await assert.rejects(
    planProjectSkillInstall({
      projectRoot: cleanTargetProj,
      skillNames: ['nodejs-backend-patterns'],
      agent: 'codex',
      mode: 'copy',
      catalog,
      toolkitRoot: fakeToolkit
    }),
    /SHA-256/u
  );
});

test('git ignore management (.gitignore & .git/info/exclude) and safe decoupling (planToolkitDetach / applyToolkitDetach)', async t => {
  const {
    inspectSkillProject,
    planProjectSkillInstall,
    applyProjectSkillInstall,
    planToolkitDetach,
    applyToolkitDetach
  } = await import('../src/skill-recommendations.js');
  const catalog = await loadSkillCatalog();

  // Case A: Existing .gitignore rules are preserved on install AND restored byte-for-byte on detach;
  // custom user skills are NEVER removed on detach!
  const projA = await tempProject(t, {
    'package.json': { name: 'proj-a', dependencies: { react: '19.0.0' } },
    '.gitignore': 'node_modules/\ndist/\n',
    '.claude/skills/my-custom-skill/SKILL.md': '# My team skill\n'
  });

  const planA = await planProjectSkillInstall({
    projectRoot: projA,
    skillNames: ['vercel-react-best-practices'],
    agent: 'all',
    mode: 'symlink',
    gitIgnore: 'gitignore',
    catalog,
    toolkitRoot: TOOLKIT_ROOT,
    homeDirectory: await tempProject(t)
  });
  await applyProjectSkillInstall(planA);

  const gitignoreAfterInstall = await fs.readFile(path.join(projA, '.gitignore'), 'utf8');
  assert.match(gitignoreAfterInstall, /^node_modules\/\ndist\/\n\n# >>> agent-toolkit/u);
  assert.match(gitignoreAfterInstall, /\.agent-toolkit\//u);
  assert.match(gitignoreAfterInstall, /\.agents\/skills\/vercel-react-best-practices/u);
  assert.match(gitignoreAfterInstall, /\.claude\/skills\/vercel-react-best-practices/u);
  assert.doesNotMatch(gitignoreAfterInstall, /my-custom-skill/u);

  const inspectCoupled = await inspectSkillProject(projA, { toolkitRoot: TOOLKIT_ROOT, catalog });
  assert.equal(inspectCoupled.coupling.coupled, true);

  // Preview detach does not delete anything
  const detachPlanA = await planToolkitDetach({
    projectRoot: projA,
    catalog,
    toolkitRoot: TOOLKIT_ROOT,
    homeDirectory: await tempProject(t)
  });
  assert.equal(detachPlanA.applied, false);
  assert.equal(detachPlanA.removeStateDir, true);
  assert.equal(await fs.access(path.join(projA, '.agent-toolkit/manifest.json')).then(() => true, () => false), true);

  // Apply detach removes coupled symlinks, .agent-toolkit/, empty .agents/, and restores .gitignore while keeping custom skill!
  const detachedA = await applyToolkitDetach(detachPlanA);
  assert.equal(detachedA.removedCount, 2);
  assert.equal(detachedA.stateDirRemoved, true);
  assert.equal(await fs.readFile(path.join(projA, '.gitignore'), 'utf8'), 'node_modules/\ndist/\n');
  assert.equal(await fs.access(path.join(projA, '.agent-toolkit')).then(() => true, () => false), false);
  assert.equal(await fs.access(path.join(projA, '.agents')).then(() => true, () => false), false);
  assert.equal(await fs.readFile(path.join(projA, '.claude/skills/my-custom-skill/SKILL.md'), 'utf8'), '# My team skill\n');

  const inspectAfterDetach = await inspectSkillProject(projA, { toolkitRoot: TOOLKIT_ROOT, catalog });
  assert.equal(inspectAfterDetach.coupling.coupled, false);

  // Case B: .git/info/exclude strategy + copy mode + modified copy protection on detach
  const projB = await tempProject(t, {
    'package.json': { name: 'proj-b', dependencies: { express: '5.0.0' } },
    '.git/info/exclude': '# git ls-files --others --exclude-from=.git/info/exclude\n'
  });

  const planB = await planProjectSkillInstall({
    projectRoot: projB,
    skillNames: ['nodejs-backend-patterns', 'api-design-principles'],
    agent: 'codex',
    mode: 'copy',
    gitIgnore: 'git-exclude',
    catalog,
    toolkitRoot: TOOLKIT_ROOT,
    homeDirectory: await tempProject(t)
  });
  await applyProjectSkillInstall(planB);

  // .gitignore was never created; .git/info/exclude received the managed block!
  assert.equal(await fs.access(path.join(projB, '.gitignore')).then(() => true, () => false), false);
  const excludeAfterInstall = await fs.readFile(path.join(projB, '.git/info/exclude'), 'utf8');
  assert.match(excludeAfterInstall, /\.agent-toolkit\//u);
  assert.match(excludeAfterInstall, /\.agents\/skills\/nodejs-backend-patterns/u);

  // User edits api-design-principles locally -> detach MUST refuse to delete it while removing unmodified nodejs-backend-patterns!
  await fs.appendFile(path.join(projB, '.agents/skills/api-design-principles/SKILL.md'), '\n# user note\n');
  const detachPlanB = await planToolkitDetach({
    projectRoot: projB,
    catalog,
    toolkitRoot: TOOLKIT_ROOT
  });
  assert.equal(detachPlanB.conflicts, 1);
  const detachedB = await applyToolkitDetach(detachPlanB);
  assert.equal(detachedB.removedCount, 1);
  assert.equal(detachedB.conflicts, 1);
  assert.equal(await fs.access(path.join(projB, '.agents/skills/nodejs-backend-patterns')).then(() => true, () => false), false);
  assert.match(
    await fs.readFile(path.join(projB, '.agents/skills/api-design-principles/SKILL.md'), 'utf8'),
    /# user note/u
  );

  // Case C: Global detach (--global) removes toolkit global symlinks & generated level agents, keeping user files
  const fakeHome = await tempProject(t, {
    '.claude/skills/user-global-skill/SKILL.md': '# keep',
    '.codex/agents/nivel_ligero.toml': '# Generado por `agent-toolkit-inbox agentes`. Ese comando nunca sobrescribe...\nname = "nivel_ligero"\n',
    '.codex/agents/custom_agent.toml': 'name = "custom"\n'
  });
  await fs.mkdir(path.join(fakeHome, '.agents/skills'), { recursive: true });
  await fs.symlink(
    path.join(TOOLKIT_ROOT, 'skills/mcp-builder'),
    path.join(fakeHome, '.agents/skills/mcp-builder'),
    linkType
  );

  const globalDetachPlan = await planToolkitDetach({
    includeGlobal: true,
    agent: 'all',
    catalog,
    toolkitRoot: TOOLKIT_ROOT,
    homeDirectory: fakeHome,
    codexHome: path.join(fakeHome, '.codex')
  });
  const globalDetached = await applyToolkitDetach(globalDetachPlan);
  assert.equal(globalDetached.removedCount, 2); // mcp-builder symlink + nivel_ligero.toml
  assert.equal(await fs.access(path.join(fakeHome, '.agents/skills/mcp-builder')).then(() => true, () => false), false);
  assert.equal(await fs.access(path.join(fakeHome, '.codex/agents/nivel_ligero.toml')).then(() => true, () => false), false);
  assert.equal(await fs.readFile(path.join(fakeHome, '.claude/skills/user-global-skill/SKILL.md'), 'utf8'), '# keep');
  assert.equal(await fs.readFile(path.join(fakeHome, '.codex/agents/custom_agent.toml'), 'utf8'), 'name = "custom"\n');
});

test('validated recommendations require applicable passed scenarios for every target client', async t => {
  const { inspectSkillProject, recommendSkills } = await import('../src/skill-recommendations.js');
  const data = structuredClone(await loadSkillCatalog());
  const entry = data.skills.find(skill => skill.name === 'mcp-builder');
  const root = await tempProject(t, { 'package.json': { dependencies: { '@modelcontextprotocol/sdk': '1.30.0' } } });
  const inspection = await inspectSkillProject(root, { toolkitRoot: TOOLKIT_ROOT });
  const scenario = client => ({ id: `mcp-${client}`, revision: entry.revision, profile: 'mcp', taskClass: 'mcp-development', requiredSignals: ['mcp-sdk'], client, status: 'passed', evidencePath: `docs/skills/evidencias/mcp-${client}.md` });
  entry.scenarios = [scenario('claude')];
  let report = recommendSkills({ catalog: validateSkillCatalog(data), inspection, clients: ['claude', 'codex'] });
  assert.equal(report.recommended.length, 0);
  assert.equal(report.candidates[0].recommendationStatus, 'compatible');
  assert.ok(report.candidates[0].pendingReasons.some(reason => reason.includes('codex')));
  assert.match(report.candidates[0].reasons[0], /package\.json \(@modelcontextprotocol\/sdk\)/u);
  assert.equal(recommendSkills({ catalog: validateSkillCatalog(data), inspection, clients: ['claude'] }).recommended[0].recommendationStatus, 'validated');
  entry.scenarios.push(scenario('codex'));
  report = recommendSkills({ catalog: validateSkillCatalog(data), inspection, clients: ['claude', 'codex'] });
  assert.deepEqual(report.recommended.map(skill => skill.name), ['mcp-builder']);
  assert.deepEqual(report.recommended[0].evidence.map(item => item.client), ['claude', 'codex']);
  entry.scenarios[1].status = 'failed';
  assert.equal(recommendSkills({ catalog: validateSkillCatalog(data), inspection, clients: ['claude', 'codex'] }).recommended.length, 0);
  entry.scenarios[1].status = 'passed';
  entry.review.status = 'pending';
  assert.equal(recommendSkills({ catalog: validateSkillCatalog(data), inspection, clients: ['claude', 'codex'] }).recommended.length, 0);
  assert.throws(() => recommendSkills({ catalog: validateSkillCatalog(data), inspection, clients: ['unknown'] }));
});

// ---- Project links: where they point, how they are classified and when they are touched ----

async function toolkitCopy(dir, { tamper = false } = {}) {
  const pkg = JSON.parse(await fs.readFile(path.join(TOOLKIT_ROOT, 'package.json'), 'utf8'));
  await fs.mkdir(path.join(dir, 'bin'), { recursive: true });
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'nexakit', version: pkg.version }));
  await fs.writeFile(path.join(dir, 'bin/agent-toolkit-mcp.js'), '');
  await fs.cp(path.join(TOOLKIT_ROOT, 'skills/frontend-design'), path.join(dir, 'skills/frontend-design'), { recursive: true });
  await fs.cp(path.join(TOOLKIT_ROOT, 'catalogs/skills/vercel-react-best-practices'), path.join(dir, 'catalogs/skills/vercel-react-best-practices'), { recursive: true });
  if (tamper) await fs.appendFile(path.join(dir, 'skills/frontend-design/SKILL.md'), '\nmodificado\n');
  return { dir, version: pkg.version };
}
// A stand-in for `npm install`: lays out a fake install and puts the given copy of nexakit over it.
function copyingNpm({ dir, version }) {
  const calls = [];
  const runNpm = async args => {
    calls.push(args);
    const root = await writeFakeInstall(args[args.indexOf('--prefix') + 1], { version, skills: [] });
    await fs.cp(dir, root, { recursive: true, force: true });
    return { status: 0, stderr: '' };
  };
  return Object.assign(runNpm, { calls });
}
async function projectSetup(t, extra = {}) {
  const { loadSkillCatalog: load } = await import('../src/skill-catalog.js');
  const base = await tempProject(t);
  const project = path.join(base, 'proyecto');
  const home = path.join(base, 'home');
  await fs.mkdir(project);
  await fs.mkdir(home);
  return { base, project, home, catalog: await load(), ...extra };
}
const plan = (s, overrides = {}) => import('../src/skill-recommendations.js').then(m => m.planProjectSkillInstall({
  projectRoot: s.project, skillNames: ['frontend-design', 'vercel-react-best-practices'], agent: 'all', mode: 'symlink',
  catalog: s.catalog, toolkitRoot: TOOLKIT_ROOT, homeDirectory: s.home, ...overrides
}));
const exists = file => fs.lstat(file).then(() => true, () => false);

test('project links point at the link root using each skill layout, and nothing is written by planning', async t => {
  const s = await projectSetup(t);
  const result = await plan(s, { linkRoot: path.join(s.base, 'estable') });
  assert.equal(result.ephemeral, false, 'an explicit link root means no stable copy');
  assert.equal(result.linkRoot, path.join(s.base, 'estable'));
  assert.equal(result.links.length, 4);
  const source = (client, name) => result.links.find(l => l.client === client && l.name === name).source;
  assert.equal(source('claude', 'vercel-react-best-practices'), path.join(s.base, 'estable', 'catalogs/skills/vercel-react-best-practices'));
  assert.equal(source('codex', 'frontend-design'), path.join(s.base, 'estable', 'skills/frontend-design'));
  assert.deepEqual([...new Set(result.links.map(l => `${l.state}/${l.linkState}`))], ['missing/falta']);
  assert.deepEqual(await fs.readdir(s.project), []);
  assert.deepEqual(await fs.readdir(s.home), []);
});

test('an npx run links project skills to the stable copy with relative links and records them', async t => {
  const { applyProjectSkillInstall } = await import('../src/skill-recommendations.js');
  const { readRegistry } = await import('../src/install-registry.js');
  const s = await projectSetup(t);
  const copy = await toolkitCopy(path.join(s.base, '.npm/_npx/abc/node_modules/nexakit'));
  const npm = copyingNpm(copy);
  const result = await plan(s, { toolkitRoot: copy.dir });
  assert.equal(result.ephemeral, true);
  assert.equal(result.linkRoot, path.join(s.home, '.nexakit', 'actual'));

  const applied = await applyProjectSkillInstall(result, { runNpm: npm });
  assert.equal(applied.created, 4);
  assert.equal(npm.calls.length, 1);
  const stable = await fs.realpath(path.join(s.home, '.nexakit', 'actual'));
  for (const folder of ['.agents', '.claude']) {
    const link = path.join(s.project, folder, 'skills/frontend-design');
    assert.equal(await fs.realpath(link), path.join(stable, 'skills/frontend-design'));
    if (process.platform !== 'win32') assert.equal(path.isAbsolute(await fs.readlink(link)), false, 'project links stay relative');
  }
  assert.equal(await fs.realpath(path.join(s.project, '.claude/skills/vercel-react-best-practices')), path.join(stable, 'catalogs/skills/vercel-react-best-practices'));
  assert.equal((await readRegistry(path.join(s.home, '.nexakit'))).entradas.length, 4);

  await fs.rm(path.join(s.base, '.npm'), { recursive: true });
  assert.equal(await exists(path.join(s.project, '.claude/skills/frontend-design/SKILL.md')), true, 'removing the npx cache breaks nothing');
  // A later `npx nexakit` runs from a fresh cache; the links already point at the stable copy, so nothing changes.
  const next = await toolkitCopy(path.join(s.base, '.npm/_npx/def/node_modules/nexakit'));
  const again = await plan(s, { toolkitRoot: next.dir });
  assert.deepEqual([...new Set(again.links.map(l => l.linkState))], ['instalado']);
  assert.equal((await applyProjectSkillInstall(again, { runNpm: npm })).created, 0);
  assert.equal(npm.calls.length, 1, 'a second run needs no install');
});

test('project links into another npx cache, existing or deleted, are moved', async t => {
  const { applyProjectSkillInstall } = await import('../src/skill-recommendations.js');
  const s = await projectSetup(t);
  const old = await toolkitCopy(path.join(s.base, '.npm/_npx/old/node_modules/nexakit'));
  const link = async (to, at) => { await fs.mkdir(path.dirname(at), { recursive: true }); await fs.symlink(to, at, linkType); };
  await link(path.join(old.dir, 'skills/frontend-design'), path.join(s.project, '.claude/skills/frontend-design'));
  await link(path.join(s.base, '.npm/_npx/gone/node_modules/nexakit/skills/frontend-design'), path.join(s.project, '.agents/skills/frontend-design'));
  const result = await plan(s, { skillNames: ['frontend-design'] });
  assert.deepEqual(result.links.map(l => `${l.client}:${l.linkState}`), ['codex:efimero', 'claude:efimero']);
  await applyProjectSkillInstall(result);
  for (const folder of ['.agents', '.claude']) {
    assert.equal(await fs.realpath(path.join(s.project, folder, 'skills/frontend-design')), path.join(TOOLKIT_ROOT, 'skills/frontend-design'));
  }
});

test('a project link to a development copy is left exactly as it is', async t => {
  const { applyProjectSkillInstall } = await import('../src/skill-recommendations.js');
  const s = await projectSetup(t);
  const dev = await toolkitCopy(path.join(s.base, 'dev'));
  const at = path.join(s.project, '.claude/skills/frontend-design');
  await fs.mkdir(path.dirname(at), { recursive: true });
  await fs.symlink(path.join(dev.dir, 'skills/frontend-design'), at, linkType);
  const before = await fs.readlink(at);
  const result = await plan(s, { skillNames: ['frontend-design'], agent: 'claude' });
  assert.deepEqual([result.links[0].linkState, result.links[0].state, result.links[0].root], ['otra-copia', 'installed', dev.dir]);
  const applied = await applyProjectSkillInstall(result);
  assert.equal(applied.created, 0);
  assert.equal(await fs.readlink(at), before);
  assert.deepEqual(await fs.readdir(s.home), [], 'nothing needed the install folder');
});

test('Antigravity shares the .agents folder with Codex: one project link serves both', async t => {
  const s = await projectSetup(t);
  const only = await plan(s, { agent: 'antigravity', skillNames: ['frontend-design'] });
  assert.deepEqual(only.links.map(l => [l.client, l.serves, path.relative(s.project, l.target)]),
    [['codex', ['antigravity'], path.join('.agents/skills/frontend-design')]]);
  const all = await plan(s, { agent: 'all', skillNames: ['frontend-design'] });
  assert.equal(new Set(all.links.map(l => l.target)).size, all.links.length, 'one link per folder and skill');
  assert.deepEqual(all.links.find(l => l.client === 'codex').serves, ['codex', 'antigravity']);
  assert.deepEqual(all.links.find(l => l.client === 'claude').serves, ['claude']);
  await assert.rejects(plan(s, { agent: 'gemini' }), /antigravity/u);
});

test('a broken project link listed in the project manifest is repaired; an unlisted one is left alone', async t => {
  const { applyProjectSkillInstall } = await import('../src/skill-recommendations.js');
  const s = await projectSetup(t);
  const dead = name => path.join(s.base, 'muerta', 'skills', name);
  const link = async (to, at) => { await fs.mkdir(path.dirname(at), { recursive: true }); await fs.symlink(to, at, linkType); };
  await link(dead('frontend-design'), path.join(s.project, '.claude/skills/frontend-design'));
  await link(dead('frontend-design'), path.join(s.project, '.agents/skills/frontend-design'));
  await fs.mkdir(path.join(s.project, '.agent-toolkit'));
  await fs.writeFile(path.join(s.project, '.agent-toolkit/manifest.json'), JSON.stringify({
    manifestVersion: 1, managedBy: 'nexakit', mode: 'symlink', gitIgnoreStrategy: 'gitignore', createdIgnoreFile: false,
    entries: [{ client: 'claude', name: 'frontend-design', relativePath: '.claude/skills/frontend-design', mode: 'symlink' }]
  }));
  const result = await plan(s, { skillNames: ['frontend-design'] });
  assert.deepEqual(result.links.map(l => `${l.client}:${l.linkState}`), ['codex:roto-ajeno', 'claude:roto-propio']);
  assert.equal(result.conflicts, 1);
  const applied = await applyProjectSkillInstall(result);
  assert.equal(applied.created, 1);
  assert.equal(await fs.realpath(path.join(s.project, '.claude/skills/frontend-design')), path.join(TOOLKIT_ROOT, 'skills/frontend-design'));
  assert.equal(await fs.readlink(path.join(s.project, '.agents/skills/frontend-design')), dead('frontend-design'));
});

test('a link that changes between the plan and the apply is not touched', async t => {
  const { applyProjectSkillInstall } = await import('../src/skill-recommendations.js');
  const s = await projectSetup(t);
  const at = path.join(s.project, '.claude/skills/frontend-design');
  await fs.mkdir(path.dirname(at), { recursive: true });
  await fs.symlink(path.join(s.base, 'muerta/skills/frontend-design'), at, linkType);
  await fs.mkdir(path.join(s.project, '.agent-toolkit'));
  await fs.writeFile(path.join(s.project, '.agent-toolkit/manifest.json'), JSON.stringify({
    manifestVersion: 1, managedBy: 'nexakit', mode: 'symlink', gitIgnoreStrategy: 'gitignore', createdIgnoreFile: false,
    entries: [{ client: 'claude', name: 'frontend-design', relativePath: '.claude/skills/frontend-design', mode: 'symlink' }]
  }));
  const result = await plan(s, { skillNames: ['frontend-design'], agent: 'claude' });
  await fs.rm(at);
  await fs.symlink(path.join(s.base, 'otra'), at, linkType);
  const applied = await applyProjectSkillInstall(result);
  assert.deepEqual([applied.created, applied.conflicts, applied.links[0].changed], [0, 1, true]);
  assert.equal(await fs.readlink(at), path.join(s.base, 'otra'));
});

test('hashes are checked again where the links will point, and a mismatch links nothing', async t => {
  const { applyProjectSkillInstall } = await import('../src/skill-recommendations.js');
  const s = await projectSetup(t);
  const tampered = await toolkitCopy(path.join(s.base, 'copia-modificada'), { tamper: true });
  const result = await plan(s, { skillNames: ['frontend-design'], linkRoot: tampered.dir });
  await assert.rejects(applyProjectSkillInstall(result), /SHA-256/u);
  assert.equal(await exists(path.join(s.project, '.agents')), false);
  assert.equal(await exists(path.join(s.project, '.claude')), false);
});

test('detach recognizes project and global links into the stable copy, for Antigravity too', async t => {
  const { applyProjectSkillInstall, planToolkitDetach } = await import('../src/skill-recommendations.js');
  const s = await projectSetup(t);
  const copy = await toolkitCopy(path.join(s.base, '.npm/_npx/abc/node_modules/nexakit'));
  await applyProjectSkillInstall(await plan(s, { toolkitRoot: copy.dir }), { runNpm: copyingNpm(copy) });
  const globalLink = path.join(s.home, '.gemini/antigravity-cli/skills/frontend-design');
  await fs.mkdir(path.dirname(globalLink), { recursive: true });
  await fs.symlink(path.join(s.home, '.nexakit/actual/skills/frontend-design'), globalLink, linkType);

  const detach = agent => planToolkitDetach({ projectRoot: s.project, includeGlobal: true, agent, toolkitRoot: TOOLKIT_ROOT, homeDirectory: s.home, catalog: s.catalog });
  const antigravity = await detach('antigravity');
  assert.deepEqual(antigravity.items.map(i => `${i.scope}:${i.client}:${i.action}`).sort(), [
    'global:antigravity:remove-global-link', 'project:codex:remove-link', 'project:codex:remove-link'
  ]);
  assert.equal(antigravity.conflicts, 0);
  const claude = await detach('claude');
  assert.deepEqual(claude.items.map(i => `${i.scope}:${i.client}:${i.action}`), ['project:claude:remove-link', 'project:claude:remove-link']);
  await assert.rejects(detach('gemini'), /antigravity/u);
});

test('a manifest entry proves ownership only of the exact link it recorded', async t => {
  const { applyProjectSkillInstall } = await import('../src/skill-recommendations.js');
  const s = await projectSetup(t);
  await applyProjectSkillInstall(await plan(s, { skillNames: ['frontend-design'], agent: 'claude' }));
  const manifest = JSON.parse(await fs.readFile(path.join(s.project, '.agent-toolkit/manifest.json'), 'utf8'));
  const at = path.join(s.project, '.claude/skills/frontend-design');
  assert.equal(manifest.entries[0].apunta, await fs.readlink(at), 'the manifest records where the link pointed');

  // Someone replaces nexakit's link with a broken one of their own: it is not nexakit's any more.
  await fs.rm(at);
  await fs.symlink(path.join(s.base, 'mio/skills/frontend-design'), at, linkType);
  await fs.rm(path.join(s.home, '.nexakit'), { recursive: true, force: true });
  const replaced = await plan(s, { skillNames: ['frontend-design'], agent: 'claude' });
  assert.equal(replaced.links[0].linkState, 'roto-ajeno');
  await applyProjectSkillInstall(replaced);
  assert.equal(await fs.readlink(at), path.join(s.base, 'mio/skills/frontend-design'));

  // An entry from 0.1.0 has no recorded link: then only a link with nexakit's own shape counts as nexakit's.
  await fs.writeFile(path.join(s.project, '.agent-toolkit/manifest.json'), JSON.stringify({ ...manifest, entries: [{ client: 'claude', name: 'frontend-design', relativePath: '.claude/skills/frontend-design', mode: 'symlink' }] }));
  await fs.rm(at);
  await fs.symlink(path.join(s.base, 'mio/otra-cosa'), at, linkType);
  assert.equal((await plan(s, { skillNames: ['frontend-design'], agent: 'claude' })).links[0].linkState, 'roto-ajeno');
});

test('copy mode replaces a link only when it is nexakit\'s, and never a link of the user', async t => {
  const { applyProjectSkillInstall } = await import('../src/skill-recommendations.js');
  const s = await projectSetup(t);
  const mine = path.join(s.base, 'mi-skill');
  await fs.mkdir(mine);
  await fs.writeFile(path.join(mine, 'SKILL.md'), 'mía');
  const userLink = path.join(s.project, '.claude/skills/frontend-design');
  await fs.mkdir(path.dirname(userLink), { recursive: true });
  await fs.symlink(mine, userLink, linkType);
  const ourLink = path.join(s.project, '.agents/skills/frontend-design');
  await fs.mkdir(path.dirname(ourLink), { recursive: true });
  await fs.symlink(path.join(TOOLKIT_ROOT, 'skills/frontend-design'), ourLink, linkType);

  const result = await plan(s, { skillNames: ['frontend-design'], mode: 'copy' });
  assert.deepEqual(result.links.map(l => `${l.client}:${l.state}`), ['codex:replace', 'claude:conflict']);
  const applied = await applyProjectSkillInstall(result);
  assert.equal(applied.created, 1);
  assert.equal(await fs.readlink(userLink), mine, 'the user\'s link is untouched');
  assert.equal(await fs.readFile(path.join(mine, 'SKILL.md'), 'utf8'), 'mía');
  const copied = await fs.lstat(ourLink);
  assert.equal(copied.isDirectory() && !copied.isSymbolicLink(), true, 'nexakit\'s link became a verified copy');
});

test('an apply that writes anything takes the lock; one with nothing to write touches nothing', async t => {
  const { applyProjectSkillInstall } = await import('../src/skill-recommendations.js');
  const { acquireLock } = await import('../src/install-lock.js');
  const s = await projectSetup(t);
  let acquired = 0;
  const acquire = (...args) => { acquired++; return acquireLock(...args); };
  await applyProjectSkillInstall(await plan(s, { skillNames: ['frontend-design'], mode: 'copy' }), { acquire });
  assert.equal(acquired, 1, 'copy mode writes copies and metadata under the lock');

  const t2 = await projectSetup(t);
  await applyProjectSkillInstall(await plan(t2, { skillNames: ['frontend-design'] }), { acquire });
  assert.equal(acquired, 2);
  const manifest = path.join(t2.project, '.agent-toolkit/manifest.json');
  const before = await fs.stat(manifest);
  await applyProjectSkillInstall(await plan(t2, { skillNames: ['frontend-design'] }), { acquire });
  assert.equal(acquired, 2, 'nothing to write: no lock');
  assert.equal((await fs.stat(manifest)).mtimeMs, before.mtimeMs, 'and the manifest is not rewritten');
  await applyProjectSkillInstall(await plan(t2, { skillNames: ['frontend-design'], gitIgnore: 'git-exclude' }), { acquire });
  assert.equal(acquired, 3, 'a changed setting is a write too');
});

test('a project apply checks it still holds the lock right before each write', async t => {
  const { applyProjectSkillInstall } = await import('../src/skill-recommendations.js');
  const s = await projectSetup(t);
  let checks = 0;
  // Two checks per link: before creating its folder and before writing it. The third one is lost.
  const acquire = async () => ({ release: async () => {}, assertHeld: async () => { if (++checks > 2) throw Object.assign(new Error('perdido'), { code: 'perdido' }); } });
  await assert.rejects(applyProjectSkillInstall(await plan(s, { skillNames: ['frontend-design'] }), { acquire }), { code: 'perdido' });
  const made = [];
  for (const folder of ['.agents', '.claude']) if (await exists(path.join(s.project, folder, 'skills/frontend-design'))) made.push(folder);
  assert.deepEqual(made, ['.agents'], 'only the first link, written while the lock was held');
});

test('a copy and the project metadata stop writing as soon as the lock is lost', async t => {
  const { applyProjectSkillInstall } = await import('../src/skill-recommendations.js');
  const losing = keep => async () => {
    let checks = 0;
    return { release: async () => {}, assertHeld: async () => { if (++checks > keep) throw Object.assign(new Error('perdido'), { code: 'perdido' }); } };
  };
  // Copy mode: the lock holds for the parent folders and the copy folder, then is lost before the first file.
  const s = await projectSetup(t);
  await assert.rejects(applyProjectSkillInstall(await plan(s, { skillNames: ['vercel-react-best-practices'], agent: 'claude', mode: 'copy' }), { acquire: losing(2) }), { code: 'perdido' });
  const target = path.join(s.project, '.claude/skills/vercel-react-best-practices');
  const files = await fs.readdir(target, { recursive: true }).catch(() => []);
  assert.deepEqual(files.filter(name => name.includes('.')), [], 'no file of the copy was written after the lock was lost');

  // Link mode: the link is written while the lock holds; the metadata is not once it is lost.
  const l = await projectSetup(t);
  await assert.rejects(applyProjectSkillInstall(await plan(l, { skillNames: ['frontend-design'], agent: 'claude' }), { acquire: losing(2) }), { code: 'perdido' });
  assert.equal(await exists(path.join(l.project, '.claude/skills/frontend-design')), true);
  assert.equal(await exists(path.join(l.project, '.agent-toolkit')), false, 'the metadata folder is not created without the lock');
});

test('the catalog knows the new signals and api-design-principles uses the Python and REST ones', async () => {
  const catalog = await loadSkillCatalog();
  const api = catalog.skills.find(s => s.name === 'api-design-principles');
  assert.deepEqual(api.matching.anySignals, ['express', 'fastify', 'hono', 'django', 'fastapi', 'flask', 'rest-api']);
  const schema = JSON.parse(await fs.readFile(new URL('../schemas/skill-catalog.schema.json', import.meta.url), 'utf8'));
  for (const id of ['django', 'fastapi', 'flask', 'tauri', 'python', 'rust', 'rest-api']) assert.ok(schema.$defs.signal.enum.includes(id), id);
  const { SIGNAL_LABELS } = await import('../src/skill-recommendations.js');
  assert.equal(SIGNAL_LABELS['rest-api'], 'API REST');
  assert.equal(SIGNAL_LABELS.django, 'Django');
  assert.equal(catalog.skills.find(s => s.name === 'nodejs-backend-patterns').matching.anySignals.join(), 'express,fastify,hono');
});
