import assert from 'node:assert/strict';
import { stripVTControlCharacters } from 'node:util';
import { test } from 'node:test';
import { createSetupModel, handleSetupKey, renderSetupFrame } from '../src/setup-tui.js';
import { cellWidth } from '../src/terminal-text.js';

const HOME = '/home/juan';
const VAULT = `${HOME}/memorias/proyecto`;
const MOD_STATES = {
  niveles: 'activo',
  'nexakit-modelo': 'falta',
  'nexakit-ahorro': 'actualizable',
  'nexakit-lecciones': 'desactivado',
  'nexakit-sesion': 'falta',
  'nexakit-guardarrailes': 'falta',
};
const skill = (name) => ({ name, summary: 'x', reason: null, matchCount: 1, suggested: true, license: 'MIT', links: { claude: 'missing', codex: 'missing' } });

function state(overrides = {}) {
  return {
    homeDirectory: HOME,
    version: '0.2.0',
    project: { root: `${HOME}/proyecto`, git: true, fromSubfolder: false, id: 'proyecto', displayName: 'Proyecto' },
    signals: [],
    skills: [skill('frontend-design')],
    agentsFound: { claude: true, codex: false, antigravity: false },
    globalSkills: { claude: { pending: 1, conflicts: 0 }, codex: { pending: 0, conflicts: 0 }, antigravity: { pending: 0, conflicts: 0 } },
    stableCopy: { needed: false },
    stableCommand: { state: 'falta' },
    memory: { existing: null, suggestedPath: VAULT, kinds: { [VAULT]: 'new' }, connections: {} },
    savedAnswers: null,
    internal: { linkRoot: `${HOME}/.nexakit/actual` },
    mods: MOD_STATES,
    ...overrides,
  };
}
const press = (model, ...keys) => keys.reduce((current, key) => handleSetupKey(current, key).model, model);
const frame = (model, columns = 100) => stripVTControlCharacters(renderSetupFrame(model, { columns, color: false }));
const toMods = (overrides) => press(createSetupModel(state(overrides)), '\r', '\r', '\r');

test('the mods step comes after the AI step and the header counts five steps', () => {
  const model = toMods();
  assert.equal(model.step, 'mods');
  assert.match(frame(model), /Paso 4 de 5 ●●●●○/u);
  assert.match(frame(model), /^◆  ¿Qué mods de Claude Code quieres\?$/mu);
  assert.match(frame(model), /^◇  IA: Claude Code$/mu);
  assert.match(frame(press(model, '\r')), /Paso 5 de 5 ●●●●●/u);
  assert.match(frame(press(model, '\r')), /^◇  Mods: 6 elegidos$/mu, 'the installed one counts as marked');
});

test('without Claude Code or a readable plugin list the assistant keeps four steps', () => {
  for (const overrides of [{ mods: null }, { agentsFound: { claude: false, codex: true, antigravity: false }, mods: null }]) {
    let model = createSetupModel(state(overrides));
    for (let i = 0; i < 3; i++) model = press(model, '\r');
    assert.equal(model.step, 'confirm');
    assert.match(frame(model), /Paso 4 de 4 ●●●●/u);
    assert.doesNotMatch(frame(model), /Mods/u);
  }
  const noClaude = press(createSetupModel(state({ agentsFound: { claude: true, codex: true, antigravity: false } })), '\r', '\r', ' ', '\r');
  assert.equal(noClaude.step, 'confirm', 'unchecking Claude Code in the AI step skips the mods step');
  assert.match(frame(noClaude), /Paso 4 de 4/u);
});

test('each row shows its box, aligned name, label and status in words', () => {
  const text = frame(toMods());
  // The state is a column of its own next to the name: a long description never pushes it to another line.
  assert.match(text, /^│ ❯ ◼ niveles {16}instalado {10}Subagentes por nivel para delegar$/mu);
  assert.match(text, /^│   ◼ nexakit-modelo {9}falta {14}Barra con modelo, esfuerzo y consejo$/mu);
  assert.match(text, /^│   ◼ nexakit-ahorro {9}hay versión nueva {2}Recorta la salida larga de comandos$/mu);
  assert.match(text, /^│   ◼ nexakit-lecciones {6}desactivado {8}Frena errores y guarda correcciones$/mu);
  assert.match(text, /^│   ◼ nexakit-guardarrailes {2}falta {14}Frena comandos peligrosos, secretos y commits\n│ {5}mal escritos$/mu);
  assert.match(text, /^│  Los mods cambian cómo trabaja Claude Code en todos tus proyectos\.$/mu);
  assert.match(text, /^│  Se instalan con tu cuenta y se quitan desde \/plugin\.$/mu);
  assert.match(text, /espacio marcar · Enter seguir · ← volver · q salir/u);
});

test('space unchecks an offered mod, an installed one cannot be unchecked, and Enter remembers the discarded', () => {
  let model = toMods();
  const installed = press(model, '\x1b[A', ' ');
  assert.match(frame(installed), /Ya está instalado; se quita desde \/plugin en Claude Code/u);
  assert.match(frame(installed), /◼ niveles/u);
  assert.equal(installed.answers.mods.chosen.includes('niveles'), false, 'nothing changed in the answers');
  model = press(model, '\x1b[B', '\x1b[B', ' ');
  assert.equal(model.answers.mods.chosen.includes('nexakit-ahorro'), false);
  assert.match(frame(model), /◻ nexakit-ahorro/u);
  model = press(model, '\r');
  assert.deepEqual(model.answers.mods.discarded, ['nexakit-ahorro']);
  assert.equal(model.step, 'confirm');
  const text = frame(model);
  assert.doesNotMatch(text, /Actualizar el mod nexakit-ahorro/u);
  assert.match(text, /\+ Mod nexakit-modelo en Claude Code/u);
  assert.match(text, /Activar el mod nexakit-lecciones/u);
  assert.match(text, /✓ Mods activos en Claude Code: niveles/u);
  assert.equal(press(model, '\x7f').step, 'mods', 'back from the confirmation returns to the mods');
  assert.equal(press(toMods(), '\x7f').step, 'agents', 'back from the mods returns to the AI step');
});

test('the confirmation groups its lines under four headings, only the ones with lines', () => {
  const text = frame(press(toMods(), '\r'));
  const rows = text.split('\n').filter((line) => /^│ (Proyecto|Tus IA|Mods de Claude Code|Memoria)$/u.test(line));
  assert.deepEqual(rows, ['│ Proyecto', '│ Tus IA', '│ Mods de Claude Code', '│ Memoria']);
  assert.match(text, /^│ Mods de Claude Code\n│   \+ Mod nexakit-modelo en Claude Code$/mu);
  assert.ok(text.indexOf('│ Mods de Claude Code') < text.indexOf('│ Memoria'));
  const later = createSetupModel(state());
  later.answers = { ...later.answers, memory: { decision: 'later' } };
  const sparse = frame(press({ ...later, step: 'agents' }, '\r', '\r'));
  assert.doesNotMatch(sparse, /^│ Memoria$/mu, 'a section without lines has no heading');
});

test('the menu offers «Mods de Claude Code» when everything is ready and Claude Code is there', () => {
  const allActive = Object.fromEntries(Object.keys(MOD_STATES).map((name) => [name, 'activo']));
  const answers = { version: 1, skills: { chosen: [], discarded: ['frontend-design'] }, agents: ['claude'], memory: { decision: 'later' }, mods: { chosen: [], discarded: [] } };
  const ready = state({ mods: allActive, savedAnswers: answers, stableCommand: { state: 'igual' }, globalSkills: { claude: { pending: 0, conflicts: 0 }, codex: { pending: 0, conflicts: 0 }, antigravity: { pending: 0, conflicts: 0 } } });
  const model = createSetupModel(ready);
  assert.equal(model.step, 'menu');
  assert.match(frame(model), /○ Mods de Claude Code/u);
  const mods = press(model, '\x1b[B', '\x1b[B', '\x1b[B', '\r');
  assert.equal(mods.step, 'mods');
  assert.equal(press(mods, '\r').step, 'confirm', 'from the menu the mods go straight to the confirmation');
  assert.equal(press(mods, '\x7f').step, 'menu');
  const without = createSetupModel({ ...ready, mods: null });
  assert.doesNotMatch(frame(without), /Mods de Claude Code/u);
});

test('the mods screen and the grouped confirmation fit 40, 68 and 100 columns', () => {
  const mods = toMods();
  for (const model of [mods, press(mods, '\r'), press(mods, '\r', 'd'), press(mods, '\x1b[A', ' ')]) {
    for (const columns of [40, 68, 100]) {
      for (const line of frame(model, columns).split('\n')) assert.ok(cellWidth(line) <= columns, `@${columns}: «${line}»`);
    }
  }
});
