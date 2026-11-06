import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildConfirmation, shortReason, suggestedAnswers } from '../src/setup-plan.js';

const HOME = '/home/juan';
const VAULT = `${HOME}/programacion/Obsidian-Vaults/PUNTO-MOTOS-MEMORY`;
const skill = (name, { suggested = false, claude = 'missing', codex = 'missing', reason = null } = {}) =>
  ({ name, summary: `Qué hace ${name}.`, reason, matchCount: suggested ? 1 : 0, suggested, links: { claude, codex } });
const ready = { pending: 0, conflicts: 0 };

// Punto Motos the first time: nothing installed, Claude and Codex found, a memory to create next to the others.
function puntoMotos(overrides = {}) {
  return {
    homeDirectory: HOME,
    version: '0.2.0',
    project: { root: `${HOME}/programacion/Proyectos/Punto_Motos`, git: true, fromSubfolder: false, id: 'punto-motos', displayName: 'Punto Motos' },
    signals: [{ id: 'react', label: 'React' }, { id: 'django', label: 'Django' }],
    skills: [
      skill('api-design-principles', { suggested: true, reason: 'backend usa Django' }),
      skill('frontend-design', { suggested: true, reason: 'frontend usa React' }),
      skill('differential-review'),
      skill('webapp-testing')
    ],
    agentsFound: { claude: true, codex: true, antigravity: false },
    globalSkills: { claude: { pending: 21, conflicts: 0 }, codex: { pending: 21, conflicts: 0 }, antigravity: { pending: 21, conflicts: 0 } },
    stableCopy: { needed: false },
    stableCommand: { state: 'falta' },
    memory: { existing: null, suggestedPath: VAULT, kinds: { [VAULT]: 'new' }, connections: {} },
    savedAnswers: null,
    ...overrides
  };
}
const marks = confirmation => confirmation.lines.map(line => `${line.mark} ${line.text}`);
const blockIds = confirmation => confirmation.blocks.map(block => block.id);

test('the suggested answers: suggested skills, the agents found and a new memory next to the others', () => {
  assert.deepEqual(suggestedAnswers(puntoMotos()), {
    version: 1,
    skills: { chosen: ['api-design-principles', 'frontend-design'], discarded: [] },
    agents: ['claude', 'codex'],
    memory: { decision: 'path', path: VAULT }
  });
});

test('first run in Punto Motos: short lines in a fixed order, and the blocks to apply', () => {
  const state = puntoMotos();
  const confirmation = buildConfirmation(state, suggestedAnswers(state));
  assert.deepEqual(marks(confirmation), [
    '+ Orden nexakit para tus IA',
    '+ 2 skills en el proyecto (ignoradas en Git)',
    '+ 21 skills base en Claude Code',
    '+ 21 skills base en Codex',
    '+ Memoria nueva en ~/programacion/Obsidian-Vaults/PUNTO-MOTOS-MEMORY',
    '+ Conectar la memoria a Claude Code y Codex'
  ]);
  assert.deepEqual(blockIds(confirmation), ['answers', 'stable-command', 'project-skills', 'global-skills:claude', 'global-skills:codex',
    'memory-init', 'memory-connect:claude', 'memory-connect:codex', 'final-check'], 'answers are saved before anything that can fail');
  assert.equal(confirmation.allReady, false);
});

test('running from npx first prepares the stable copy', () => {
  const state = puntoMotos({ stableCopy: { needed: true } });
  const confirmation = buildConfirmation(state, suggestedAnswers(state));
  assert.equal(confirmation.blocks[1].id, 'stable-copy', 'right after saving the answers');
  assert.equal(marks(confirmation)[0], '+ Copia estable de nexakit en ~/.nexakit');
});

test('everything ready: no pending lines, no blocks', () => {
  const answers = { version: 1, skills: { chosen: ['frontend-design'], discarded: ['api-design-principles'] }, agents: ['claude', 'codex'], memory: { decision: 'path', path: VAULT } };
  const state = puntoMotos({
    skills: [skill('api-design-principles', { suggested: true }), skill('frontend-design', { suggested: true, claude: 'installed', codex: 'installed' })],
    globalSkills: { claude: ready, codex: ready, antigravity: { pending: 21, conflicts: 0 } },
    stableCommand: { state: 'igual' },
    memory: { existing: { vaultPath: VAULT }, suggestedPath: VAULT, kinds: { [VAULT]: 'memory' }, connections: { [VAULT]: { claude: 'unchanged', codex: 'unchanged' } } },
    savedAnswers: answers
  });
  const confirmation = buildConfirmation(state, suggestedAnswers(state));
  assert.equal(confirmation.allReady, true, marks(confirmation).join('\n'));
  assert.deepEqual(confirmation.blocks, []);
  assert.ok(confirmation.lines.every(line => line.mark === '✓'));
});

test('one agent disconnected by hand: only that connection is pending', () => {
  const answers = { version: 1, skills: { chosen: [], discarded: [] }, agents: ['claude', 'codex'], memory: { decision: 'path', path: VAULT } };
  const state = puntoMotos({
    skills: [],
    globalSkills: { claude: ready, codex: ready, antigravity: ready },
    stableCommand: { state: 'igual' },
    memory: { existing: { vaultPath: VAULT }, suggestedPath: VAULT, kinds: { [VAULT]: 'memory' }, connections: { [VAULT]: { claude: 'unchanged', codex: 'create' } } },
    savedAnswers: answers
  });
  const confirmation = buildConfirmation(state, suggestedAnswers(state));
  assert.deepEqual(marks(confirmation).filter(line => !line.startsWith('✓')), ['+ Conectar la memoria a Codex']);
  assert.deepEqual(blockIds(confirmation), ['memory-connect:codex', 'final-check'], 'unchanged answers are not written again');
});

test('a discarded suggestion is not pending, but a new suggestion is offered', () => {
  const saved = { version: 1, skills: { chosen: [], discarded: ['frontend-design'] }, agents: ['claude'], memory: { decision: 'later' } };
  const state = puntoMotos({
    skills: [skill('frontend-design', { suggested: true }), skill('api-design-principles', { suggested: true })],
    globalSkills: { claude: ready, codex: ready, antigravity: ready },
    stableCommand: { state: 'igual' },
    savedAnswers: saved
  });
  const answers = suggestedAnswers(state);
  assert.deepEqual(answers.skills, { chosen: ['api-design-principles'], discarded: ['frontend-design'] });
  assert.deepEqual(marks(buildConfirmation(state, answers)), ['+ 1 skill en el proyecto (ignorada en Git)']);
});

test('unchecking an installed skill removes it; a user folder is a conflict that is left alone', () => {
  const state = puntoMotos({
    skills: [skill('frontend-design', { claude: 'installed', codex: 'installed' }), skill('webapp-testing', { suggested: true, claude: 'conflict' })],
    globalSkills: { claude: ready, codex: ready, antigravity: ready },
    stableCommand: { state: 'igual' }
  });
  const answers = { version: 1, skills: { chosen: ['webapp-testing'], discarded: ['frontend-design'] }, agents: ['claude', 'codex'], memory: { decision: 'later' } };
  const confirmation = buildConfirmation(state, answers);
  assert.deepEqual(marks(confirmation), [
    '+ 1 skill en el proyecto (ignorada en Git)',
    '− Quitar 1 skill del proyecto',
    '! webapp-testing: ya hay una carpeta tuya con ese nombre en .claude/skills; no la toco'
  ]);
  assert.deepEqual(confirmation.removeSkills, ['frontend-design']);
});

test('a memory MCP with the same name elsewhere is a ! line and the rest still applies', () => {
  const state = puntoMotos({
    memory: { existing: { vaultPath: VAULT }, suggestedPath: VAULT, kinds: { [VAULT]: 'memory' },
      connections: { [VAULT]: { claude: 'conflict', codex: 'create', antigravity: 'unavailable' } } }
  });
  const answers = { ...suggestedAnswers(state), agents: ['claude', 'codex', 'antigravity'] };
  const lines = marks(buildConfirmation(state, answers));
  assert.ok(lines.includes('! Claude Code ya tiene otra memoria con el mismo nombre; no la toco'), lines.join('\n'));
  assert.ok(lines.includes('! No encontré Antigravity; no puedo conectarle la memoria'));
  assert.ok(lines.includes('+ Conectar la memoria a Codex'));
  assert.ok(blockIds(buildConfirmation(state, answers)).includes('memory-connect:codex'));
  assert.ok(!blockIds(buildConfirmation(state, answers)).includes('memory-connect:claude'));
});

test('without Git the memory is later and no memory block is planned', () => {
  const state = puntoMotos({ project: { ...puntoMotos().project, git: false } });
  const answers = suggestedAnswers(state);
  assert.deepEqual(answers.memory, { decision: 'later' });
  assert.ok(!blockIds(buildConfirmation(state, answers)).some(id => id.startsWith('memory-')));
});

test('no line uses jargon or an absolute path', () => {
  const state = puntoMotos({ stableCopy: { needed: true } });
  for (const line of buildConfirmation(state, suggestedAnswers(state)).lines) {
    assert.doesNotMatch(line.text, /SHA|escenario|integridad|(^|\s)\//u, line.text);
  }
});

test('short reasons say which folder uses what', () => {
  assert.equal(shortReason('React', 'frontend/package.json (react)'), 'frontend usa React');
  assert.equal(shortReason('Django', 'backend/manage.py'), 'backend usa Django');
  assert.equal(shortReason('React', 'package.json (react)'), 'el proyecto usa React');
  assert.equal(shortReason('Tauri', 'README.md'), 'el README menciona Tauri');
  assert.equal(shortReason('Tauri', 'desktop/README.md'), 'desktop/README menciona Tauri');
});

test('saving the answers is announced when no project skill is written', () => {
  const state = puntoMotos({ skills: [], stableCommand: { state: 'igual' } });
  const answers = { ...suggestedAnswers(state), memory: { decision: 'later' } };
  const confirmation = buildConfirmation(state, answers);
  assert.ok(marks(confirmation).includes('+ Guardar tus respuestas en .agent-toolkit (ignorado en Git)'));
  assert.ok(blockIds(confirmation).includes('answers'));
});

test('home paths are shortened with either separator', async () => {
  const { shortPath } = await import('../src/setup-plan.js');
  assert.equal(shortPath('/home/juan/x/y', '/home/juan'), '~/x/y');
  assert.equal(shortPath('C:\\Users\\juan\\x', 'C:\\Users\\juan'), '~\\x');
  assert.equal(shortPath('/home/juanito/x', '/home/juan'), '/home/juanito/x');
});

test('confirmation explicitly announces global work rules for the selected IAs', () => {
  const state = puntoMotos({ reviewInstructions: { items: [
    {client:'claude',name:'CLAUDE.md',state:'pending'},
    {client:'codex',name:'AGENTS.md',state:'pending'},
    {client:'antigravity',name:'GEMINI.md',state:'pending'}
  ] } });
  const confirmation = buildConfirmation(state, suggestedAnswers(state));
  assert.ok(marks(confirmation).includes('+ Reglas de trabajo en tus instrucciones de Claude Code y Codex'));
  assert.ok(blockIds(confirmation).includes('review-instructions'));
});

test('Superpowers is required: installs it where it is missing, enables it where it is off, after the base skills', () => {
  const state = puntoMotos({
    agentsFound: { claude: true, codex: true, antigravity: true },
    superpowers: { claude: 'falta', codex: 'activo', antigravity: 'desactivado' },
  });
  const answers = { ...suggestedAnswers(state), agents: ['claude', 'codex', 'antigravity'] };
  const confirmation = buildConfirmation(state, answers);
  assert.ok(marks(confirmation).includes('+ Superpowers en Claude Code'));
  assert.ok(marks(confirmation).includes('↻ Activar Superpowers en Antigravity'));
  assert.ok(marks(confirmation).includes('✓ Superpowers activo en Codex'));
  const ids = blockIds(confirmation);
  assert.deepEqual(ids.filter(id => id.startsWith('superpowers:')), ['superpowers:claude', 'superpowers:antigravity']);
  assert.ok(ids.indexOf('superpowers:claude') > ids.indexOf('global-skills:antigravity'));
});

test('Superpowers: nothing to do when it is active everywhere; Codex off or unknown is a warning, not a block', () => {
  const active = puntoMotos({ superpowers: { claude: 'activo', codex: 'activo' }, globalSkills: { claude: ready, codex: ready, antigravity: ready } });
  const done = buildConfirmation(active, suggestedAnswers(active));
  assert.ok(marks(done).includes('✓ Superpowers activo en Claude Code y Codex'));
  assert.equal(blockIds(done).some(id => id.startsWith('superpowers:')), false);

  const off = puntoMotos({ superpowers: { claude: 'desconocido', codex: 'desactivado' } });
  const warned = buildConfirmation(off, suggestedAnswers(off));
  assert.ok(marks(warned).includes('! No pude comprobar Superpowers en Claude Code; revisa /plugin'));
  assert.ok(marks(warned).includes('! Superpowers está desactivado en Codex; actívalo desde /plugins'));
  assert.equal(blockIds(warned).some(id => id.startsWith('superpowers:')), false);
});

test('Superpowers: an agent not chosen or not found is left alone', () => {
  const state = puntoMotos({ superpowers: { claude: 'falta', codex: 'falta' } });
  const confirmation = buildConfirmation(state, { ...suggestedAnswers(state), agents: ['claude'] });
  assert.deepEqual(blockIds(confirmation).filter(id => id.startsWith('superpowers:')), ['superpowers:claude']);
});
