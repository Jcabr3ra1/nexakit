import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createFakeClis } from '../test-support/fake-clis.js';

const TOOLKIT_ROOT = fileURLToPath(new URL('../', import.meta.url));
const exists = file => fs.access(file).then(() => true, () => false);

async function createSandboxEnv(t, projectPkg = { name: 'ui-demo', dependencies: { react: '19.0.0', next: '15.0.0' } }) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'toolkit-tui-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const homeDirectory = path.join(root, 'home');
  const codexHome = path.join(homeDirectory, '.codex');
  const projectRoot = path.join(root, 'project');
  const toolkitMini = path.join(root, 'toolkit');

  await fs.mkdir(homeDirectory, { recursive: true });
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.writeFile(path.join(projectRoot, 'package.json'), JSON.stringify(projectPkg, null, 2));

  // Copy all 10 cataloged skills into toolkitMini preserving their installedPath (skills/ and catalogs/skills/)
  const catalogJson = JSON.parse(await fs.readFile(path.join(TOOLKIT_ROOT, 'catalogs/skills.json'), 'utf8'));
  await fs.mkdir(path.join(toolkitMini, 'catalogs'), { recursive: true });
  await fs.writeFile(path.join(toolkitMini, 'catalogs/skills.json'), JSON.stringify(catalogJson, null, 2));
  for (const entry of catalogJson.skills) {
    await fs.cp(path.join(TOOLKIT_ROOT, entry.installedPath), path.join(toolkitMini, entry.installedPath), { recursive: true });
  }
  await fs.writeFile(path.join(toolkitMini, 'package.json'), await fs.readFile(path.join(TOOLKIT_ROOT, 'package.json'), 'utf8'));

  return { root, homeDirectory, codexHome, projectRoot, toolkitRoot: toolkitMini };
}

test('recommend and detach (--apply / --json) keep their output and exit codes', async t => {
  const env = await createSandboxEnv(t);
  const { runToolkitCli } = await import('../src/toolkit-cli.js');
  const { planProjectSkillInstall, applyProjectSkillInstall } = await import('../src/skill-recommendations.js');
  const { loadSkillCatalog } = await import('../src/skill-catalog.js');

  let jsonOut = '';
  const codeJson = await runToolkitCli(['recommend', '--project', env.projectRoot, '--dry-run', '--json'], {
    out: text => { jsonOut += text; },
    err: () => {},
    options: { toolkitRoot: env.toolkitRoot }
  });
  assert.equal(codeJson, 0);
  const parsed = JSON.parse(jsonOut);
  assert.deepEqual(parsed.signals.map(s => s.id).sort(), ['nextjs', 'nodejs', 'react']);
  assert.deepEqual(
    parsed.candidates.map(c => c.name).sort(),
    ['frontend-design', 'vercel-composition-patterns', 'vercel-react-best-practices', 'web-design-guidelines']
  );
  assert.equal(parsed.optional.some(o => o.name === 'differential-review'), true);

  let textOut = '';
  const codeText = await runToolkitCli(['recommend', '--project', env.projectRoot], {
    out: text => { textOut += text; },
    err: () => {},
    options: { toolkitRoot: env.toolkitRoot }
  });
  assert.equal(codeText, 0);
  assert.match(textOut, /vercel-react-best-practices/u);
  assert.match(textOut, /Opcionales disponibles/u);

  // Couple 1 skill into env.projectRoot, then test CLI detach preview + detach --apply --json!
  const catalog = await loadSkillCatalog();
  const installPlan = await planProjectSkillInstall({
    projectRoot: env.projectRoot,
    skillNames: ['vercel-react-best-practices'],
    agent: 'codex',
    mode: 'symlink',
    gitIgnore: 'gitignore',
    catalog,
    toolkitRoot: env.toolkitRoot,
    homeDirectory: env.homeDirectory
  });
  await applyProjectSkillInstall(installPlan);

  let detachPreviewOut = '';
  const codeDetachPreview = await runToolkitCli(['detach', '--project', env.projectRoot], {
    out: text => { detachPreviewOut += text; },
    err: () => {},
    options: { toolkitRoot: env.toolkitRoot }
  });
  assert.equal(codeDetachPreview, 0);
  assert.match(detachPreviewOut, /Vista previa de desacoplado/u);
  assert.equal(await fs.access(path.join(env.projectRoot, '.agent-toolkit/manifest.json')).then(() => true, () => false), true);

  let detachApplyJson = '';
  const codeDetachApply = await runToolkitCli(['detach', '--project', env.projectRoot, '--apply', '--json'], {
    out: text => { detachApplyJson += text; },
    err: () => {},
    options: { toolkitRoot: env.toolkitRoot }
  });
  assert.equal(codeDetachApply, 0);
  const detachParsed = JSON.parse(detachApplyJson);
  assert.equal(detachParsed.applied, true);
  assert.equal(detachParsed.removedCount, 1);
  assert.equal(detachParsed.stateDirRemoved, true);
  assert.equal(await fs.access(path.join(env.projectRoot, '.agent-toolkit')).then(() => true, () => false), false);

  assert.equal(await runToolkitCli(['recommend', '--profile', 'invalid'], { out: () => {}, err: () => {} }), 2);
  assert.equal(await runToolkitCli(['recommend', '--json', '--json'], { out: () => {}, err: () => {} }), 2);
});


async function world(t, { git = true } = {}) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'toolkit-cli-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const home = path.join(base, 'home'), repo = path.join(base, 'Punto_Motos'), bin = path.join(base, 'bin');
  await fs.mkdir(home);
  await fs.mkdir(path.join(repo, 'frontend'), { recursive: true });
  await fs.writeFile(path.join(repo, 'frontend', 'README.md'), 'Interfaz en React.\n');
  if (git) execFileSync('git', ['init', '-q', repo]);
  const clis = createFakeClis(home);
  clis.installBin(bin);
  return { base, home, repo, clis, options: { homeDirectory: home, environment: { PATH: bin, HOME: home }, toolkitRoot: TOOLKIT_ROOT, runCommand: clis.runCommand } };
}
const capture = () => { const io = { out: '', err: '' }; return { io, out: text => { io.out += text; }, err: text => { io.err += text; } }; };

test('without a terminal it prints the plan and exits 2 without writing', async t => {
  const w = await world(t);
  const { runToolkitCli } = await import('../src/toolkit-cli.js');
  const c = capture();
  const code = await runToolkitCli(['--project', path.join(w.repo, 'frontend')], { ...c, isTTY: false, options: w.options });
  assert.equal(code, 2);
  assert.match(c.io.out, /^nexakit · Punto Motos \(repositorio completo\)$/mu);
  assert.match(c.io.out, /^  \+ Memoria nueva en ~[\\/]nexakit-memorias[\\/]punto-motos$/mu);
  assert.match(c.io.out, /npx nexakit --si/u);
  assert.deepEqual(await fs.readdir(w.home), [], 'nothing written in the home');
  assert.equal(await exists(path.join(w.repo, '.agent-toolkit')), false);
});

test('--si applies the suggested answers, and then everything is ready', async t => {
  const w = await world(t);
  const { runToolkitCli } = await import('../src/toolkit-cli.js');
  const c = capture();
  const code = await runToolkitCli(['--si', '--project', w.repo], { ...c, isTTY: false, options: w.options });
  assert.equal(code, 0, c.io.err);
  assert.match(c.io.out, /◇ Memoria creada/u);
  assert.match(c.io.out, /Comprobación final: todo responde/u);
  assert.equal(c.io.out.match(/Comprobación final/gu).length, 1, 'the final check is printed once');
  assert.equal(await exists(path.join(w.home, 'nexakit-memorias', 'punto-motos', 'project-memory.json')), true);
  const again = capture();
  assert.equal(await runToolkitCli(['--project', w.repo], { ...again, isTTY: false, options: w.options }), 0);
  assert.match(again.io.out, /Todo está listo/u);
});

test('--si in a project without Git does not create a memory', async t => {
  const w = await world(t, { git: false });
  const { runToolkitCli } = await import('../src/toolkit-cli.js');
  const c = capture();
  assert.equal(await runToolkitCli(['--si', '--project', w.repo], { ...c, isTTY: false, options: w.options }), 0, c.io.err);
  assert.equal(await exists(path.join(w.home, 'nexakit-memorias')), false);
  assert.doesNotMatch(c.io.out, /Memoria/u);
});

test('quitar behaves like detach and also accepts --si', async t => {
  const w = await world(t);
  const { runToolkitCli } = await import('../src/toolkit-cli.js');
  assert.equal(await runToolkitCli(['--si', '--project', w.repo], { ...capture(), isTTY: false, options: w.options }), 0);
  const c = capture();
  assert.equal(await runToolkitCli(['quitar', '--project', w.repo, '--apply', '--json'], { ...c, options: w.options }), 0);
  assert.equal(JSON.parse(c.io.out).applied, true);
  assert.equal(await exists(path.join(w.repo, '.claude/skills/frontend-design')), false);

  assert.equal(await runToolkitCli(['--si', '--project', w.repo], { ...capture(), isTTY: false, options: w.options }), 0);
  assert.equal(await exists(path.join(w.repo, '.claude/skills/frontend-design')), true);
  const si = capture();
  assert.equal(await runToolkitCli(['quitar', '--project', w.repo, '--si', '--json'], { ...si, options: w.options }), 0);
  assert.equal(JSON.parse(si.io.out).applied, true);
  assert.equal(await exists(path.join(w.repo, '.claude/skills/frontend-design')), false);
});

test('comprobar prints a readable Spanish report with obsolete and legacy warnings, supports --json, and keeps doctor unchanged', async t => {
  const w = await world(t);
  const { runToolkitCli } = await import('../src/toolkit-cli.js');
  assert.equal(await runToolkitCli(['--si', '--project', w.repo], { ...capture(), isTTY: false, options: w.options }), 0);

  // Fresh install without old workflow MCP exits 0 with comprobar, while legacy doctor keeps its JSON contract.
  const ok = capture();
  assert.equal(await runToolkitCli(['comprobar'], { ...ok, options: w.options }), 0, ok.io.err);
  assert.match(ok.io.out, /✓ Node\.js/u);
  assert.match(ok.io.out, /✓ Skills base listas/u);

  const json = capture();
  assert.equal(await runToolkitCli(['comprobar', '--json'], { ...json, options: w.options }), 0);
  assert.equal(JSON.parse(json.io.out).node.supported, true);

  const doc = capture();
  const docCode = await runToolkitCli(['doctor'], { ...doc, options: w.options });
  assert.equal(docCode, 1, 'legacy doctor still checks the legacy workflow MCP');
  assert.equal(JSON.parse(doc.io.out).node.supported, true);

  // Add obsolete workflow MCP, obsolete level agent, and a group of 3 old broken links.
  await fs.writeFile(
    path.join(w.home, '.claude.json'),
    JSON.stringify({
      mcpServers: {
        'agent-toolkit-workflow': {
          command: 'node',
          args: [path.join(TOOLKIT_ROOT, 'bin/agent-toolkit-mcp.js')],
        },
      },
    }),
  );
  await fs.mkdir(path.join(w.home, '.codex/agents'), { recursive: true });
  await fs.writeFile(path.join(w.home, '.codex/agents/nivel-normal.toml'), 'model = "gpt-6.1-sol"\n');
  const deadRoot = path.join(w.home, 'viejo-toolkit');
  for (const skill of ['depurar', 'revisar', 'quality-gate']) {
    const link = path.join(w.home, '.claude/skills', skill);
    await fs.rm(link, { force: true });
    await fs.symlink(path.join(deadRoot, 'skills', skill), link);
  }

  const warn = capture();
  assert.equal(await runToolkitCli(['comprobar'], { ...warn, options: w.options }), 1);
  assert.match(warn.io.out, /! Ya no se usa; si quieres quitarlo: claude mcp remove agent-toolkit-workflow -s user/u);
  assert.match(warn.io.out, /! Ya no se usa; si quieres quitarlo: .*nivel-normal\.toml/u);
  assert.match(warn.io.out, /npx nexakit reparar --desde ~[\\/]viejo-toolkit/u);
});

test('memoria forwards subcommands and arguments untouched to project-memory', async t => {
  const w = await world(t);
  const { runToolkitCli } = await import('../src/toolkit-cli.js');
  assert.equal(await runToolkitCli(['--si', '--project', w.repo], { ...capture(), isTTY: false, options: w.options }), 0);
  const vault = path.join(w.home, 'nexakit-memorias', 'punto-motos');

  const help = capture();
  assert.equal(await runToolkitCli(['memoria', '--help'], { ...help, options: w.options }), 0);
  assert.match(help.io.out, /project-memory/u);

  const doc = capture();
  assert.equal(await runToolkitCli(['memoria', 'doctor', vault, '--strict'], { ...doc, options: w.options }), 0);
  assert.match(doc.io.out, /Project Memory Doctor: OK/u);

  const status = capture();
  assert.equal(await runToolkitCli(['memoria', 'status', vault, '--json'], { ...status, options: w.options }), 0);
  assert.equal(JSON.parse(status.io.out).project.id, 'punto-motos');
});

test('--help lists all Spanish subcommands and guide includes Antigravity and new commands', async () => {
  const { runToolkitCli } = await import('../src/toolkit-cli.js');
  const { getToolkitCommandsGuide } = await import('../src/toolkit-commands-guide.js');
  const c = capture();
  assert.equal(await runToolkitCli(['--help'], { ...c }), 0);
  for (const sub of ['comprobar', 'quitar', 'reparar --desde', 'memoria', 'revision', 'modelo']) {
    assert.match(c.io.out, new RegExp(sub, 'u'));
  }
  const guide = getToolkitCommandsGuide({ clients: { claude: { available: true }, codex: { available: true }, antigravity: { available: true } } });
  assert.equal(guide.antigravityActive, true);
  assert.equal(guide.cliCommands.some(item => item.command.includes('comprobar')), true);
  assert.equal(guide.cliCommands.some(item => item.command.includes('memoria')), true);
});

test('unknown flags show the help and exit 2', async () => {
  const { runToolkitCli } = await import('../src/toolkit-cli.js');
  const c = capture();
  assert.equal(await runToolkitCli(['--agent', 'codex'], { ...c, isTTY: false }), 2);
  assert.match(c.io.err, /npx nexakit \[--project <ruta>\] \[--si\]/u);
});
