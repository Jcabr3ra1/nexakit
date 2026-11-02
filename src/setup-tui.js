// `npx nexakit`: three questions with the answer already suggested (skills, memory, agents) and one confirmation,
// in the style of `npm create vite`. Answered questions fold into one ◇ line; the active one uses ◆. The model,
// the drawing and the keys are pure, so every screen is tested as text; runSetupTui is the only part with I/O.
import os from 'node:os';
import path from 'node:path';
import { applySetup } from './setup-apply.js';
import { AGENTS, AGENT_NAMES, buildConfirmation, joinNames, shortPath, suggestedAnswers } from './setup-plan.js';
import { gatherSetupState, inspectMemoryPath, memoryConnections } from './setup-state.js';
import { applyToolkitDetach, planToolkitDetach } from './skill-recommendations.js';
import { cellWidth, fitLine, style, wrapText } from './terminal-text.js';

const KEYS = Object.freeze({
  up: ['\x1b[A', 'k'], down: ['\x1b[B', 'j'], toggle: [' '], enter: ['\r', '\n'],
  back: ['\x7f', '\x08', '\x1b[D'], left: ['\x1b[D'], right: ['\x1b[C'], quit: ['q', 'Q', '\x03']
});
const is = (key, name) => KEYS[name].includes(key);
const MENU = Object.freeze([
  ['exit', 'No, salir'], ['skills', 'Añadir o quitar skills'], ['agents', 'Cambiar agentes'], ['detach', 'Quitar nexakit de este proyecto']
]);
const MAX_DETECTED = 4;
// Languages and generic signals go after the frameworks the person will recognise.
const GENERIC_SIGNALS = new Set(['nodejs', 'python', 'rust', 'rest-api', 'vitest', 'mcp-sdk']);
const detectedLabels = signals => [...signals]
  .sort((a, b) => GENERIC_SIGNALS.has(a.id) - GENERIC_SIGNALS.has(b.id) || a.label.localeCompare(b.label))
  .map(signal => signal.label);

// ── Model ────────────────────────────────────────────────────────────────────────────────────────────────────────

function memoryOptions(model) {
  const { state } = model;
  if (!state.project.git) return ['later'];
  return [state.memory.existing ? 'existing' : 'suggested', 'other', 'later'];
}

// Skills shown before "ver N más…": the suggested ones and any already chosen or installed.
function visibleSkills(model) {
  const { state, answers, expanded } = model;
  if (expanded) return state.skills;
  return state.skills.filter(skill => skill.suggested || answers.skills.chosen.includes(skill.name) ||
    Object.values(skill.links ?? {}).includes('installed'));
}
// What the info view says about trust: untested skills say so, and review observations are shown as written.
function skillTrust(skill) {
  const lines = [];
  if (skill.tested === false) lines.push('', ...wrapText('No probada: nadie ha comprobado aún que mejore el trabajo.', 60));
  if (skill.reviewNotes) lines.push(...wrapText(`Observaciones: ${skill.reviewNotes}`, 60));
  return lines;
}

function skillRows(model) {
  const visible = visibleSkills(model);
  const hidden = model.state.skills.length - visible.length;
  return hidden > 0 ? [...visible.map(skill => ({ skill })), { more: hidden }] : visible.map(skill => ({ skill }));
}

export function createSetupModel(state) {
  const answers = suggestedAnswers(state);
  const confirmation = buildConfirmation(state, answers);
  const model = {
    state, answers, step: confirmation.allReady ? 'menu' : 'skills', flow: confirmation.allReady ? 'menu' : 'full',
    cursor: 0, expanded: false, info: false, detail: false, confirmYes: true,
    memoryInput: '', memoryError: null, progress: [], result: null, detachPlan: null, message: null
  };
  model.memoryChoice = answers.memory.decision === 'later' ? 'later'
    : answers.memory.path === (state.memory.existing?.vaultPath ?? state.memory.suggestedPath) ? memoryOptions(model)[0] : 'other';
  return model;
}

// Leaving the skills question: a suggestion left unchecked is remembered as discarded, so it is not offered again.
function closeSkills(model) {
  const chosen = model.state.skills.filter(skill => model.answers.skills.chosen.includes(skill.name)).map(skill => skill.name);
  const discarded = new Set(model.answers.skills.discarded);
  for (const skill of model.state.skills) {
    if (chosen.includes(skill.name)) discarded.delete(skill.name);
    else if (skill.suggested) discarded.add(skill.name);
  }
  return { ...model.answers, skills: { chosen, discarded: model.state.skills.map(s => s.name).filter(name => discarded.has(name)) } };
}

function memoryAnswer(model, choice) {
  const { state } = model;
  if (choice === 'later') return { decision: 'later' };
  if (choice === 'existing') return { decision: 'path', path: state.memory.existing.vaultPath };
  if (choice === 'suggested') return { decision: 'path', path: state.memory.suggestedPath };
  return model.answers.memory;
}

const go = (model, step, extra = {}) => ({ ...model, step, cursor: 0, info: false, detail: false, message: null, ...extra });
const nextAfter = (model, step) => {
  if (model.flow === 'menu') return 'confirm';
  return { skills: 'memory', memory: 'agents', 'memory-path': 'agents', agents: 'confirm' }[step];
};
const previousOf = (model, step) => {
  if (model.flow === 'menu') return step === 'confirm' ? model.menuEntry : 'menu';
  return { memory: 'skills', 'memory-path': 'memory', agents: 'memory', confirm: 'agents' }[step];
};

export function handleSetupKey(model, key) {
  if (key === '\x03') return { model, effect: 'exit' };
  const { step } = model;

  if (step === 'memory-path') {
    if (is(key, 'enter')) {
      const raw = model.memoryInput.trim();
      const expanded = raw === '~' || raw.startsWith('~/') ? path.join(model.state.homeDirectory, raw.slice(1)) : raw;
      if (!path.isAbsolute(expanded)) return { model: { ...model, memoryError: 'Escribe una ruta completa, por ejemplo ~/memorias/mi-proyecto.' } };
      return { model: { ...model, memoryError: null }, effect: 'check-path', path: path.resolve(expanded) };
    }
    if (key === '\x1b') return { model: go(model, 'memory', { cursor: memoryOptions(model).indexOf('other') }) };
    if (key === '\x7f' || key === '\x08') return { model: { ...model, memoryInput: [...model.memoryInput].slice(0, -1).join('') } };
    if (/^[^\x00-\x1f\x7f]+$/u.test(key) && !key.startsWith('\x1b')) return { model: { ...model, memoryInput: model.memoryInput + key, memoryError: null } };
    return { model };
  }

  if (is(key, 'quit') && !['applying'].includes(step)) return { model, effect: 'exit' };

  if (step === 'done' || step === 'detached') return { model, effect: 'exit' };
  if (step === 'applying') return { model };

  if (step === 'menu') {
    if (is(key, 'up')) return { model: { ...model, cursor: Math.max(0, model.cursor - 1) } };
    if (is(key, 'down')) return { model: { ...model, cursor: Math.min(MENU.length - 1, model.cursor + 1) } };
    if (is(key, 'enter')) {
      const [choice] = MENU[model.cursor];
      if (choice === 'exit') return { model, effect: 'exit' };
      if (choice === 'detach') return { model, effect: 'detach-preview' };
      return { model: go(model, choice, { menuEntry: choice, expanded: choice === 'skills' }) };
    }
    return { model };
  }

  if (step === 'detach-confirm') {
    if (is(key, 'left') || is(key, 'right') || is(key, 'toggle')) return { model: { ...model, confirmYes: !model.confirmYes } };
    if (is(key, 'enter')) return model.confirmYes ? { model, effect: 'detach-apply' } : { model: go(model, 'menu') };
    if (key === '\x7f' || key === '\x08') return { model: go(model, 'menu') };
    return { model };
  }

  if (step === 'skills') {
    const rows = skillRows(model);
    if (is(key, 'up')) return { model: { ...model, cursor: Math.max(0, model.cursor - 1), info: false } };
    if (is(key, 'down')) return { model: { ...model, cursor: Math.min(rows.length - 1, model.cursor + 1), info: false } };
    if (key === 'i') return { model: { ...model, info: !model.info } };
    const row = rows[model.cursor];
    if (is(key, 'toggle') || (is(key, 'enter') && row?.more)) {
      if (row?.more) return { model: { ...model, expanded: true } };
      const chosen = model.answers.skills.chosen.includes(row.skill.name)
        ? model.answers.skills.chosen.filter(name => name !== row.skill.name)
        : [...model.answers.skills.chosen, row.skill.name];
      return { model: { ...model, answers: { ...model.answers, skills: { ...model.answers.skills, chosen } } } };
    }
    if (is(key, 'enter')) return { model: go({ ...model, answers: closeSkills(model) }, nextAfter(model, 'skills')) };
    if (is(key, 'back') && model.flow === 'menu') return { model: go(model, 'menu') };
    return { model };
  }

  if (step === 'memory') {
    const options = memoryOptions(model);
    const cursor = model.cursor;
    if (is(key, 'up')) return { model: { ...model, cursor: Math.max(0, cursor - 1) } };
    if (is(key, 'down')) return { model: { ...model, cursor: Math.min(options.length - 1, cursor + 1) } };
    if (is(key, 'enter')) {
      const choice = options[cursor];
      if (choice === 'other') return { model: go(model, 'memory-path', { memoryChoice: 'other' }) };
      return { model: go({ ...model, memoryChoice: choice, answers: { ...model.answers, memory: memoryAnswer(model, choice) } }, nextAfter(model, 'memory')) };
    }
    if (is(key, 'back')) return { model: go(model, previousOf(model, 'memory')) };
    return { model };
  }

  if (step === 'agents') {
    if (is(key, 'up')) return { model: { ...model, cursor: Math.max(0, model.cursor - 1) } };
    if (is(key, 'down')) return { model: { ...model, cursor: Math.min(AGENTS.length - 1, model.cursor + 1) } };
    if (is(key, 'toggle')) {
      const agent = AGENTS[model.cursor];
      const agents = model.answers.agents.includes(agent) ? model.answers.agents.filter(a => a !== agent) : [...model.answers.agents, agent];
      return { model: { ...model, message: null, answers: { ...model.answers, agents: AGENTS.filter(a => agents.includes(a)) } } };
    }
    if (is(key, 'enter')) {
      if (!model.answers.agents.length) return { model: { ...model, message: 'Marca al menos una IA.' } };
      return { model: go(model, nextAfter(model, 'agents')) };
    }
    if (is(key, 'back')) return { model: go(model, previousOf(model, 'agents')) };
    return { model };
  }

  if (step === 'confirm') {
    if (key === 'd') return { model: { ...model, detail: !model.detail } };
    if (is(key, 'left') || is(key, 'right') || is(key, 'toggle')) return { model: { ...model, confirmYes: !model.confirmYes } };
    if (is(key, 'enter')) {
      if (!model.confirmYes) return { model, effect: 'exit' };
      return buildConfirmation(model.state, model.answers).blocks.length ? { model, effect: 'apply' } : { model, effect: 'exit' };
    }
    if (key === '\x7f' || key === '\x08') return { model: go(model, previousOf(model, 'confirm')) };
    return { model };
  }
  return { model };
}

// The answer to "otra carpeta…" once its path was checked (an existing memory, a new one, or something not touched).
export function applyMemoryPathCheck(model, target, kind, connections) {
  if (kind === 'invalid') return { ...model, memoryError: 'Esa carpeta no está vacía y no es una memoria; elige otra.' };
  if (kind === 'foreign') return { ...model, memoryError: 'Esa es la memoria de otro proyecto; elige otra carpeta.' };
  const memory = { ...model.state.memory, kinds: { ...model.state.memory.kinds, [target]: kind },
    connections: { ...model.state.memory.connections, ...(connections && { [target]: connections }) } };
  return go({ ...model, state: { ...model.state, memory }, answers: { ...model.answers, memory: { decision: 'path', path: target } } }, nextAfter(model, 'memory'));
}

// ── Drawing ──────────────────────────────────────────────────────────────────────────────────────────────────────

function folded(model) {
  const { state, answers } = model;
  const lines = [`Proyecto: ${state.project.displayName}${state.project.fromSubfolder ? ' (repositorio completo)' : ''}`];
  const order = ['skills', 'memory', 'memory-path', 'agents', 'confirm'];
  const at = order.indexOf(model.step);
  if (model.step === 'skills' || at < 0) {
    if (state.signals.length && model.step === 'skills') {
      const labels = detectedLabels(state.signals);
      lines.push(`Detecté: ${labels.slice(0, MAX_DETECTED).join(' · ')}${labels.length > MAX_DETECTED ? ` · y ${labels.length - MAX_DETECTED} más` : ''}`);
    }
    return lines;
  }
  if (model.flow === 'full' || model.menuEntry === 'skills') lines.push(`Skills: ${answers.skills.chosen.length} ${answers.skills.chosen.length === 1 ? 'elegida' : 'elegidas'}`);
  if (model.flow === 'full' && at > order.indexOf('memory-path')) {
    lines.push(answers.memory.decision === 'later' ? 'Memoria: ahora no' : `Memoria: ${shortPath(answers.memory.path, state.homeDirectory)}`);
  }
  if ((model.flow === 'full' && at > order.indexOf('agents')) || model.menuEntry === 'agents' && model.step === 'confirm') {
    lines.push(`IA: ${joinNames(answers.agents.map(agent => AGENT_NAMES[agent]))}`);
  }
  return lines;
}

function question(model) {
  const { state, answers } = model;
  const home = state.homeDirectory;
  switch (model.step) {
    case 'skills': {
      const rows = skillRows(model);
      const width = Math.min(28, Math.max(...rows.filter(r => r.skill).map(r => r.skill.name.length), 10));
      const body = rows.map((row, index) => ({
        cursor: index === model.cursor,
        text: row.more ? `◻ ver ${row.more} más…` : `${answers.skills.chosen.includes(row.skill.name) ? '◼' : '◻'} ${row.skill.name.padEnd(width)}  ${row.skill.reason ?? ''}${row.skill.tested === false ? ' · no probada' : ''}`.trimEnd()
      }));
      const current = rows[model.cursor]?.skill;
      const external = state.externalSkills?.length
        ? ['', ...wrapText(`Se instalan aparte: ${state.externalSkills.map(ref => ref.name).join(', ')}`, 60)]
        : [];
      const info = [...(model.info && current ? ['', ...wrapText(current.summary, 60), ...skillTrust(current)] : []), ...external];
      return { title: '¿Qué skills quieres?', body, info, keys: 'espacio marcar · i qué hace · Enter seguir · q salir' };
    }
    case 'memory': {
      const labels = {
        existing: `Usar la memoria existente en ${shortPath(state.memory.existing?.vaultPath ?? '', home)}`,
        suggested: `Sí, en ${shortPath(state.memory.suggestedPath, home)}`,
        other: 'Sí, en otra carpeta…',
        later: 'Ahora no'
      };
      const options = memoryOptions(model);
      const body = options.map((option, index) => ({ cursor: index === model.cursor, text: `${index === model.cursor ? '●' : '○'} ${labels[option]}` }));
      const info = state.project.git
        ? ['', 'Guarda decisiones, arquitectura y entregas.', 'Se abre en Obsidian y la leen tus IA.']
        : ['', 'La memoria necesita un repositorio Git; ejecuta `git init` para activarla.'];
      return { title: state.memory.existing ? '¿Usar la memoria del proyecto?' : '¿Crear la memoria del proyecto?', body, info, keys: 'Enter seguir · ← volver · q salir' };
    }
    case 'memory-path':
      return {
        title: '¿En qué carpeta?', body: [{ cursor: true, text: `${model.memoryInput}▏` }],
        info: model.memoryError ? ['', model.memoryError] : ['', 'Una carpeta vacía o que aún no existe, o una memoria tuya.'],
        keys: 'Enter seguir · Esc volver'
      };
    case 'agents': {
      const body = AGENTS.map((agent, index) => ({
        cursor: index === model.cursor,
        text: `${answers.agents.includes(agent) ? '◼' : '◻'} ${AGENT_NAMES[agent].padEnd(12)}  ${state.agentsFound[agent] ? 'encontrado' : 'no encontrado'}`
      }));
      const info = [];
      if (answers.agents.length >= 2) info.push('', 'Desde cualquiera puedes pedir revisión a otra.');
      const unchecked = (state.savedAnswers?.agents ?? []).filter(agent => !answers.agents.includes(agent));
      if (unchecked.length) info.push('', 'Desmarcar no desconecta nada; para quitarlo usa `npx nexakit quitar`.');
      if (model.message) info.push('', model.message);
      return { title: '¿Con qué IA trabajas?', body, info, keys: 'espacio marcar · Enter seguir · ← volver · q salir' };
    }
    case 'confirm': {
      const confirmation = buildConfirmation(state, answers);
      if (!confirmation.blocks.length) {
        return { title: 'No hay nada que preparar', body: confirmation.lines.map(line => ({ text: ` ${line.mark} ${line.text}` })), info: [], keys: 'Enter salir · ← volver' };
      }
      const body = model.detail ? detailLines(model, confirmation) : confirmation.lines.map(line => ({ text: ` ${line.mark} ${line.text}` }));
      const info = ['', 'No toco archivos tuyos. Se puede deshacer con', '`npx nexakit quitar`.', '',
        `¿Lo preparo?  ${model.confirmYes ? '● Sí / ○ No' : '○ Sí / ● No'}`];
      return { title: 'Voy a preparar:', body, info, keys: 'Enter elegir · ←/→ cambiar · d detalle · Retroceso volver' };
    }
    default:
      return null;
  }
}

function detailLines(model, confirmation) {
  const { state, answers } = model;
  const home = state.homeDirectory;
  const lines = [`Proyecto: ${shortPath(state.project.root, home)}`, `nexakit: ${shortPath(state.internal?.linkRoot ?? '', home)}`];
  for (const name of answers.skills.chosen) {
    const skill = state.skills.find(entry => entry.name === name);
    lines.push(`skill ${name}${skill?.license ? ` (${skill.license})` : ''}: .claude ${skill?.links.claude} · .agents ${skill?.links.codex}`);
  }
  if (answers.memory.decision === 'path') lines.push(`memoria: ${shortPath(answers.memory.path, home)}`);
  lines.push(`bloques: ${confirmation.blocks.map(block => block.id).join(', ')}`);
  return lines.map(text => ({ text: ` ${text}` }));
}

function finalLines(model) {
  const { state, answers, result } = model;
  const lines = model.progress.map(item => `${item.phase === 'failed' ? '✗' : item.phase === 'done' ? '◇' : '◆'}  ${item.label}${item.phase === 'start' ? '…' : ''}`);
  if (result?.finalCheck) lines.push(`${result.finalCheck.ok ? '◇' : '!'}  Comprobación final: ${result.finalCheck.message}`);
  if (model.step !== 'done') return { lines, end: [] };
  if (!result.ok) {
    const reason = result.failed?.message ?? `Comprobación final: ${result.finalCheck?.message ?? ''}`;
    return { lines, end: [result.failed ? 'Se detuvo aquí.' : 'Terminó, pero algo no quedó listo.', ...wrapText(reason, 60)] };
  }
  const names = joinNames(answers.agents.map(agent => AGENT_NAMES[agent]));
  const end = ['Listo. Ahora:', `  1. Cierra y abre ${names}`];
  if (answers.memory.decision === 'path') {
    end.push('  2. Pídele: «lee la memoria y resume el proyecto»',
      'Abre la memoria en Obsidian: «Abrir carpeta como bóveda»', `→ ${shortPath(answers.memory.path, state.homeDirectory)}`);
  } else {
    end.push('  2. Pídele lo que necesites: las skills ya están en el proyecto');
  }
  return { lines, end };
}

export function renderSetupFrame(model, { columns = 80, color = true } = {}) {
  const c = style(color);
  const width = Math.max(30, columns - 1);
  const out = [];
  const push = (text, paint = value => value) => out.push(paint(fitLine(text, width)));
  // Rows that carry a path or a sentence wrap instead of being cut; continuation lines keep the │ gutter.
  const pushWrapped = (prefix, text, paint = value => value, continuation = `│${' '.repeat(prefix.length - 1)}`) => {
    const lines = wrapText(text, Math.max(10, width - Math.max(cellWidth(prefix), cellWidth(continuation))));
    lines.forEach((line, index) => out.push(paint(`${index === 0 ? prefix : continuation}${line}`)));
  };
  push(`◆ nexakit${model.state.version ? ` v${model.state.version}` : ''}`, c.bold);
  const { state } = model;

  if (model.step === 'menu') {
    push(`◇  Proyecto: ${state.project.displayName}`, c.dim);
    push('│');
    const ready = buildConfirmation(state, model.answers).lines.filter(line => line.mark === '✓').map(line => line.text);
    push('◇  Todo está listo', c.green);
    for (const text of ready) push(`│  ${text}`, c.dim);
    push('│');
    push('◆  ¿Quieres cambiar algo?', c.cyan);
    MENU.forEach(([, label], index) => push(`│ ${index === model.cursor ? '❯' : ' '} ${index === model.cursor ? '●' : '○'} ${label}`, index === model.cursor ? c.cyan : undefined));
    push('└  Enter elegir · q salir', c.dim);
    return out.join('\n');
  }

  if (['applying', 'done'].includes(model.step)) {
    const agents = joinNames(model.answers.agents.map(agent => AGENT_NAMES[agent]));
    const memory = model.answers.memory.decision === 'path' ? ' · memoria' : '';
    push(`◇  ${state.project.displayName} · ${model.answers.skills.chosen.length} skills${memory} · ${agents}`, c.dim);
    push('│');
    const { lines, end } = finalLines(model);
    for (const line of lines) push(line, line.startsWith('✗') ? c.red : line.startsWith('◆') ? c.cyan : undefined);
    if (end.length) {
      push('│');
      push(`└  ${end[0]}`, model.result?.ok ? c.green : c.red);
      for (const line of end.slice(1)) push(`   ${line}`);
    }
    return out.join('\n');
  }

  if (model.step === 'detach-confirm' || model.step === 'detached') {
    push(`◇  Proyecto: ${state.project.displayName}`, c.dim);
    push('│');
    const plan = model.detachPlan;
    const removable = (plan?.items ?? []).filter(item => item.action !== 'conflict').length;
    const kept = (plan?.items ?? []).filter(item => item.action === 'conflict').length;
    if (model.step === 'detached') {
      push('◇  nexakit quitado de este proyecto', c.green);
      push(`└  Se quitaron ${removable} enlaces. La memoria y tus IA no se tocaron.`);
      return out.join('\n');
    }
    push('◆  ¿Quitar nexakit de este proyecto?', c.cyan);
    push(`│   − ${removable} skills del proyecto y su bloque en .gitignore`);
    if (kept) push(`│   ! ${kept} carpetas tuyas se quedan como están`);
    push('│   La memoria y la configuración de tus IA no se tocan.');
    push('│');
    push(`│  ${model.confirmYes ? '● Sí / ○ No' : '○ Sí / ● No'}`);
    push('└  Enter elegir · ←/→ cambiar', c.dim);
    return out.join('\n');
  }

  for (const line of folded(model)) pushWrapped('◇  ', line, c.dim, '   ');
  push('│');
  const q = question(model);
  push(`◆  ${q.title}`, c.cyan);
  for (const row of q.body) {
    const text = row.text.startsWith(' ') ? row.text.slice(1) : row.text;
    const marker = row.text.startsWith(' ') && /^ [+−↻!✓] /u.test(row.text) ? `│   ${text.slice(0, 2)}` : `│ ${row.cursor ? '❯' : ' '} `;
    const shown = marker.startsWith('│   ') && /^[+−↻!✓] /u.test(text) ? text.slice(2) : text;
    // A checkbox or radio row continues under its label, not under the box.
    const continuation = /^[◼◻●○] /u.test(shown) ? `│${' '.repeat(marker.length + 1)}` : undefined;
    pushWrapped(marker, shown, row.cursor ? c.cyan : undefined, continuation);
  }
  for (const line of q.info) {
    if (!line) push('│');
    else pushWrapped('│  ', line, line.startsWith('¿Lo preparo') ? c.bold : c.dim);
  }
  pushWrapped('└  ', q.keys, c.dim, '   ');
  return out.join('\n');
}

// ── Loop ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export async function runSetupTui({ input = process.stdin, output = process.stdout, options = {}, applyOptions = {} } = {}) {
  const useColor = Boolean(output.isTTY && !process.env.NO_COLOR);
  const home = options.homeDirectory ?? os.homedir();
  output.write('Revisando el proyecto…\n');
  let model = createSetupModel(await gatherSetupState(options));
  let exitCode = 0;
  // The questions live on the alternate screen, where moving home and erasing redraws in place: clearing the
  // normal screen pushes a copy of every frame into the scrollback in most terminals. On exit the last frame is
  // printed once on the normal screen, so the result stays readable.
  const frame = () => renderSetupFrame(model, { columns: output.columns || 80, color: useColor });
  const render = () => output.write(`\x1b[H\x1b[J${frame()}\n`);

  return new Promise(resolve => {
    let closed = false;
    let chain = Promise.resolve();
    const cleanup = code => {
      if (closed) return;
      closed = true;
      input.off?.('data', onData);
      output.off?.('resize', render);
      try { if (typeof input.setRawMode === 'function') input.setRawMode(false); } catch {}
      try { input.pause?.(); } catch {}
      output.write(`\x1b[?1049l${frame()}\n\x1b[?25h`);
      resolve(code);
    };

    const runEffect = async (effect, extra) => {
      if (effect === 'exit') return cleanup(exitCode);
      if (effect === 'check-path') {
        const kind = await inspectMemoryPath(extra.path, { repositoryRoot: model.state.project.root });
        const connections = ['memory', 'new'].includes(kind)
          ? await memoryConnections(extra.path, { homeDirectory: home, codexHome: model.state.internal.codexHome, runCommand: options.runCommand,
            nodePath: model.state.internal.nodePath, toolkitRoot: model.state.internal.linkRoot, agentsFound: model.state.agentsFound,
            kind, mcpName: `${model.state.project.id}-memory` })
          : null;
        model = applyMemoryPathCheck(model, extra.path, kind, connections);
      } else if (effect === 'apply') {
        const labels = Object.fromEntries(buildConfirmation(model.state, model.answers).blocks.map(block => [block.id, block.label]));
        model = { ...model, step: 'applying', progress: [] };
        render();
        const result = await applySetup(options, model.answers, {
          ...applyOptions,
          onProgress: (id, phase) => {
            const progress = model.progress.filter(item => item.id !== id);
            model = { ...model, progress: [...progress, { id, label: labels[id] ?? id, phase }] };
            render();
          }
        });
        exitCode = result.ok ? 0 : 1;
        model = { ...model, step: 'done', result };
      } else if (effect === 'detach-preview') {
        const { catalog, toolkitRoot } = model.state.internal;
        const plan = await planToolkitDetach({ projectRoot: model.state.project.root, catalog, toolkitRoot, homeDirectory: home });
        model = { ...model, step: 'detach-confirm', detachPlan: plan, confirmYes: false };
      } else if (effect === 'detach-apply') {
        await applyToolkitDetach(model.detachPlan);
        model = { ...model, step: 'detached' };
      }
      render();
    };

    const handle = async key => {
      if (closed) return;
      const { model: next, effect, ...extra } = handleSetupKey(model, key);
      model = next;
      if (effect) await runEffect(effect, extra);
      else render();
    };
    const onData = chunk => {
      const key = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      if (key === '\x03' && model.step !== 'applying') return cleanup(exitCode);
      chain = chain.then(() => handle(key)).catch(error => {
        model = { ...model, step: 'done', result: { ok: false, failed: { message: error instanceof Error ? error.message : String(error) } } };
        exitCode = 1;
        render();
      });
    };

    try {
      output.write('\x1b[?1049h\x1b[?25l');
      if (typeof input.setRawMode === 'function') input.setRawMode(true);
      input.resume?.();
      input.on('data', onData);
      output.on?.('resize', render);
      render();
    } catch {
      cleanup(1);
    }
  });
}
