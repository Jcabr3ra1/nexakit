import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { test } from 'node:test';

const TOOLKIT_ROOT = fileURLToPath(new URL('../', import.meta.url));

test('terminal assertions match visible labels while retaining raw color output', async () => {
  const tty = createFakeTty();
  tty.output.write('\x1b[2J\x1b[H\x1b[1m[Enter / s]\x1b[22m confirmar e instalar');
  assert.equal(tty.getFrame(), '[Enter / s] confirmar e instalar');
  assert.match(tty.getOutput(), /\x1b\[1m/u);
  await tty.waitFor(/\[Enter \/ s\] confirmar e instalar/u);
  const nextFrame = tty.waitFor(/Skills opcionales/u);
  tty.output.write('\x1b[2J\x1b[H\x1b[35mSkills opcionales\x1b[39m');
  await nextFrame;
  assert.equal(tty.getFrame(), 'Skills opcionales');
});

function createFakeTty({ columns = 100 } = {}) {
  const input = new EventEmitter();
  input.isTTY = true;
  input.rawMode = false;
  input.resumed = false;
  input.setRawMode = mode => { input.rawMode = Boolean(mode); };
  input.resume = () => { input.resumed = true; };
  input.pause = () => { input.resumed = false; };

  let buffer = '';
  let frame = '';
  const waiters = [];
  const output = new EventEmitter();
  output.isTTY = true;
  output.columns = columns;
  output.write = chunk => {
    buffer += String(chunk);
    frame = String(chunk).includes('\x1b[2J\x1b[H')
      ? stripVTControlCharacters(String(chunk).split('\x1b[2J\x1b[H').at(-1))
      : frame + stripVTControlCharacters(String(chunk));
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].regex.test(frame)) {
        const w = waiters.splice(i, 1)[0];
        w.resolve();
      }
    }
    return true;
  };
  return {
    input,
    output,
    getOutput: () => buffer,
    getFrame: () => frame,
    sendKey: seq => input.emit('data', Buffer.from(seq, 'utf8')),
    waitFor: regex => (regex.test(frame)
      ? Promise.resolve()
      : new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${regex}`)), 4000);
          waiters.push({ regex, resolve: () => { clearTimeout(timer); resolve(); } });
        }))
  };
}

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

test('wizard starts with project skills, then optionals, then review with installation settings', async t => {
  const env = await createSandboxEnv(t);
  const { buildToolkitTuiSnapshot, createToolkitTuiModel, renderToolkitTuiFrame, computeInstallPreview } = await import('../src/toolkit-tui.js');
  const setupOptions = { homeDirectory: env.homeDirectory, codexHome: env.codexHome, toolkitRoot: env.toolkitRoot, environment: { PATH: '' } };
  const model = createToolkitTuiModel(await buildToolkitTuiSnapshot({ projectRoot: env.projectRoot, setupOptions }));
  const readable = frame => frame.replace(/[│\n]/gu, ' ').replace(/\s+/gu, ' ');
  const first = renderToolkitTuiFrame(model, { columns: 100, color: false });
  assert.equal(model.step, 1);
  assert.match(first, /Paso 1 de 3/u);
  assert.match(first, /vercel-react-best-practices/u);
  assert.match(first, /Next\.js/u);
  assert.doesNotMatch(first, /Configuración de instalación|differential-review/u);
  assert.equal(model.fundamentalItems.every(item => !item.checked), true);
  assert.match(readable(first), /Por qué:.*package\.json/u);
  assert.match(readable(first), /Compatible/u);
  assert.match(readable(first), /Utilidad prevista:/u);
  assert.doesNotMatch(first, /Recomendada/u);

  model.step = 2;
  const optional = renderToolkitTuiFrame(model, { columns: 100, color: false });
  assert.match(optional, /Paso 2 de 3/u);
  assert.match(optional, /differential-review/u);
  assert.match(optional, /obra\/superpowers/u);
  assert.equal(model.optionalItems.every(item => !item.checked), true);
  assert.ok(readable(optional).includes(model.optionalItems[0].summary));
  model.cursors[2] = 1;
  assert.ok(readable(renderToolkitTuiFrame(model, { columns: 100, color: false })).includes(model.optionalItems[1].summary));

  model.fundamentalItems[0].checked = true; // an explicit user choice
  model.step = 3;
  model.previewData = await computeInstallPreview(model, setupOptions);
  const review = renderToolkitTuiFrame(model, { columns: 100, color: false });
  assert.match(review, /Paso 3 de 3/u);
  assert.match(review, /Configuración de instalación/u);
  assert.match(review, /Enlace simbólico/u);
  assert.match(review, /frontend-design/u);
  assert.match(review, /\[e\]/u);

  model.showCommands = true;
  const commands = renderToolkitTuiFrame(model, { columns: 68, color: false });
  assert.match(commands, /\/programar/u);
  assert.match(commands, /\$revisar/u);
});

test('installed skills are identified in the first step and are not selected again by default', async t => {
  const env = await createSandboxEnv(t, { name: 'mcp-demo', dependencies: { '@modelcontextprotocol/sdk': '1.30.0' } });
  const { buildToolkitTuiSnapshot, createToolkitTuiModel, renderToolkitTuiFrame } = await import('../src/toolkit-tui.js');
  const { planProjectSkillInstall, applyProjectSkillInstall } = await import('../src/skill-recommendations.js');
  const setupOptions = { homeDirectory: env.homeDirectory, codexHome: env.codexHome, toolkitRoot: env.toolkitRoot, environment: { PATH: '' } };
  const snapshot = await buildToolkitTuiSnapshot({ projectRoot: env.projectRoot, setupOptions });
  await applyProjectSkillInstall(await planProjectSkillInstall({ projectRoot: env.projectRoot, skillNames: ['mcp-builder'], agent: 'all', mode: 'symlink', catalog: snapshot.catalog, toolkitRoot: env.toolkitRoot, homeDirectory: env.homeDirectory }));
  const model = createToolkitTuiModel(await buildToolkitTuiSnapshot({ projectRoot: env.projectRoot, setupOptions }));
  const frame = renderToolkitTuiFrame(model, { columns: 100, color: false });
  assert.match(frame, /\[ \] mcp-builder · ya instalada/u);
  assert.equal(model.fundamentalItems.find(item => item.skillName === 'mcp-builder').checked, false);
});

test('only proven target scenarios are preselected; manual choices survive a target change', async t => {
  const env = await createSandboxEnv(t, { name: 'mcp-demo', dependencies: { '@modelcontextprotocol/sdk': '1.30.0' } });
  const { buildToolkitTuiSnapshot, createToolkitTuiModel, runToolkitTui } = await import('../src/toolkit-tui.js');
  const setupOptions = { homeDirectory: env.homeDirectory, codexHome: env.codexHome, toolkitRoot: env.toolkitRoot, environment: { PATH: '' } };
  const catalogPath = path.join(env.toolkitRoot, 'catalogs/skills.json');
  const catalog = JSON.parse(await fs.readFile(catalogPath, 'utf8'));
  const skill = catalog.skills.find(entry => entry.name === 'mcp-builder');
  skill.scenarios = [{ id: 'synthetic-mcp-claude', revision: skill.revision, profile: 'mcp', taskClass: 'mcp-development', requiredSignals: ['mcp-sdk'], client: 'claude', status: 'passed', evidencePath: 'docs/skills/evidencias/synthetic.md' }];
  await fs.mkdir(path.join(env.toolkitRoot, 'docs/skills/evidencias'), { recursive: true });
  await fs.writeFile(path.join(env.toolkitRoot, skill.scenarios[0].evidencePath), 'Synthetic fixture to test recommendation gating; not a real skill evaluation.');
  await fs.writeFile(catalogPath, JSON.stringify(catalog));
  const both = createToolkitTuiModel(await buildToolkitTuiSnapshot({ projectRoot: env.projectRoot, setupOptions }));
  assert.equal(both.fundamentalItems[0].checked, false);
  const claude = createToolkitTuiModel(await buildToolkitTuiSnapshot({ projectRoot: env.projectRoot, agent: 'claude', setupOptions }));
  assert.equal(claude.fundamentalItems[0].checked, true);
  assert.equal(claude.fundamentalItems[0].recommendationStatus, 'validated');
  for (const manual of [false, true]) {
    const tty = createFakeTty();
    const running = runToolkitTui({ input: tty.input, output: tty.output, projectRoot: env.projectRoot, agent: 'claude', setupOptions });
    t.after(() => tty.sendKey('\x03'));
    await tty.waitFor(/Paso 1 de 3/u);
    if (manual) { tty.sendKey(' '); tty.sendKey(' '); }
    tty.sendKey('\r');
    await tty.waitFor(/Paso 2 de 3/u);
    tty.sendKey('\r');
    await tty.waitFor(/Paso 3 de 3/u);
    tty.sendKey('e');
    await tty.waitFor(/Editar configuración/u);
    tty.sendKey(' '); // Claude -> Codex, which has no passed scenario
    await tty.waitFor(/Solo Codex/u);
    tty.sendKey('\r');
    await tty.waitFor(/\[Enter \/ s\] confirmar e instalar/u);
    assert.match(tty.getFrame(), manual ? /Skills seleccionadas \(1\)/u : /Skills seleccionadas \(0\)/u);
    tty.sendKey('q');
    assert.equal(await running, 0);
  }
});

test('frames fit narrow terminals without losing commands or changing the model', async t => {
  const env = await createSandboxEnv(t);
  const { buildToolkitTuiSnapshot, createToolkitTuiModel, renderToolkitTuiFrame } = await import('../src/toolkit-tui.js');
  const snapshot = await buildToolkitTuiSnapshot({
    projectRoot: env.projectRoot,
    setupOptions: { homeDirectory: env.homeDirectory, codexHome: env.codexHome, toolkitRoot: env.toolkitRoot, environment: { PATH: '' } }
  });
  const model = createToolkitTuiModel(snapshot);
  model.statusMessage = 'Un mensaje largo que debe seguir siendo legible en una terminal estrecha sin desbordar el marco.';
  model.previewData = { verifiedSkillsCount: 1, actions: [{ kind: 'conflict', label: 'Archivo propio respetado en una ruta muy larga del proyecto' }], conflictsCount: 1, manualCommands: ['npx example --project /una/ruta/muy/larga/que/no/debe/desaparecer'] };
  model.detachPlan = { items: [{ action: 'conflict', relativePath: 'archivo-propio', reason: 'Se conserva sin cambios' }], gitIgnoreUpdates: [] };
  model.resultData = { projectLinksCreated: 1, conflicts: 1, removedCount: 1, gitIgnoreCleanedCount: 1 };
  for (const columns of [40, 68, 100]) {
    for (const step of [1, 2, 3, 'done', 'detach-preview', 'detached']) {
      model.step = step;
      const before = structuredClone(model);
      const plain = renderToolkitTuiFrame(model, { columns, color: false });
      const colored = renderToolkitTuiFrame(model, { columns, color: true });
      assert.deepEqual(model, before, 'rendering must be read-only');
      assert.equal(colored.replace(/\x1b\[[0-9;]*m/gu, ''), plain);
      for (const line of plain.trimEnd().split('\n')) {
        assert.ok(Array.from(line).length <= columns, `${step} at ${columns} columns: ${line}`);
      }
    }
    model.step = 3;
    model.configDraft = { ...model.config, installMode: 'copy' };
    for (const cursor of [0, 1, 2, 3]) {
      model.configCursor = cursor;
      const editor = renderToolkitTuiFrame(model, { columns, color: false });
      for (const line of editor.trimEnd().split('\n')) assert.ok(Array.from(line).length <= columns);
    }
    model.configDraft = null;
    model.showCommands = true;
    const commands = renderToolkitTuiFrame(model, { columns, color: false });
    for (const line of commands.trimEnd().split('\n')) assert.ok(Array.from(line).length <= columns);
    // Wrapping may split a long command, but must never truncate it.
    assert.ok(commands.replace(/[│\s]/gu, '').includes('npxnexakit'));
    model.showCommands = false;
  }
});

test('step-by-step wizard supports back navigation, zero-write cancel in final review, and verified copy + skills-lock.json installation', async t => {
  const env = await createSandboxEnv(t, { name: 'api-demo', dependencies: { express: '5.0.0' } });
  const { runToolkitTui } = await import('../src/toolkit-tui.js');

  // Walk project skills -> optional skills -> review, back and forward, then cancel without writes.
  const ttyCancel = createFakeTty();
  const cancelPromise = runToolkitTui({
    input: ttyCancel.input,
    output: ttyCancel.output,
    projectRoot: env.projectRoot,
    agent: 'all',
    setupOptions: { homeDirectory: env.homeDirectory, codexHome: env.codexHome, toolkitRoot: env.toolkitRoot, environment: { PATH: '' } }
  });

  await ttyCancel.waitFor(/Paso 1 de 3/u);
  ttyCancel.sendKey('\r'); // Step 1 -> Step 2
  await ttyCancel.waitFor(/Paso 2 de 3/u);
  ttyCancel.sendKey('\r'); // Step 2 -> Step 3
  await ttyCancel.waitFor(/Paso 3 de 3/u);
  assert.deepEqual(await fs.readdir(env.homeDirectory), []);
  assert.equal(await fs.access(path.join(env.projectRoot, '.agents')).then(() => true, () => false), false);

  ttyCancel.sendKey('\x7f');
  await ttyCancel.waitFor(/Paso 2 de 3/u);
  ttyCancel.sendKey('\r');
  await ttyCancel.waitFor(/Paso 3 de 3/u);
  ttyCancel.sendKey('\x1b'); // Esc cancel preview -> back to Step 1 with zero writes
  await ttyCancel.waitFor(/Instalación cancelada/u);
  ttyCancel.sendKey('\x03'); // Ctrl+C exit
  assert.equal(await cancelPromise, 0);
  assert.equal(ttyCancel.input.rawMode, false);
  assert.deepEqual(await fs.readdir(env.homeDirectory), []);

  // 2. Put a custom conflicting file at .agents/skills/api-design-principles/SKILL.md
  const conflictFile = path.join(env.projectRoot, '.agents/skills/api-design-principles/SKILL.md');
  await fs.mkdir(path.dirname(conflictFile), { recursive: true });
  await fs.writeFile(conflictFile, 'keep-my-file');

  // Select the optional differential-review skill, then choose copy mode in final review.
  const ttyCopy = createFakeTty();
  const copyPromise = runToolkitTui({
    input: ttyCopy.input,
    output: ttyCopy.output,
    projectRoot: env.projectRoot,
    agent: 'all',
    setupOptions: { homeDirectory: env.homeDirectory, codexHome: env.codexHome, toolkitRoot: env.toolkitRoot, environment: { PATH: '' } }
  });

  await ttyCopy.waitFor(/Paso 1 de 3/u);
  ttyCopy.sendKey('a'); // explicitly select both compatible HTTP skills
  ttyCopy.sendKey('\r'); // project skills -> optional skills
  await ttyCopy.waitFor(/Paso 2 de 3/u);
  ttyCopy.sendKey(' '); // select differential-review
  ttyCopy.sendKey('\r'); // review
  await ttyCopy.waitFor(/Paso 3 de 3/u);
  ttyCopy.sendKey('e'); // edit installation settings at the end
  await ttyCopy.waitFor(/Editar configuración/u);
  ttyCopy.sendKey('j'); // mode
  ttyCopy.sendKey(' '); // symlink -> copy
  await ttyCopy.waitFor(/Copia verificada/u);
  ttyCopy.sendKey('\r'); // save settings; does not install
  await ttyCopy.waitFor(/\[Enter \/ s\] confirmar e instalar/u);
  assert.equal(await fs.access(path.join(env.projectRoot, '.agent-toolkit')).then(() => true, () => false), false);
  ttyCopy.sendKey('\r'); // Confirm install!
  await ttyCopy.waitFor(/Instalación verificada completada/u);
  ttyCopy.sendKey('q'); // Exit from done screen
  assert.equal(await copyPromise, 0);
  assert.equal(ttyCopy.input.rawMode, false);

  // Verify copied files + .agent-toolkit/skills-lock.json + .gitignore block + conflict untouched!
  assert.equal(await fs.readFile(conflictFile, 'utf8'), 'keep-my-file');
  const copiedSkillStat = await fs.lstat(path.join(env.projectRoot, '.claude/skills/nodejs-backend-patterns'));
  assert.equal(copiedSkillStat.isDirectory() && !copiedSkillStat.isSymbolicLink(), true);
  const optionalStat = await fs.lstat(path.join(env.projectRoot, '.agents/skills/differential-review'));
  assert.equal(optionalStat.isDirectory() && !optionalStat.isSymbolicLink(), true);

  const lock = JSON.parse(await fs.readFile(path.join(env.projectRoot, '.agent-toolkit/skills-lock.json'), 'utf8'));
  assert.ok(lock.skills['nodejs-backend-patterns']);
  assert.ok(lock.skills['differential-review']);
  const gitignoreText = await fs.readFile(path.join(env.projectRoot, '.gitignore'), 'utf8');
  assert.match(gitignoreText, /\.agent-toolkit\//u);

  // 3. Re-open wizard and decouple via [d] shortcut (first cancel with Esc, then confirm with Enter)!
  const ttyDetach = createFakeTty();
  const detachPromise = runToolkitTui({
    input: ttyDetach.input,
    output: ttyDetach.output,
    projectRoot: env.projectRoot,
    agent: 'all',
    setupOptions: { homeDirectory: env.homeDirectory, codexHome: env.codexHome, toolkitRoot: env.toolkitRoot, environment: { PATH: '' } }
  });

  await ttyDetach.waitFor(/acoplado en \.agent-toolkit\//u);
  ttyDetach.sendKey('d');
  await ttyDetach.waitFor(/Vista previa de desacoplado/u);
  ttyDetach.sendKey('\x1b'); // Esc cancel detach -> nothing deleted!
  await ttyDetach.waitFor(/Desacoplado cancelado/u);
  assert.equal(await fs.access(path.join(env.projectRoot, '.agent-toolkit/manifest.json')).then(() => true, () => false), true);

  ttyDetach.sendKey('d');
  await ttyDetach.waitFor(/Vista previa de desacoplado/u);
  ttyDetach.sendKey('\r'); // Confirm detach!
  await ttyDetach.waitFor(/Proyecto desacoplado limpiamente/u);
  ttyDetach.sendKey('q');
  assert.equal(await detachPromise, 0);

  // Coupled skills, .agent-toolkit/ and created .gitignore are gone, while user conflictFile remains intact!
  assert.equal(await fs.readFile(conflictFile, 'utf8'), 'keep-my-file');
  assert.equal(await fs.access(path.join(env.projectRoot, '.agent-toolkit')).then(() => true, () => false), false);
  assert.equal(await fs.access(path.join(env.projectRoot, '.gitignore')).then(() => true, () => false), false);
  assert.equal(await fs.access(path.join(env.projectRoot, '.claude')).then(() => true, () => false), false);
});

test('final configuration preserves skill choices, discards drafts, and installs only after reviewing refreshed settings', async t => {
  const env = await createSandboxEnv(t, { name: 'api-demo', dependencies: { express: '5.0.0' } });
  const { runToolkitTui } = await import('../src/toolkit-tui.js');
  const tty = createFakeTty();
  const running = runToolkitTui({ input: tty.input, output: tty.output, projectRoot: env.projectRoot,
    setupOptions: { homeDirectory: env.homeDirectory, codexHome: env.codexHome, toolkitRoot: env.toolkitRoot, environment: { PATH: '' } } });
  t.after(() => tty.sendKey('\x03'));
  await tty.waitFor(/Paso 1 de 3/u);
  tty.sendKey(' '); // explicitly select api-design-principles; leave nodejs-backend-patterns unchecked
  tty.sendKey('\r');
  await tty.waitFor(/Paso 2 de 3/u);
  tty.sendKey(' '); // select differential-review
  tty.sendKey('\r');
  await tty.waitFor(/Paso 3 de 3/u);
  assert.match(tty.getFrame(), /api-design-principles/u);
  assert.doesNotMatch(tty.getFrame(), /nodejs-backend-patterns/u);

  tty.sendKey('e');
  await tty.waitFor(/Editar configuración/u);
  tty.sendKey(' '); // both -> Claude
  await tty.waitFor(/Solo Claude Code/u);
  tty.sendKey('\x1b'); // discard draft
  await tty.waitFor(/\[Enter \/ s\] confirmar e instalar/u);
  assert.match(tty.getFrame(), /Claude \+ Codex/u);
  tty.sendKey('e');
  await tty.waitFor(/Editar configuración/u);
  tty.sendKey(' '); // both -> Claude
  tty.sendKey('j');
  tty.sendKey(' '); // copy
  await tty.waitFor(/Copia verificada/u);
  tty.sendKey('\r'); // update preview; never install here
  await tty.waitFor(/\[Enter \/ s\] confirmar e instalar/u);
  assert.match(tty.getFrame(), /Solo Claude Code/u);
  assert.match(tty.getFrame(), /skills-lock\.json/u);
  assert.doesNotMatch(tty.getFrame(), /nodejs-backend-patterns/u);
  assert.deepEqual(await fs.readdir(env.homeDirectory), []);
  assert.equal(await fs.access(path.join(env.projectRoot, '.agent-toolkit')).then(() => true, () => false), false);

  tty.sendKey('\x7f');
  await tty.waitFor(/Paso 2 de 3/u);
  assert.match(tty.getFrame(), /\[x\] differential-review/u);
  tty.sendKey('\x7f');
  await tty.waitFor(/Paso 1 de 3/u);
  assert.match(tty.getFrame(), /\[ \] nodejs-backend-patterns/u);
  assert.match(tty.getFrame(), /\[x\] api-design-principles/u);
  tty.sendKey('\r');
  await tty.waitFor(/Paso 2 de 3/u);
  tty.sendKey('\r');
  await tty.waitFor(/Paso 3 de 3/u);
  tty.sendKey('\r');
  await tty.waitFor(/Instalación verificada completada/u);
  tty.sendKey('q');
  assert.equal(await running, 0);
  const lock = JSON.parse(await fs.readFile(path.join(env.projectRoot, '.agent-toolkit/skills-lock.json'), 'utf8'));
  assert.ok(lock.skills['api-design-principles']);
  assert.ok(lock.skills['differential-review']);
  assert.equal(lock.skills['nodejs-backend-patterns'], undefined);
  assert.equal(await fs.access(path.join(env.projectRoot, '.agents/skills')).then(() => true, () => false), false);
  assert.equal((await fs.lstat(path.join(env.projectRoot, '.claude/skills/differential-review'))).isSymbolicLink(), false);
});

test('a failed settings refresh stays in the editor and cannot install the old preview', async t => {
  const env = await createSandboxEnv(t);
  const { runToolkitTui } = await import('../src/toolkit-tui.js');
  const tty = createFakeTty();
  const running = runToolkitTui({ input: tty.input, output: tty.output, projectRoot: env.projectRoot,
    setupOptions: { homeDirectory: env.homeDirectory, codexHome: env.codexHome, toolkitRoot: env.toolkitRoot, environment: { PATH: '' } } });
  t.after(() => tty.sendKey('\x03'));
  await tty.waitFor(/Paso 1 de 3/u);
  tty.sendKey('\r');
  await tty.waitFor(/Paso 2 de 3/u);
  tty.sendKey('\r');
  await tty.waitFor(/Paso 3 de 3/u);
  tty.sendKey('e');
  await tty.waitFor(/Editar configuración/u);
  tty.sendKey(' '); // changed target requires a new snapshot
  await tty.waitFor(/Solo Claude Code/u);
  const catalogPath = path.join(env.toolkitRoot, 'catalogs/skills.json');
  const originalCatalog = await fs.readFile(catalogPath);
  await fs.writeFile(catalogPath, '{ invalid');
  tty.sendKey('\r');
  await tty.waitFor(/no contiene JSON válido/u);
  assert.match(tty.getFrame(), /Editar configuración/u);
  assert.doesNotMatch(tty.getFrame(), /confirmar e instalar/u);
  tty.sendKey('s'); // must not apply the old preview from inside the editor
  await fs.writeFile(catalogPath, originalCatalog);
  tty.sendKey('\r');
  await tty.waitFor(/\[Enter \/ s\] confirmar e instalar/u);
  assert.match(tty.getFrame(), /Solo Claude Code/u);
  assert.deepEqual(await fs.readdir(env.homeDirectory), []);
  assert.equal(await fs.access(path.join(env.projectRoot, '.agent-toolkit')).then(() => true, () => false), false);
  tty.sendKey('q');
  assert.equal(await running, 0);
});

test('empty project and empty skill selection can reach review without creating artifacts', async t => {
  const env = await createSandboxEnv(t, { name: 'empty-project' });
  const { runToolkitTui } = await import('../src/toolkit-tui.js');
  const tty = createFakeTty();
  const running = runToolkitTui({ input: tty.input, output: tty.output, projectRoot: env.projectRoot, agent: 'claude',
    setupOptions: { homeDirectory: env.homeDirectory, codexHome: env.codexHome, toolkitRoot: env.toolkitRoot, environment: { PATH: '' } } });
  t.after(() => tty.sendKey('\x03'));
  await tty.waitFor(/Paso 1 de 3/u);
  assert.match(tty.getFrame(), /0 de 0 marcadas/u);
  tty.sendKey(' ');
  tty.sendKey('a');
  tty.sendKey('\r');
  await tty.waitFor(/Paso 2 de 3/u);
  tty.sendKey('a');
  await tty.waitFor(/10 de 10 marcadas/u);
  tty.sendKey('a');
  await tty.waitFor(/0 de 10 marcadas/u);
  tty.sendKey('\r');
  await tty.waitFor(/Paso 3 de 3/u);
  assert.match(tty.getFrame(), /No hay skills de proyecto seleccionadas/u);
  tty.sendKey('e');
  await tty.waitFor(/Editar configuración/u);
  tty.sendKey('j'); tty.sendKey('j'); tty.sendKey('j');
  tty.sendKey(' '); // disable the pending global setup as well
  await tty.waitFor(/\[ \] Sincronizar/u);
  tty.sendKey('\r');
  await tty.waitFor(/No hay cambios pendientes de escribir/u);
  tty.sendKey('\r');
  await tty.waitFor(/Instalación verificada completada/u);
  tty.sendKey('q');
  assert.equal(await running, 0);
  assert.deepEqual(await fs.readdir(env.homeDirectory), []);
  assert.deepEqual(await fs.readdir(env.projectRoot), ['package.json']);
});

test('runToolkitCli handles non-TTY fallback, recommend, detach (--apply / --json) and preserves exit codes', async t => {
  const env = await createSandboxEnv(t);
  const { runToolkitCli } = await import('../src/toolkit-cli.js');
  const { planProjectSkillInstall, applyProjectSkillInstall } = await import('../src/skill-recommendations.js');
  const { loadSkillCatalog } = await import('../src/skill-catalog.js');

  let errOut = '';
  const codeNoTty = await runToolkitCli([], {
    out: () => {},
    err: text => { errOut += text; },
    isTTY: false
  });
  assert.equal(codeNoTty, 2);
  assert.match(errOut, /recommend/u);

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

// ---- Review lines for the real state of each link, and applying from an npx cache ----

const dirLinkType = process.platform === 'win32' ? 'junction' : 'dir';
const linkAt = async (to, at) => { await fs.mkdir(path.dirname(at), { recursive: true }); await fs.symlink(to, at, dirLinkType); };
const BASE_SKILLS = ['differential-review', 'frontend-design', 'mcp-builder', 'web-design-guidelines'];
async function reviewOf(env, setupOptions, prepare = () => {}) {
  const { buildToolkitTuiSnapshot, createToolkitTuiModel, computeInstallPreview } = await import('../src/toolkit-tui.js');
  const model = createToolkitTuiModel(await buildToolkitTuiSnapshot({ projectRoot: env.projectRoot, setupOptions }));
  prepare(model);
  model.config.syncGlobalCore = true;
  model.step = 3;
  model.previewData = await computeInstallPreview(model, setupOptions);
  return { model, lines: model.previewData.actions.map(action => `${action.mark} ${action.label}`) };
}

test('review lines say what happens to each global link: create, move, repair or leave alone', async t => {
  const env = await createSandboxEnv(t);
  const { acquireLock } = await import('../src/install-lock.js'), { recordEntries } = await import('../src/install-registry.js');
  const { renderToolkitTuiFrame } = await import('../src/toolkit-tui.js');
  const home = env.homeDirectory;
  await linkAt(path.join(env.root, '.npm/_npx/old/node_modules/nexakit/skills/frontend-design'), path.join(home, '.claude/skills/frontend-design'));
  const owned = path.join(env.root, 'muerta/skills/frontend-design');
  await linkAt(owned, path.join(home, '.agents/skills/frontend-design'));
  const lock = await acquireLock(path.join(home, '.nexakit'), { waitMs: 1000 });
  await recordEntries(path.join(home, '.nexakit'), [{ destino: path.join(home, '.agents/skills/frontend-design'), apunta: owned, raiz: path.join(env.root, 'muerta') }], lock);
  await lock.release();
  const legacy = path.join(env.root, 'Agent-Toolkit');
  for (const name of ['differential-review', 'mcp-builder', 'web-design-guidelines']) {
    await linkAt(path.join(legacy, 'skills', name), path.join(home, '.claude/skills', name));
  }
  await linkAt(path.join(env.root, 'suelta/skills/mcp-builder'), path.join(home, '.agents/skills/mcp-builder'));

  const setupOptions = { homeDirectory: home, codexHome: env.codexHome, toolkitRoot: env.toolkitRoot, environment: { PATH: '' } };
  const { model, lines } = await reviewOf(env, setupOptions);
  for (const expected of [
    '↻ [global claude] frontend-design: mover a la copia estable',
    '↻ [global codex] frontend-design: reparar',
    `! 3 enlaces rotos hacia ${legacy} parecen de una instalación anterior. Si son de nexakit: npx nexakit reparar --desde ${legacy}`,
    '! [global codex] mcp-builder: enlace roto que no es de nexakit (no se toca)',
    '+ [global codex] web-design-guidelines'
  ]) assert.ok(lines.includes(expected), `${expected}\n--- got:\n${lines.join('\n')}`);
  assert.equal(lines.filter(line => line.includes('[global claude] differential-review')).length, 0, 'grouped links are not listed one by one');
  assert.equal(lines.some(line => line.includes('Copia estable')), false, 'not running from an npx cache');
  assert.match(renderToolkitTuiFrame(model, { columns: 220, color: false }), /↻ \[global codex\] frontend-design: reparar/u);
});

test('a valid development copy is used and named once, with what it lacks, and the MCP pointing there counts as ready', async t => {
  const env = await createSandboxEnv(t);
  const { renderToolkitTuiFrame } = await import('../src/toolkit-tui.js');
  const home = env.homeDirectory;
  const dev = path.join(env.root, 'dev');
  await fs.cp(env.toolkitRoot, dev, { recursive: true });
  await fs.rm(path.join(dev, 'skills/mcp-builder'), { recursive: true });
  await fs.mkdir(path.join(dev, 'bin'));
  await fs.writeFile(path.join(dev, 'bin/agent-toolkit-mcp.js'), '');
  for (const folder of ['.claude', '.agents']) for (const name of BASE_SKILLS.filter(name => name !== 'mcp-builder')) {
    await linkAt(path.join(dev, 'skills', name), path.join(home, folder, 'skills', name));
  }
  const entry = path.join(dev, 'bin/agent-toolkit-mcp.js');
  await fs.writeFile(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { 'agent-toolkit-workflow': { command: 'node', args: [entry] } } }));
  await fs.mkdir(env.codexHome, { recursive: true });
  await fs.writeFile(path.join(env.codexHome, 'config.toml'), `[mcp_servers.agent-toolkit-workflow]\ncommand = "node"\nargs = [${JSON.stringify(entry)}]\n`);

  const setupOptions = { homeDirectory: home, codexHome: env.codexHome, toolkitRoot: env.toolkitRoot, environment: { PATH: '' } };
  const { model, lines } = await reviewOf(env, setupOptions);
  assert.equal(lines.filter(line => line === `✓ Usa tu copia en ${dev}`).length, 1);
  assert.ok(lines.includes(`! Tu copia en ${dev} no incluye 1 skill nueva; actualízala`), lines.join('\n'));
  assert.equal(lines.some(line => line.startsWith('+ [global')), false, 'nothing is created from another origin');
  assert.match(renderToolkitTuiFrame(model, { columns: 220, color: false }), /✓ MCP/u);
});

test('when every global link is installed there is no global line at all', async t => {
  const env = await createSandboxEnv(t);
  const home = env.homeDirectory;
  for (const folder of ['.claude', '.agents']) for (const name of BASE_SKILLS) {
    await linkAt(path.join(env.toolkitRoot, 'skills', name), path.join(home, folder, 'skills', name));
  }
  const setupOptions = { homeDirectory: home, codexHome: env.codexHome, toolkitRoot: env.toolkitRoot, environment: { PATH: '' } };
  const { lines } = await reviewOf(env, setupOptions);
  assert.deepEqual(lines.filter(line => line.includes('[global')), []);
});

test('applying from an npx cache creates the stable copy first and links everything to it', async t => {
  const env = await createSandboxEnv(t);
  const { executeApprovedPreview } = await import('../src/toolkit-tui.js');
  const { writeFakeInstall } = await import('../test-support/fake-npm.js');
  const home = env.homeDirectory;
  const ephemeral = path.join(env.root, '.npm/_npx/abc/node_modules/nexakit');
  await fs.cp(env.toolkitRoot, ephemeral, { recursive: true });
  const { version } = JSON.parse(await fs.readFile(path.join(ephemeral, 'package.json'), 'utf8'));
  const calls = [];
  const runNpm = async args => {
    calls.push(args);
    const installed = await writeFakeInstall(args[args.indexOf('--prefix') + 1], { version, skills: [] });
    await fs.cp(ephemeral, installed, { recursive: true, force: true });
    return { status: 0, stderr: '' };
  };
  const setupOptions = { homeDirectory: home, codexHome: env.codexHome, toolkitRoot: ephemeral, environment: { PATH: '' }, runNpm };
  const { model, lines } = await reviewOf(env, setupOptions, m => {
    for (const item of m.fundamentalItems) item.checked = item.skillName === 'frontend-design';
  });
  assert.equal(lines[0], '+ Copia estable de nexakit en ~/.nexakit');
  assert.equal(await fs.access(path.join(home, '.nexakit')).then(() => true, () => false), false, 'the preview writes nothing');

  await executeApprovedPreview(model, setupOptions);
  assert.equal(calls.length, 1);
  const actual = await fs.realpath(path.join(home, '.nexakit/actual'));
  assert.equal(await fs.readlink(path.join(home, '.claude/skills/frontend-design')), path.join(home, '.nexakit/actual/skills/frontend-design'));
  assert.equal(await fs.realpath(path.join(env.projectRoot, '.claude/skills/frontend-design')), path.join(actual, 'skills/frontend-design'));
  await fs.rm(path.join(env.root, '.npm'), { recursive: true });
  assert.equal(await fs.access(path.join(env.projectRoot, '.claude/skills/frontend-design/SKILL.md')).then(() => true, () => false), true);
});
