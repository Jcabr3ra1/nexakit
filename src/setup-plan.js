// Pure: turns what nexakit found (setup-state.js) and the person's answers into the confirmation summary, in short
// sentences, and the ordered blocks that apply it. No I/O, so every screen and every decision is testable.

export const AGENTS = Object.freeze(['claude', 'codex', 'antigravity']);
export const AGENT_NAMES = Object.freeze({ claude: 'Claude Code', codex: 'Codex', antigravity: 'Antigravity' });
// Claude reads project skills from .claude/skills; Codex and Antigravity share .agents/skills.
const folderOf = agent => (agent === 'claude' ? 'claude' : 'codex');
const FOLDER_PATHS = Object.freeze({ claude: '.claude/skills', codex: '.agents/skills' });
const PENDING_LINKS = new Set(['missing', 'replace']);

export function joinNames(names) {
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} y ${names.at(-1)}`;
}
// ~/… for paths under the home folder, with either separator (Windows uses \\).
export const shortPath = (target, homeDirectory) =>
  (homeDirectory && (target === homeDirectory || target.startsWith(`${homeDirectory}/`) || target.startsWith(`${homeDirectory}\\`))
    ? `~${target.slice(homeDirectory.length)}` : target);
const plural = (count, one, many) => (count === 1 ? one : many);

// "frontend usa React", "el README menciona Tauri": the reason for a suggestion, from where the signal was found.
export function shortReason(label, source) {
  const file = source.replace(/\s*\(.*\)$/u, '');
  const parts = file.split('/');
  const folder = parts.length > 1 ? parts.slice(0, -1).join('/') : null;
  if (/^readme\.md$/iu.test(parts.at(-1))) return folder ? `${folder}/README menciona ${label}` : `el README menciona ${label}`;
  return folder ? `${folder} usa ${label}` : `el proyecto usa ${label}`;
}

const linkStates = (skill, agents) => [...new Set(agents.map(folderOf))].map(folder => [folder, skill.links?.[folder] ?? 'missing']);

export function suggestedAnswers(state) {
  const names = new Set(state.skills.map(skill => skill.name));
  const saved = state.savedAnswers;
  if (saved) {
    const answered = new Set([...saved.skills.chosen, ...saved.skills.discarded]);
    const chosen = state.skills
      .filter(skill => saved.skills.chosen.includes(skill.name) || (skill.suggested && !answered.has(skill.name)))
      .map(skill => skill.name);
    return { version: 1, skills: { chosen, discarded: saved.skills.discarded.filter(name => names.has(name)) },
      agents: [...saved.agents], memory: { ...saved.memory } };
  }
  const installed = skill => Object.values(skill.links ?? {}).includes('installed');
  const found = AGENTS.filter(agent => state.agentsFound[agent]);
  const memory = state.memory.existing
    ? { decision: 'path', path: state.memory.existing.vaultPath }
    : state.project.git ? { decision: 'path', path: state.memory.suggestedPath } : { decision: 'later' };
  return {
    version: 1,
    skills: { chosen: state.skills.filter(skill => skill.suggested || installed(skill)).map(skill => skill.name), discarded: [] },
    agents: found.length ? found : [...AGENTS],
    memory
  };
}

const sameAnswers = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function buildConfirmation(state, answers) {
  const lines = [];
  const blocks = [];
  const add = (mark, text) => lines.push({ mark, text });
  const block = (id, label) => blocks.push({ id, label });
  const answersChanged = !state.savedAnswers || !sameAnswers(state.savedAnswers, answers);
  const agents = AGENTS.filter(agent => answers.agents.includes(agent));
  const home = state.homeDirectory;

  if (state.stableCopy.needed) {
    add('+', 'Copia estable de nexakit en ~/.nexakit');
    block('stable-copy', 'Copia estable de nexakit');
  }
  if (['falta', 'distinto'].includes(state.stableCommand.state)) {
    add('+', 'Orden nexakit para tus IA');
    block('stable-command', 'Orden nexakit');
  } else if (state.stableCommand.state === 'conflicto') {
    add('!', '~/.nexakit/nexakit existe y no es de nexakit; no lo toco');
  }

  // Project skills, in the folders of the chosen agents.
  const chosen = state.skills.filter(skill => answers.skills.chosen.includes(skill.name));
  const toInstall = [], conflicts = [], readySkills = [];
  for (const skill of chosen) {
    // Per folder: a user folder is left alone, and the skill is still installed where it is missing.
    const states = linkStates(skill, agents);
    for (const [folder, value] of states) if (value === 'conflict') conflicts.push([skill, folder]);
    if (states.some(([, value]) => PENDING_LINKS.has(value))) toInstall.push(skill);
    else if (states.every(([, value]) => value === 'installed')) readySkills.push(skill);
  }
  const removeSkills = state.skills
    .filter(skill => !answers.skills.chosen.includes(skill.name) && Object.values(skill.links ?? {}).includes('installed'))
    .map(skill => skill.name);
  if (toInstall.length) {
    add('+', `${toInstall.length} ${plural(toInstall.length, 'skill en el proyecto (ignorada en Git)', 'skills en el proyecto (ignoradas en Git)')}`);
  }
  if (removeSkills.length) add('−', `Quitar ${removeSkills.length} ${plural(removeSkills.length, 'skill', 'skills')} del proyecto`);
  for (const [skill, folder] of conflicts) {
    add('!', `${skill.name}: ya hay una carpeta tuya con ese nombre en ${FOLDER_PATHS[folder]}; no la toco`);
  }
  if (!toInstall.length && readySkills.length) add('✓', 'Skills del proyecto ya estaban listas');
  if (toInstall.length || removeSkills.length) block('project-skills', 'Skills del proyecto');

  // Base skills of each chosen agent: only what is missing or repairable; conflicts are reported.
  const globalBlocks = [];
  for (const agent of agents) {
    const global = state.globalSkills[agent] ?? { pending: 0, conflicts: 0 };
    if (global.pending) {
      add('+', `${global.pending} ${plural(global.pending, 'skill base', 'skills base')} en ${AGENT_NAMES[agent]}`);
      globalBlocks.push(agent);
    }
    if (global.conflicts) {
      add('!', `${global.conflicts} ${plural(global.conflicts, 'skill base', 'skills base')} de ${AGENT_NAMES[agent]} ${plural(global.conflicts, 'choca con una carpeta tuya; no la toco', 'chocan con carpetas tuyas; no las toco')}`);
    }
  }
  for (const agent of globalBlocks) block(`global-skills:${agent}`, `Skills base en ${AGENT_NAMES[agent]}`);

  // Memory: create it if needed, then connect it to each chosen agent.
  if (answers.memory.decision === 'path') {
    const target = answers.memory.path;
    const kind = state.memory.kinds?.[target] ?? 'new';
    if (kind === 'invalid') {
      add('!', `${shortPath(target, home)} no está vacía y no es una memoria; elige otra carpeta`);
    } else if (kind === 'foreign') {
      add('!', `${shortPath(target, home)} es la memoria de otro proyecto; elige otra carpeta`);
    } else {
      if (kind === 'new') {
        add('+', `Memoria nueva en ${shortPath(target, home)}`);
        block('memory-init', 'Memoria creada');
      } else {
        add('✓', `Memoria del proyecto en ${shortPath(target, home)}`);
      }
      const connections = state.memory.connections?.[target] ?? {};
      const statusOf = agent => connections[agent] ?? (state.agentsFound[agent] ? 'create' : 'unavailable');
      const need = agents.filter(agent => statusOf(agent) === 'create');
      const connected = agents.filter(agent => statusOf(agent) === 'unchanged');
      if (need.length) add('+', `Conectar la memoria a ${joinNames(need.map(agent => AGENT_NAMES[agent]))}`);
      else if (connected.length) add('✓', `Memoria conectada a ${joinNames(connected.map(agent => AGENT_NAMES[agent]))}`);
      for (const agent of agents) {
        if (statusOf(agent) === 'conflict') add('!', `${AGENT_NAMES[agent]} ya tiene otra memoria con el mismo nombre; no la toco`);
        if (statusOf(agent) === 'unavailable') add('!', `No encontré ${AGENT_NAMES[agent]}; no puedo conectarle la memoria`);
      }
      for (const agent of need) block(`memory-connect:${agent}`, `Memoria conectada a ${AGENT_NAMES[agent]}`);
    }
  }

  if (answersChanged && (blocks.length || state.savedAnswers)) {
    // Saved first, before any block that can fail, so a retry starts from what the person decided.
    blocks.unshift({ id: 'answers', label: 'Respuestas guardadas' });
    if (!blocks.some(item => item.id === 'project-skills')) add('+', 'Guardar tus respuestas en .agent-toolkit (ignorado en Git)');
  }
  if (blocks.length) block('final-check', 'Comprobación final');
  const allReady = !lines.some(line => ['+', '−', '↻'].includes(line.mark));
  return { lines, blocks, allReady, removeSkills };
}
