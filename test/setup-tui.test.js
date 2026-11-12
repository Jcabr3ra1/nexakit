import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { test } from 'node:test';
import { createFakeClis } from '../test-support/fake-clis.js';
import { createFakeTty } from '../test-support/fake-tty.js';
import { buildConfirmation } from '../src/setup-plan.js';
import { applyMemoryPathCheck, createSetupModel, handleSetupKey, renderSetupFrame, runSetupTui } from '../src/setup-tui.js';
import { cellWidth } from '../src/terminal-text.js';

const TOOLKIT_ROOT = fileURLToPath(new URL('../', import.meta.url));
const HOME = '/home/juan';
const VAULT = `${HOME}/programacion/Obsidian-Vaults/PUNTO-MOTOS-MEMORY`;
const skill = (name, suggested, reason = null) => ({ name, summary: `Qué hace ${name}: una explicación de una línea.`, reason,
  matchCount: suggested ? 1 : 0, suggested, license: 'MIT', links: { claude: 'missing', codex: 'missing' } });

function state(overrides = {}) {
  return {
    homeDirectory: HOME, version: '0.2.0',
    project: { root: `${HOME}/programacion/Proyectos/Punto_Motos`, git: true, fromSubfolder: true, id: 'punto-motos', displayName: 'Punto Motos' },
    signals: [{ id: 'django', label: 'Django' }, { id: 'nodejs', label: 'Node.js' }, { id: 'react', label: 'React' }, { id: 'tauri', label: 'Tauri' }, { id: 'typescript', label: 'TypeScript' }],
    skills: [skill('api-design-principles', true, 'backend usa Django'), skill('frontend-design', true, 'frontend usa React'),
      skill('differential-review', false), skill('webapp-testing', false)],
    agentsFound: { claude: true, codex: true, antigravity: false },
    globalSkills: { claude: { pending: 1, conflicts: 0 }, codex: { pending: 1, conflicts: 0 }, antigravity: { pending: 21, conflicts: 0 } },
    stableCopy: { needed: false }, stableCommand: { state: 'falta' },
    memory: { existing: null, suggestedPath: VAULT, kinds: { [VAULT]: 'new' }, connections: {} },
    savedAnswers: null,
    internal: { linkRoot: `${HOME}/.nexakit/actual` },
    ...overrides
  };
}
const press = (model, ...keys) => keys.reduce((current, key) => handleSetupKey(current, key).model, model);
const frame = (model, columns = 100, color = false) => renderSetupFrame(model, { columns, color });

test('every screen fits 40, 68 and 100 columns, in color or not, without absolute paths or jargon', () => {
  const screens = [];
  let model = createSetupModel(state());
  for (const step of ['skills', 'memory', 'agents', 'confirm']) {
    screens.push([step, model]);
    model = press(model, '\r');
  }
  screens.push(['confirm-detail', press(screens[3][1], 'd')]);
  screens.push(['memory-path', press(screens[1][1], '\x1b[B', '\r')]);
  for (const [name, current] of screens) {
    for (const columns of [40, 68, 100]) {
      for (const color of [false, true]) {
        const text = stripVTControlCharacters(frame(current, columns, color));
        for (const line of text.split('\n')) assert.ok(cellWidth(line) <= columns, `${name} @${columns}: «${line}»`);
        if (name !== 'confirm-detail') assert.doesNotMatch(text, /\/home\/juan|SHA|escenario|integridad/u, `${name} @${columns}`);
      }
    }
  }
});

test('the skills question shows the project, what was detected and the suggestions with their reason', () => {
  const text = frame(createSetupModel(state()));
  assert.match(text, /^◇  Proyecto: Punto Motos \(repositorio completo\)$/mu);
  assert.match(text, /^◇  Detecté: Django · React · Tauri · TypeScript · y 1 más$/mu, 'frameworks first, at most four');
  assert.match(text, /^│ ❯ ◼ api-design-principles\s+backend usa Django$/mu);
  assert.match(text, /^│   ◻ ver 2 más…$/mu);
  const expanded = press(createSetupModel(state()), '\x1b[B', '\x1b[B', '\r');
  assert.match(frame(expanded), /◻ differential-review/u);
  assert.match(frame(press(createSetupModel(state()), 'i')), /Qué hace api-design-principles/u);
});

test('answered questions fold into one ◇ line each', () => {
  const confirm = press(createSetupModel(state()), '\r', '\r', '\r');
  const text = frame(confirm);
  assert.match(text, /^◇  Skills: 2 elegidas$/mu);
  assert.match(text, /^◇  Memoria: ~\/programacion\/Obsidian-Vaults\/PUNTO-MOTOS-MEMORY$/mu);
  assert.match(text, /^◇  IA: Claude Code y Codex$/mu);
  assert.match(text, /^│   \+ Memoria nueva en ~\/programacion\/Obsidian-Vaults\/PUNTO-MOTOS-MEMORY$/mu);
  assert.match(text, /npx nexakit quitar/u);
  assert.match(text, /¿Lo preparo\?  ● Sí \/ ○ No/u);
});

test('Enter four times accepts the suggestions and asks to apply', () => {
  let model = createSetupModel(state());
  for (let i = 0; i < 3; i++) model = handleSetupKey(model, '\r').model;
  const { effect, model: last } = handleSetupKey(model, '\r');
  assert.equal(effect, 'apply');
  assert.deepEqual(last.answers, {
    version: 1, skills: { chosen: ['api-design-principles', 'frontend-design'], discarded: [] },
    agents: ['claude', 'codex'], memory: { decision: 'path', path: VAULT }
  });
});

test('back keeps the answers, an unchecked suggestion is discarded, and "Ahora no" drops the memory blocks', () => {
  let model = press(createSetupModel(state()), ' ', '\r');            // uncheck api-design-principles
  assert.deepEqual(model.answers.skills, { chosen: ['frontend-design'], discarded: ['api-design-principles'] });
  model = press(model, '\x1b[B', '\x1b[B', '\r');                       // memory: Ahora no
  assert.deepEqual(model.answers.memory, { decision: 'later' });
  model = press(model, '\x7f');                                        // back to memory
  assert.equal(model.step, 'memory');
  model = press(model, '\x7f');                                        // back to skills
  assert.match(frame(model), /◻ api-design-principles/u, 'the unchecked skill stays unchecked');
  model = press(model, '\r', '\x1b[B', '\x1b[B', '\r', '\r');
  assert.equal(model.step, 'confirm');
  assert.ok(!buildConfirmation(model.state, model.answers).blocks.some(block => block.id.startsWith('memory')));
});

test('q exits from every question, and "No" at the confirmation exits too', () => {
  let model = createSetupModel(state());
  for (let i = 0; i < 4; i++) {
    assert.equal(handleSetupKey(model, 'q').effect, 'exit', model.step);
    model = press(model, '\r');
  }
  const confirm = press(createSetupModel(state()), '\r', '\r', '\r', '\x1b[C');
  assert.match(frame(confirm), /○ Sí \/ ● No/u);
  assert.equal(handleSetupKey(confirm, '\r').effect, 'exit');
});

test('another folder for the memory: typed with ~, checked, and refused when it is not empty', () => {
  let model = press(createSetupModel(state()), '\r', '\x1b[B', '\r');
  assert.equal(model.step, 'memory-path');
  for (const char of '~/memorias/pm') model = press(model, char);
  const { effect, path: target } = handleSetupKey(model, '\r');
  assert.equal(effect, 'check-path');
  assert.equal(target, path.resolve(path.join(HOME, 'memorias/pm')));
  assert.match(frame(applyMemoryPathCheck(model, target, 'invalid')), /no está vacía y no es una memoria/u);
  const accepted = applyMemoryPathCheck(model, target, 'new');
  assert.equal(accepted.step, 'agents');
  assert.deepEqual(accepted.answers.memory, { decision: 'path', path: target });
  const relative = press(press(createSetupModel(state()), '\r', '\x1b[B', '\r'), 'r', 'e', 'l');
  assert.match(frame(press(relative, '\r')), /ruta completa/u);
});

test('without Git only "Ahora no" is offered, with the reason', () => {
  const model = press(createSetupModel(state({ project: { ...state().project, git: false } })), '\r');
  const text = frame(model);
  assert.match(text, /● Ahora no/u);
  assert.doesNotMatch(text, /Sí, en/u);
  assert.match(text, /git init/u);
});

test('when everything is ready it opens the menu instead of asking', () => {
  const answers = { version: 1, skills: { chosen: [], discarded: ['api-design-principles', 'frontend-design'] }, agents: ['claude'], memory: { decision: 'later' } };
  const ready = state({ globalSkills: { claude: { pending: 0, conflicts: 0 }, codex: { pending: 0, conflicts: 0 }, antigravity: { pending: 0, conflicts: 0 } },
    stableCommand: { state: 'igual' }, savedAnswers: answers });
  const model = createSetupModel(ready);
  assert.equal(model.step, 'menu');
  assert.match(frame(model), /Todo está listo/u);
  assert.match(frame(model), /● No, salir/u);
  assert.equal(handleSetupKey(model, '\r').effect, 'exit');
  const skills = press(model, '\x1b[B', '\r');
  assert.equal(skills.step, 'skills');
  assert.equal(press(skills, '\r').step, 'confirm', 'from the menu, skills go straight to the confirmation');
  assert.equal(handleSetupKey(press(model, '\x1b[B', '\x1b[B', '\x1b[B'), '\r').effect, 'detach-preview');
});

// ── The loop, end to end in a temporary HOME with fake CLIs ──────────────────────────────────────────────────────

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
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'setup-tui-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const home = path.join(base, 'home'), repo = path.join(base, 'Punto_Motos'), bin = path.join(base, 'bin');
  await fs.mkdir(home);
  await fs.mkdir(path.join(repo, 'frontend'), { recursive: true });
  await fs.writeFile(path.join(repo, 'frontend', 'README.md'), 'Interfaz en React.\n');
  execFileSync('git', ['init', '-q', repo]);
  const clis = createFakeClis(home);
  clis.installBin(bin);
  return { base, home, repo, options: { start: repo, homeDirectory: home, environment: { PATH: bin, HOME: home }, toolkitRoot: TOOLKIT_ROOT, runCommand: clis.runCommand } };
}

test('a full run with the suggested answers ends in «Listo», and a second run opens the menu', async t => {
  const w = await world(t);
  const tty = createFakeTty({ columns: 80 });
  const running = runSetupTui({ input: tty.input, output: tty.output, options: w.options });
  await tty.waitFor(/¿Proyecto limpio o ya empezado\?/u);
  tty.sendKey('\r');
  await tty.waitFor(/¿Qué skills quieres\?/u);
  for (const wait of [/¿Crear la memoria/u, /¿Con qué IA trabajas/u, /¿Qué mods de Claude Code quieres/u, /¿Lo preparo/u]) {
    tty.sendKey('\r');
    await tty.waitFor(wait);
  }
  tty.sendKey('\r');
  await tty.waitFor(/Listo\. Ahora:/u);
  assert.match(tty.getFrame(), /Comprobación final: todo responde/u);
  assert.match(tty.getFrame(), /lee la memoria y resume el proyecto/u);
  tty.sendKey('\r');
  assert.equal(await running, 0);
  assert.equal(tty.input.rawMode, false);

  const again = createFakeTty({ columns: 80 });
  const second = runSetupTui({ input: again.input, output: again.output, options: w.options });
  await again.waitFor(/Todo está listo/u);
  again.sendKey('q');
  assert.equal(await second, 0);
});

test('redraws in place on the alternate screen and leaves only the last frame in the scrollback', async t => {
  const w = await world(t);
  const tty = createFakeTty({ columns: 80 });
  const running = runSetupTui({ input: tty.input, output: tty.output, options: w.options });
  await tty.waitFor(/¿Proyecto limpio o ya empezado\?/u);
  tty.sendKey('\r');
  await tty.waitFor(/¿Qué skills quieres\?/u);
  for (const key of ['\x1b[B', '\x1b[B', '\x1b[A']) tty.sendKey(key);
  await new Promise(resolve => setTimeout(resolve, 20));
  tty.sendKey('q');
  assert.equal(await running, 0);
  const out = tty.getOutput();
  assert.doesNotMatch(out, /\x1b\[2J/u, 'clearing the screen pushes every frame into the scrollback');
  const enter = out.indexOf('\x1b[?1049h');
  const leave = out.lastIndexOf('\x1b[?1049l');
  assert.ok(enter >= 0 && leave > enter, 'the questions are drawn on the alternate screen');
  const after = out.slice(leave);
  assert.equal(after.match(/¿Qué skills quieres\?/gu)?.length, 1, 'the last frame is printed once on the normal screen');
});

test('Ctrl+C at any question, or "No" at the confirmation, writes nothing', async t => {
  const w = await world(t);
  const before = { home: snapshot(w.home), repo: snapshot(w.repo) };
  for (let answered = 0; answered <= 5; answered++) {
    const tty = createFakeTty({ columns: 80 });
    const running = runSetupTui({ input: tty.input, output: tty.output, options: w.options });
    await tty.waitFor(/¿Proyecto limpio o ya empezado\?/u);
  tty.sendKey('\r');
  await tty.waitFor(/¿Qué skills quieres\?/u);
    for (let i = 0; i < Math.min(answered, 4); i++) tty.sendKey('\r');
    if (answered === 5) {
      await tty.waitFor(/¿Lo preparo/u);
      tty.sendKey('\x1b[C');
      await tty.waitFor(/● No/u);
      tty.sendKey('\r');
    } else {
      await new Promise(resolve => setTimeout(resolve, 20));
      tty.sendKey('\x03');
    }
    assert.equal(await running, 0);
  }
  assert.deepEqual({ home: snapshot(w.home), repo: snapshot(w.repo) }, before);
});

test('skills without a passed check say «no probada», with review notes in the info view', () => {
  const skills = [
    { ...skill('frontend-design', true, 'frontend usa React'), tested: false, reviewNotes: 'Consulta internet.' },
    { ...skill('api-design-principles', true, 'backend usa Django'), tested: true, reviewNotes: null }
  ];
  const model = createSetupModel(state({ skills }));
  const text = frame(model);
  assert.match(text, /frontend-design.*· no probada/u);
  assert.doesNotMatch(text, /api-design-principles.*no probada/u);
  const info = frame(press(model, 'i'));
  assert.match(info, /No probada: nadie ha comprobado aún que mejore el trabajo\./u);
  assert.match(info, /Observaciones: Consulta internet\./u);
  for (const columns of [40, 68]) {
    for (const line of stripVTControlCharacters(frame(press(model, 'i'), columns)).split('\n')) assert.ok(cellWidth(line) <= columns, `@${columns}: «${line}»`);
  }
});

test('the skills step lists external skills apart, as something installed separately', () => {
  const external = [{ name: 'ui-ux-pro-max', reason: 'frontend usa React' }];
  const model = createSetupModel(state({ externalSkills: external }));
  const text = frame(model);
  assert.match(text, /Se instalan aparte: ui-ux-pro-max/u);
  assert.doesNotMatch(frame(createSetupModel(state())), /Se instalan aparte/u);
  for (const columns of [40, 68]) {
    for (const line of stripVTControlCharacters(frame(model, columns)).split('\n')) assert.ok(cellWidth(line) <= columns, `@${columns}: «${line}»`);
  }
});

test('the skills step says which technologies have no skill and how to ask for one', () => {
  const model = createSetupModel(state({ uncoveredTech: [{ id: 'tauri', label: 'Tauri' }, { id: 'rust', label: 'Rust' }] }));
  const text = stripVTControlCharacters(frame(model));
  assert.match(text, /Sin skill en el catálogo: Tauri y Rust\./u);
  assert.match(text, /busca una skill para Tauri/u);
  assert.doesNotMatch(frame(createSetupModel(state())), /Sin skill en el catálogo/u);
  for (const columns of [40, 68]) {
    for (const line of stripVTControlCharacters(frame(model, columns)).split('\n')) assert.ok(cellWidth(line) <= columns, `@${columns}: «${line}»`);
  }
});

const generators = await (await import('../src/generators-catalog.js')).loadGeneratorsCatalog();
const cleanState = overrides => state({folder:{empty:true,insideGit:false,entries:[]},generators,cleanProject:null,...overrides});
test('an empty folder starts at mode with limpio marked',()=>{
 const m=createSetupModel(cleanState());assert.equal(m.step,'mode');assert.equal(m.cursor,0);assert.match(frame(m),/¿Proyecto limpio o ya empezado/);
});
test('ya empezado goes to skills as today',()=>{
 assert.equal(press(createSetupModel(cleanState()),'\x1b[B','\r').step,'skills');
});
test('choosing only react skips to git then confirm',()=>{
 const git=press(createSetupModel(cleanState()),'\r','\r','\r','\r','\r');assert.equal(git.step,'git');
 const result=handleSetupKey(git,'\r');assert.equal(result.model.step,'clean-confirm');assert.equal(result.effect,'prepare-clean');
});
test('database without backend offers only supabase',()=>{
 const m=press(createSetupModel(cleanState()),'\r','\r','\r');assert.equal(m.step,'tech-database');
 assert.match(frame(m),/Supabase/);assert.doesNotMatch(frame(m),/SQLite|PostgreSQL/);
});
test('a missing requirement blocks the confirmation',()=>{
 const m={...createSetupModel(cleanState()),step:'clean-confirm',requirements:[{program:'python',minVersion:'3.12',ok:false,found:null}]};
 assert.equal(handleSetupKey(m,'\r').effect,undefined);assert.match(frame(m),/python/);
});
test('q in the selector exits without effects',()=>{
 const m=press(createSetupModel(cleanState()),'\r');assert.equal(handleSetupKey(m,'q').effect,'exit');
});
test('no question repeats when cleanProject was saved',()=>{
 const m=createSetupModel(cleanState({cleanProject:{choice:{frontend:'react-vite',backend:null,database:null,mobile:null},git:true,status:'creado'}}));
 assert.equal(m.step,'skills');
});
test('every clean screen fits in 40 and 68 columns',()=>{
 const m=createSetupModel(cleanState());
 for(const step of ['mode','tech-frontend','tech-backend','tech-database','tech-mobile','git','clean-folder','clean-confirm'])
  for(const columns of [40,68]) for(const line of stripVTControlCharacters(frame({...m,step},columns)).split('\n')) assert.ok(cellWidth(line)<=columns,`${step}: ${line}`);
});
test('the clean terminal loop creates React then offers its skills without repeating mode',async t=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'clean-terminal-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const {fakeGenerators}=await import('../test-support/fake-generators.js');
 const {readCleanProjectAnswers}=await import('../src/skill-recommendations.js');
 const {detectSignals}=await import('../src/project-signals.js');
 let gathered=0;
 const gather=async()=>{gathered++;return cleanState({creationRoot:root,homeDirectory:root,project:{root,git:false,fromSubfolder:false,id:'prueba',displayName:'Prueba'},
  signals:(await detectSignals(root,{git:false})).signals,cleanProject:await readCleanProjectAnswers(root)});};
 const tty=createFakeTty();
 const running=runSetupTui({input:tty.input,output:tty.output,gather,options:{start:root,homeDirectory:root,runCommand:fakeGenerators()}});
 await tty.waitFor(/¿Proyecto limpio/);tty.sendKey('\r');
 for(const screen of [/Elige frontend/,/Elige backend/,/Elige base de datos/,/Elige app móvil/]){await tty.waitFor(screen);tty.sendKey('\r');}
 await tty.waitFor(/¿Inicio Git/);tty.sendKey('\x1b[C');tty.sendKey('\r');
 await tty.waitFor(/¿Creo la base/);tty.sendKey('\r');
 await tty.waitFor(/¿Qué skills quieres/);assert.match(tty.getFrame(),/frontend-design/);
 tty.sendKey('q');assert.equal(await running,0);
 assert.equal((await readCleanProjectAnswers(root)).status,'creado');assert.equal(gathered,2);
});
test('continuing after a failed child creation prepares the child instead of its parent',async t=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'clean-child-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.writeFile(path.join(root,'README.md'),'Padre');
 const {fakeGenerators}=await import('../test-support/fake-generators.js');
 const {readCleanProjectAnswers}=await import('../src/skill-recommendations.js');
 const gather=async({start})=>cleanState({creationRoot:start,homeDirectory:root,folder:{empty:(await fs.readdir(start)).length===0,insideGit:false},
   project:{root:start,git:false,fromSubfolder:false,id:'prueba',displayName:path.basename(start)},cleanProject:await readCleanProjectAnswers(start)});
 const tty=createFakeTty(),running=runSetupTui({input:tty.input,output:tty.output,gather,options:{start:root,homeDirectory:root,
   runCommand:fakeGenerators({fail:(_c,args)=>args.includes('vite@latest')})}});
 await tty.waitFor(/¿Proyecto limpio/);tty.sendKey('\x1b[A');tty.sendKey('\r');
 await tty.waitFor(/Nombre de la subcarpeta/);tty.sendKey('nueva');tty.sendKey('\r');
 for(const screen of [/Elige frontend/,/Elige backend/,/Elige base de datos/,/Elige app móvil/]){await tty.waitFor(screen);tty.sendKey('\r');}
 await tty.waitFor(/¿Inicio Git/);tty.sendKey('\x1b[C');tty.sendKey('\r');
 await tty.waitFor(/¿Creo la base/);tty.sendKey('\r');
 await tty.waitFor(/La creación no terminó/);tty.sendKey('\r');
 await tty.waitFor(/¿Qué skills quieres/);const shown=tty.getFrame();tty.sendKey('q');await running;
 assert.match(shown,/Proyecto: nueva/);assert.equal(await fs.readFile(path.join(root,'README.md'),'utf8'),'Padre');
});
test('clean confirmation includes implicit venv and optional Git commands before creation',async()=>{
 const {planCleanProject}=await import('../src/clean-project.js');
 const choice={frontend:null,backend:'django',database:null,mobile:null};
 const model={...createSetupModel(cleanState()),step:'clean-confirm',cleanChoice:choice,requirements:[],cleanPlan:planCleanProject({catalog:generators,choice,name:'demo',platform:'linux'})};
 const text=frame(model,100);assert.match(text,/(?:python3|py).*venv/);assert.match(text,/git.*init/);assert.match(text,/git.*commit/);
});
