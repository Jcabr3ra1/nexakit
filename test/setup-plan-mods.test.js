import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildConfirmation, suggestedAnswers } from '../src/setup-plan.js';

const HOME = '/home/juan';
const VAULT = `${HOME}/memorias/proyecto`;
const ready = { pending: 0, conflicts: 0 };

function project(overrides = {}) {
  return {
    homeDirectory: HOME,
    version: '0.2.0',
    project: { root: `${HOME}/proyecto`, git: true, fromSubfolder: false, id: 'proyecto', displayName: 'Proyecto' },
    signals: [],
    skills: [{ name: 'frontend-design', summary: 'x', reason: null, matchCount: 1, suggested: true, links: { claude: 'missing', codex: 'missing' } }],
    agentsFound: { claude: true, codex: true, antigravity: false },
    globalSkills: { claude: { pending: 3, conflicts: 0 }, codex: ready, antigravity: ready },
    stableCopy: { needed: false },
    stableCommand: { state: 'falta' },
    memory: { existing: null, suggestedPath: VAULT, kinds: { [VAULT]: 'new' }, connections: {} },
    savedAnswers: null,
    ...overrides,
  };
}
const marks = (confirmation) => confirmation.lines.map((line) => `${line.mark} ${line.text}`);
const blockIds = (confirmation) => confirmation.blocks.map((block) => block.id);
const isMod = (line) => /\bmods?\b/iu.test(line);
const MOD_STATES = {
  niveles: 'activo',
  'nexakit-modelo': 'falta',
  'nexakit-ahorro': 'actualizable',
  'nexakit-lecciones': 'desactivado',
  'nexakit-sesion': 'activo',
  'nexakit-guardarrailes': 'falta',
};
const UNKNOWN = Object.fromEntries(Object.keys(MOD_STATES).map((name) => [name, 'desconocido']));

test('mods: by default every mod that is neither active nor unknown is chosen, and none without Claude Code', () => {
  assert.deepEqual(suggestedAnswers(project({ mods: MOD_STATES })).mods, {
    chosen: ['nexakit-modelo', 'nexakit-ahorro', 'nexakit-lecciones', 'nexakit-guardarrailes'],
    discarded: [],
  });
  assert.deepEqual(suggestedAnswers(project({ mods: UNKNOWN })).mods.chosen, []);
  const noClaude = project({ mods: MOD_STATES, agentsFound: { claude: false, codex: true, antigravity: false } });
  assert.deepEqual(suggestedAnswers(noClaude).mods.chosen, []);
  assert.equal(suggestedAnswers(project()).mods, undefined, 'without a mods state the answers carry no mods');
});

test('mods: a discarded mod is not suggested again, and answers saved before the mods step still work', () => {
  const base = { version: 1, skills: { chosen: [], discarded: [] }, agents: ['claude'], memory: { decision: 'later' } };
  const saved = { ...base, mods: { chosen: [], discarded: ['nexakit-ahorro'] } };
  assert.deepEqual(suggestedAnswers(project({ mods: MOD_STATES, savedAnswers: saved })).mods, {
    chosen: ['nexakit-modelo', 'nexakit-lecciones', 'nexakit-guardarrailes'],
    discarded: ['nexakit-ahorro'],
  });
  assert.deepEqual(suggestedAnswers(project({ mods: MOD_STATES, savedAnswers: base })).mods, {
    chosen: ['nexakit-modelo', 'nexakit-ahorro', 'nexakit-lecciones', 'nexakit-guardarrailes'],
    discarded: [],
  });
});

test('mods: install, update and enable lines, one block per mod, after Superpowers and before the memory', () => {
  const state = project({ mods: MOD_STATES, superpowers: { claude: 'falta' } });
  const confirmation = buildConfirmation(state, suggestedAnswers(state));
  assert.deepEqual(marks(confirmation).filter(isMod), [
    '+ Mod nexakit-modelo en Claude Code',
    '↻ Actualizar el mod nexakit-ahorro',
    '↻ Activar el mod nexakit-lecciones',
    '+ Mod nexakit-guardarrailes en Claude Code',
    '✓ Mods activos en Claude Code: niveles y nexakit-sesion',
  ]);
  const ids = blockIds(confirmation);
  assert.deepEqual(ids.filter((id) => id.startsWith('mod:')), ['mod:nexakit-modelo', 'mod:nexakit-ahorro', 'mod:nexakit-lecciones', 'mod:nexakit-guardarrailes']);
  assert.ok(ids.indexOf('mod:nexakit-modelo') > ids.indexOf('superpowers:claude'));
  assert.ok(ids.indexOf('mod:nexakit-guardarrailes') < ids.indexOf('memory-init'));
  assert.equal(confirmation.blocks.find((block) => block.id === 'mod:nexakit-modelo').label, 'Mod nexakit-modelo');
});

test('mods: an unchosen mod is left alone, an unknown state is one warning, and no Claude means no mod lines', () => {
  const state = project({ mods: MOD_STATES });
  const answers = { ...suggestedAnswers(state), mods: { chosen: ['nexakit-modelo'], discarded: [] } };
  assert.deepEqual(blockIds(buildConfirmation(state, answers)).filter((id) => id.startsWith('mod:')), ['mod:nexakit-modelo']);
  const unknown = project({ mods: UNKNOWN });
  assert.deepEqual(marks(buildConfirmation(unknown, suggestedAnswers(unknown))).filter(isMod), [
    '! No pude comprobar los mods de Claude Code; revisa /plugin',
  ]);
  const codexOnly = { ...suggestedAnswers(state), agents: ['codex'] };
  assert.equal(marks(buildConfirmation(state, codexOnly)).some(isMod), false);
  const none = project({ mods: null });
  assert.equal(marks(buildConfirmation(none, suggestedAnswers(none))).some(isMod), false);
});

test('every line carries its section, and the existing lines keep their order inside it', () => {
  const state = project({ mods: MOD_STATES, superpowers: { claude: 'falta' } });
  const confirmation = buildConfirmation(state, suggestedAnswers(state));
  const sectionOf = (text) => confirmation.lines.find((line) => line.text.startsWith(text)).section;
  assert.equal(sectionOf('Orden nexakit'), 'proyecto');
  assert.equal(sectionOf('1 skill en el proyecto'), 'proyecto');
  assert.equal(sectionOf('3 skills base en Claude Code'), 'ia');
  assert.equal(sectionOf('Superpowers en Claude Code'), 'ia');
  assert.equal(sectionOf('Mod nexakit-modelo'), 'mods');
  assert.equal(sectionOf('Mods activos'), 'mods');
  assert.equal(sectionOf('Memoria nueva'), 'memoria');
  assert.equal(sectionOf('Conectar la memoria'), 'memoria');
  assert.ok(confirmation.lines.every((line) => ['proyecto', 'ia', 'mods', 'memoria'].includes(line.section)));
});

test('saved answers without mods do not count as changed when nothing about the mods changed', () => {
  const state = project({ mods: { ...MOD_STATES, 'nexakit-modelo': 'activo', 'nexakit-ahorro': 'activo', 'nexakit-lecciones': 'activo', 'nexakit-guardarrailes': 'activo' } });
  const base = { version: 1, skills: { chosen: ['frontend-design'], discarded: [] }, agents: ['claude'], memory: { decision: 'later' } };
  const answers = suggestedAnswers({ ...state, savedAnswers: base });
  const confirmation = buildConfirmation({ ...state, savedAnswers: base }, answers);
  assert.equal(blockIds(confirmation).includes('answers'), false);
});
