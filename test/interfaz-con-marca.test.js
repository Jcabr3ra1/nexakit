import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stripVTControlCharacters } from 'node:util';
import { colorLevel, LOGO_WIDTH, logoArt, paint, renderLogo } from '../src/brand.js';
import { createSetupModel, handleSetupKey, renderSetupFrame } from '../src/setup-tui.js';
import { cellWidth } from '../src/terminal-text.js';

const HOME = '/home/usuario';
const VAULT = `${HOME}/Obsidian/PROYECTO-MEMORY`;
const TAGLINE = 'Tus skills. Tu memoria. Tus IA trabajando juntas.';
const skill = (name, suggested, reason = null) => ({ name, summary: `Qué hace ${name}.`, reason,
  matchCount: suggested ? 1 : 0, suggested, license: 'MIT', links: { claude: 'missing', codex: 'missing' } });
const state = () => ({
  homeDirectory: HOME, version: '0.2.0',
  project: { root: `${HOME}/Proyectos/mi-app`, git: true, fromSubfolder: false, id: 'mi-app', displayName: 'Mi App' },
  signals: [{ id: 'react', label: 'React' }, { id: 'nodejs', label: 'Node.js' }],
  skills: [skill('frontend-design', true, 'frontend usa React'), skill('webapp-testing', false)],
  agentsFound: { claude: true, codex: true, antigravity: false },
  globalSkills: { claude: { pending: 0, conflicts: 0 }, codex: { pending: 0, conflicts: 0 }, antigravity: { pending: 0, conflicts: 0 } },
  stableCopy: { needed: false }, stableCommand: { state: 'falta' },
  memory: { existing: null, suggestedPath: VAULT, kinds: { [VAULT]: 'new' }, connections: {} },
  savedAnswers: null, internal: { linkRoot: `${HOME}/.nexakit/actual` },
});
const press = (model, ...keys) => keys.reduce((current, key) => handleSetupKey(current, key).model, model);
const plain = (text) => stripVTControlCharacters(text);
const LEVELS = ['none', '16', '256', 'truecolor'];
const FACE = '38;2;236;232;244';
const SHADOW = '38;2;62;48;110';
const ART = [
  '█▄  █ █▀▀▀▀ █   █ ▄▀▀▀▄ █  ▄▀ ▀▀█▀▀ ▀▀█▀▀',
  '█ ▀▄█ █▄▄▄   ▀▄▀  █▄▄▄█ █▄▀     █     █',
  '█   █ █     ▄▀ ▀▄ █   █ █ ▀▄    █     █',
  '▀   ▀ ▀▀▀▀▀ ▀   ▀ ▀   ▀ ▀   ▀ ▀▀▀▀▀   ▀',
];

test('el nivel de color respeta terminal interactiva, NO_COLOR y lo que anuncia la terminal', () => {
  const tty = { isTTY: true };
  assert.equal(colorLevel({ isTTY: false }, { COLORTERM: 'truecolor' }), 'none');
  assert.equal(colorLevel(tty, { NO_COLOR: '1', COLORTERM: 'truecolor' }), 'none');
  assert.equal(colorLevel(tty, { TERM: 'dumb' }), 'none');
  assert.equal(colorLevel(tty, { COLORTERM: 'truecolor', TERM: 'xterm' }), 'truecolor');
  assert.equal(colorLevel(tty, { COLORTERM: '24bit' }), 'truecolor');
  assert.equal(colorLevel(tty, { TERM: 'xterm-256color' }), '256');
  assert.equal(colorLevel(tty, { TERM: 'xterm' }), '16');
});

test('el logo son 4 filas de medios bloques y cabe en 42 columnas', () => {
  assert.deepEqual(logoArt(), ART);
  assert.equal(LOGO_WIDTH, 42);
  for (const level of ['16', '256', 'truecolor']) {
    const rows = renderLogo(level);
    assert.equal(rows.length, 4, level);
    for (const row of rows) assert.ok(cellWidth(plain(row)) <= LOGO_WIDTH, `${level}: «${plain(row)}»`);
  }
  assert.equal(renderLogo('none'), null, 'sin color se usa la cabecera de una línea');
});

test('el logo lleva la cara clara y la sombra morada, y baja de colores sin perder la forma', () => {
  const truecolor = renderLogo('truecolor').join('\n');
  assert.ok(truecolor.includes(FACE) && truecolor.includes(SHADOW));
  const palette256 = renderLogo('256').join('\n');
  assert.match(palette256, /38;5;\d+/u);
  assert.doesNotMatch(palette256, /38;2;/u);
  const basic = renderLogo('16').join('\n');
  assert.doesNotMatch(basic, /38;[25];/u);
  for (const level of ['16', '256', 'truecolor']) {
    assert.match(plain(renderLogo(level).join('')), /█/u, level);
  }
});

test('la paleta es neutra sin color y distinta en cada nivel', () => {
  assert.equal(paint('none').accent('hola'), 'hola');
  assert.equal(paint('none').chip('React'), 'React');
  assert.notEqual(paint('truecolor').accent('x'), paint('256').accent('x'));
  assert.notEqual(paint('256').accent('x'), paint('16').accent('x'));
  assert.equal(plain(paint('truecolor').chip('React')), ' React ');
});

test('la primera pantalla enseña logo, lema y el paso en que vas', () => {
  const text = plain(renderSetupFrame(createSetupModel(state()), { columns: 80, rows: 40, color: 'truecolor' }));
  for (const row of renderLogo('truecolor')) assert.ok(text.includes(plain(row)), plain(row));
  assert.ok(text.includes(TAGLINE));
  assert.match(text, /Paso 1 de 4/u);
  assert.match(text, /v0\.2\.0/u);
});

test('si no cabe, la cabecera es de una línea: terminal estrecha, baja o sin color', () => {
  const model = createSetupModel(state());
  const narrow = plain(renderSetupFrame(model, { columns: 40, rows: 40, color: 'truecolor' }));
  const short = plain(renderSetupFrame(model, { columns: 80, rows: 12, color: 'truecolor' }));
  for (const text of [narrow, short]) {
    assert.ok(!text.includes('█▄  █'), 'sin logo');
    assert.match(text, /nexakit/iu);
    assert.match(text, /Paso 1 de 4/u);
  }
  const none = renderSetupFrame(model, { columns: 100, rows: 40, color: 'none' });
  assert.doesNotMatch(none, /\x1b/u, 'sin color no hay ninguna secuencia de escape');
  assert.ok(none.startsWith('◆ nexakit v0.2.0'));
  assert.match(none, /Paso 1 de 4/u);
});

test('el color antiguo true/false sigue funcionando', () => {
  const model = createSetupModel(state());
  assert.doesNotMatch(renderSetupFrame(model, { columns: 80, color: false }), /\x1b/u);
  assert.match(renderSetupFrame(model, { columns: 80, color: true }), /\x1b\[/u);
});

test('las demás preguntas llevan solo la cabecera compacta con su paso', () => {
  const model = createSetupModel(state());
  const steps = [['memory', 2], ['agents', 3], ['confirm', 4]];
  let current = model;
  for (const [step, number] of steps) {
    current = press(current, '\r');
    assert.equal(current.step, step);
    const text = plain(renderSetupFrame(current, { columns: 100, rows: 50, color: 'truecolor' }));
    assert.match(text, new RegExp(`Paso ${number} de 4`, 'u'), step);
    assert.ok(!text.includes('█▄  █'), `${step}: sin logo`);
  }
});

test('la tecnología detectada sale como etiquetas con color y como texto sin él', () => {
  const model = createSetupModel(state());
  assert.match(plain(renderSetupFrame(model, { columns: 100, rows: 50, color: 'truecolor' })), /Detecté: +React +Node\.js/u);
  assert.ok(plain(renderSetupFrame(model, { columns: 100, rows: 50, color: 'truecolor' })).includes(' React '));
  assert.ok(renderSetupFrame(model, { columns: 100, rows: 50, color: 'none' }).includes('Detecté: React · Node.js'));
});

test('la pantalla final celebra con el logo solo si todo salió bien', () => {
  const base = press(createSetupModel(state()), '\r', '\r', '\r');
  const ok = { ...base, step: 'done', progress: [{ phase: 'done', label: 'Skills listas' }], result: { ok: true, finalCheck: { ok: true, message: 'todo en orden' } } };
  const bad = { ...ok, result: { ok: false, failed: { message: 'algo falló' } } };
  const good = plain(renderSetupFrame(ok, { columns: 80, rows: 50, color: 'truecolor' }));
  assert.ok(good.includes('█▄  █') && good.includes('Listo'));
  const failed = plain(renderSetupFrame(bad, { columns: 80, rows: 50, color: 'truecolor' }));
  assert.ok(!failed.includes('█▄  █'));
  assert.match(failed, /Se detuvo aquí/u);
});

test('si todo ya está listo, el menú también enseña el logo y no cuenta pasos', () => {
  const ready = state();
  ready.savedAnswers = null;
  const model = createSetupModel(ready);
  const menu = { ...model, step: 'menu', flow: 'menu' };
  const text = plain(renderSetupFrame(menu, { columns: 80, rows: 50, color: 'truecolor' }));
  assert.ok(text.includes('█▄  █'));
  assert.doesNotMatch(text, /Paso \d de 4/u);
});

test('ninguna combinación de nivel, ancho y alto desborda el ancho ni empuja el alto', () => {
  const screens = [];
  let model = createSetupModel(state());
  for (const step of ['skills', 'memory', 'agents', 'confirm']) {
    screens.push([step, model]);
    model = press(model, '\r');
  }
  for (const [name, current] of screens) {
    for (const level of LEVELS) {
      for (const columns of [30, 40, 44, 53, 68, 100]) {
        for (const rows of [undefined, 14, 24, 50]) {
          const text = renderSetupFrame(current, { columns, rows, color: level });
          const lines = plain(text).split('\n');
          for (const line of lines) assert.ok(cellWidth(line) <= Math.max(30, columns - 1), `${name} ${level} @${columns}: «${line}»`);
          if (rows) {
            const without = plain(renderSetupFrame(current, { columns, rows, color: 'none' })).split('\n').length;
            assert.ok(lines.length <= Math.max(rows - 1, without), `${name} ${level} @${columns}x${rows}: ${lines.length} filas`);
          }
        }
      }
    }
  }
});

test('la pantalla final concuerda el singular y el plural de las skills', () => {
  const base = press(createSetupModel(state()), '\r', '\r', '\r');
  const done = (chosen) => ({ ...base, step: 'done', answers: { ...base.answers, skills: { chosen, discarded: [] } },
    progress: [], result: { ok: true, finalCheck: { ok: true, message: 'ok' } } });
  const one = plain(renderSetupFrame(done(['frontend-design']), { columns: 100, color: 'none' }));
  const two = plain(renderSetupFrame(done(['frontend-design', 'webapp-testing']), { columns: 100, color: 'none' }));
  assert.match(one, /1 skill ·/u);
  assert.doesNotMatch(one, /1 skills/u);
  assert.match(two, /2 skills ·/u);
});
