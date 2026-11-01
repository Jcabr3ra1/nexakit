import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadSkillCatalog } from './skill-catalog.js';
import {
  applyProjectSkillInstall,
  applyToolkitDetach,
  inspectSkillProject,
  planProjectSkillInstall,
  planToolkitDetach,
  PROJECT_TOOLKIT_DIR,
  recommendSkills
} from './skill-recommendations.js';
import { levelAgentPlan, writeLevelAgents } from './level-agents.js';
import { getToolkitCommandsGuide } from './toolkit-commands-guide.js';
import { doctorToolkit, setupToolkit, TOOLKIT_ROOT } from './toolkit-setup.js';
import { ACTIONABLE_LINK_STATES, READY_LINK_STATES } from './link-states.js';
import { actualRoot } from './stable-install.js';

// A review line is `<mark> <label>`: + create, ↻ move or repair, ! left untouched, ✓ already fine.
const ACTION_MARKS = Object.freeze({ create: '+', move: '↻', repair: '↻', conflict: '!', legacy: '!', info: '✓' });
const markOf = action => action.mark ?? ACTION_MARKS[action.kind] ?? '+';
const shortPath = (value, home) => (home && (value === home || value.startsWith(home + path.sep)) ? `~${value.slice(home.length)}` : value);
const resolveHome = async setupOptions => {
  const home = setupOptions.homeDirectory ?? os.homedir();
  return fs.realpath(home).catch(() => path.resolve(home));
};
const exists = file => fs.access(file).then(() => true, () => false);

const AGENTS_CYCLE = ['all', 'claude', 'codex'];
const AGENT_LABELS = Object.freeze({
  all: 'Claude + Codex (ambos)',
  claude: 'Solo Claude Code',
  codex: 'Solo Codex'
});
const MODE_LABELS = Object.freeze({
  symlink: 'Enlaza las skills al toolkit sin duplicarlas. Recomendado para trabajar en este equipo.',
  copy: `Guarda una copia de las skills en el proyecto y sus hashes en ${PROJECT_TOOLKIT_DIR}/skills-lock.json. Útil si prefieres no depender de enlaces al toolkit.`
});
const GIT_IGNORE_LABELS = Object.freeze({
  gitignore: 'Oculta los archivos instalados en Git. Usa .gitignore si quieres compartir estas reglas con tu equipo.',
  'git-exclude': 'Oculta los archivos instalados en Git solo en tu equipo, sin modificar el .gitignore compartido.'
});

function style(colorEnabled) {
  if (!colorEnabled) {
    const plain = text => String(text);
    return { bold: plain, cyan: plain, green: plain, yellow: plain, dim: plain, red: plain, magenta: plain };
  }
  const wrap = (open, close) => text => `\x1b[${open}m${text}\x1b[${close}m`;
  return {
    bold: wrap(1, 22),
    dim: wrap(2, 22),
    red: wrap(31, 39),
    green: wrap(32, 39),
    yellow: wrap(33, 39),
    magenta: wrap(35, 39),
    cyan: wrap(36, 39)
  };
}

export async function buildToolkitTuiSnapshot({
  projectRoot = process.cwd(),
  agent = 'all',
  profile = null,
  codexProfile,
  installMode = 'symlink',
  setupOptions = {}
} = {}) {
  const toolkitRoot = setupOptions.toolkitRoot ?? TOOLKIT_ROOT;
  const catalogUrl = setupOptions.toolkitRoot
    ? pathToFileURL(path.join(toolkitRoot, 'catalogs/skills.json'))
    : undefined;
  const catalog = await loadSkillCatalog(catalogUrl ? { catalogUrl } : {});

  const [doctor, setupPreview, inspection, codexLevels] = await Promise.all([
    doctorToolkit({ ...setupOptions, agent, ...(codexProfile && { codexProfile }) }),
    setupToolkit({ ...setupOptions, agent, apply: false, ...(codexProfile && { codexProfile }) }),
    inspectSkillProject(projectRoot, { toolkitRoot, catalog }),
    agent === 'claude'
      ? Promise.resolve({ catalog: false, files: [] })
      : levelAgentPlan(setupOptions.codexHome ? { codexHome: setupOptions.codexHome } : {}).catch(() => ({ catalog: false, files: [] }))
  ]);

  const recommendation = recommendSkills({
    catalog,
    inspection,
    clients: agent === 'all' ? ['claude', 'codex'] : [agent],
    ...(profile && { profile })
  });

  const projectInstallPlan = await planProjectSkillInstall({
    projectRoot: inspection.projectRoot,
    skillNames: catalog.skills.map(s => s.name),
    agent,
    mode: installMode,
    catalog,
    toolkitRoot,
    ...(setupOptions.homeDirectory && { homeDirectory: setupOptions.homeDirectory })
  });

  const guide = getToolkitCommandsGuide({ clients: doctor.clients });

  return {
    agent,
    profile,
    codexProfile,
    installMode,
    catalog,
    doctor,
    setupPreview,
    codexLevels,
    inspection,
    recommendation,
    projectInstallPlan,
    guide
  };
}

function buildSkillItem(entry, linksForSkill, { isFundamental }) {
  const missingCount = linksForSkill.filter(l => ['missing', 'replace'].includes(l.state)).length;
  const conflictCount = linksForSkill.filter(l => l.state === 'conflict').length;
  const stateLabel = conflictCount > 0
    ? '⚠ conflicto respetado'
    : missingCount === 0
      ? '✓ ya instalada'
      : 'SHA-256 ✓';

  const reasonText = isFundamental
    ? entry.reasons.join(', ')
    : `perfil ${entry.profiles.join('/')}`;
  const validated = entry.recommendationStatus === 'validated';
  const checked = Boolean(isFundamental && validated && missingCount > 0);

  return {
    id: `skill:${entry.name}`,
    skillName: entry.name,
    title: entry.name,
    summary: entry.summary,
    license: entry.license,
    origin: `${reasonText} · ${stateLabel} (${entry.license})`,
    reasons: entry.reasons ?? [],
    pendingReasons: entry.pendingReasons ?? [],
    evidence: entry.evidence ?? [],
    overlapsWith: entry.overlapsWith ?? [],
    recommendationStatus: entry.recommendationStatus,
    installationStatus: conflictCount > 0 ? 'conflict' : missingCount === 0 ? 'installed' : 'missing',
    reviewStatus: entry.reviewStatus,
    reviewNotes: entry.reviewNotes,
    checked,
    selectionSource: checked ? 'auto' : 'default',
    alreadyReady: missingCount === 0 && conflictCount === 0
  };
}

export function createToolkitTuiModel(snapshot) {
  const pendingGlobal = snapshot.setupPreview.skills.filter(s => ACTIONABLE_LINK_STATES.includes(s.state)).length;
  const conflictGlobal = snapshot.setupPreview.conflicts;
  const newLevels = snapshot.codexLevels.files.filter(f => f.state === 'nuevo').length;
  const globalNeedsSync = (pendingGlobal > 0 && conflictGlobal === 0) || newLevels > 0;

  const fundamentalSource = [
    ...snapshot.recommendation.recommended,
    ...snapshot.recommendation.candidates
  ];
  const fundamentalItems = fundamentalSource.map(entry => {
    const links = snapshot.projectInstallPlan.links.filter(l => l.name === entry.name);
    return buildSkillItem(entry, links, { isFundamental: true });
  });

  const optionalItems = snapshot.recommendation.optional.map(entry => {
    const links = snapshot.projectInstallPlan.links.filter(l => l.name === entry.name);
    return buildSkillItem(entry, links, { isFundamental: false });
  });

  const coupling = snapshot.inspection.coupling ?? { coupled: false, gitIgnoreStrategy: 'gitignore' };
  const initialGitIgnore = coupling.gitIgnoreStrategy === 'git-exclude' ? 'git-exclude' : 'gitignore';

  return {
    step: 1, // project skills | optional skills | review | done | detach-preview | detached
    showCommands: false,
    cursors: { 1: 0, 2: 0 },
    configCursor: 0,
    configDraft: null,
    config: {
      agent: snapshot.agent,
      installMode: snapshot.installMode ?? coupling.mode ?? 'symlink',
      gitIgnore: initialGitIgnore,
      syncGlobalCore: globalNeedsSync,
      globalAlreadyReady: !globalNeedsSync && conflictGlobal === 0,
      pendingGlobalCount: pendingGlobal + newLevels
    },
    snapshot,
    fundamentalItems,
    optionalItems,
    previewData: null,
    detachPlan: null,
    resultData: null,
    statusMessage: null
  };
}

// Terminal cells, rather than UTF-16 length, keep borders aligned for project names.
function cellWidth(text) {
  return [...text].reduce((width, char) => {
    const cp = char.codePointAt(0);
    if (/\p{Mark}/u.test(char) || cp === 0x200d || cp === 0xfe0f) return width;
    const wide = /\p{Extended_Pictographic}/u.test(char)
      || (cp >= 0x1100 && (cp <= 0x115f || cp === 0x2329 || cp === 0x232a
        || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3)
        || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe10 && cp <= 0xfe19)
        || (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60)
        || (cp >= 0xffe0 && cp <= 0xffe6) || cp >= 0x20000));
    return width + (wide ? 2 : 1);
  }, 0);
}

function wrapText(text, width) {
  const lines = [];
  for (const paragraph of String(text).split('\n')) {
    let line = '';
    for (const token of paragraph.match(/\s*\S+/gu) ?? []) {
      const word = token.trimStart();
      let gap = token.slice(0, token.length - word.length);
      if (line && cellWidth(line + gap + word) > width) {
        lines.push(line.trimEnd());
        line = '';
        gap = '';
      }
      for (const char of gap + word) {
        if (cellWidth(line + char) > width) {
          lines.push(line);
          line = '';
        }
        line += char;
      }
    }
    lines.push(line);
  }
  return lines;
}

export function renderToolkitTuiFrame(model, { columns = 96, color = true } = {}) {
  const c = style(color);
  const plain = text => String(text);
  const margin = columns < 50 ? '' : '  ';
  const width = Math.max(12, Math.min(columns - margin.length * 2, 96));
  const innerWidth = width - 4;
  const lines = [];
  const body = [];
  const add = (text = '', paint = plain) => {
    for (const line of wrapText(text, innerWidth)) body.push({ text: line, paint });
  };
  const outside = (text = '', paint = plain) => {
    for (const line of wrapText(text, width)) lines.push(margin + paint(line));
  };
  const accent = text => c.bold(c.magenta(text));
  const selected = color ? text => c.magenta(`\x1b[7m${text}\x1b[27m`) : plain;
  const finish = (hints = []) => {
    lines.push(`${margin}${c.dim(`╭${'─'.repeat(width - 2)}╮`)}`);
    for (const row of body) {
      const padding = ' '.repeat(Math.max(0, innerWidth - cellWidth(row.text)));
      lines.push(`${margin}${c.dim('│')} ${row.paint(row.text + padding)} ${c.dim('│')}`);
    }
    lines.push(`${margin}${c.dim(`╰${'─'.repeat(width - 2)}╯`)}`);
    if (model.statusMessage) {
      outside();
      outside(`! ${model.statusMessage}`, c.yellow);
    }
    outside();
    for (const hint of hints) outside(hint, text => text.replace(/\[[^\]]+\]/gu, c.bold));
    return lines.join('\n') + '\n';
  };
  const doc = model.snapshot.doctor;
  const config = model.configDraft ?? model.config;
  const shortAgent = AGENT_LABELS[config.agent];
  const shortMode = config.installMode === 'copy' ? 'Copia verificada' : 'Enlace simbólico';
  const shortIgnore = config.gitIgnore === 'git-exclude' ? '.git/info/exclude' : '.gitignore';
  const detachHint = model.snapshot.inspection.coupling?.coupled ? ' · [d] desacoplar' : '';
  const workflowLabel = cmd => cmd.id === 'revisar' ? `${cmd.codex} / ${cmd.claude}` : cmd.claude;

  outside('◆ nexakit', accent);
  outside(`Proyecto: ${model.snapshot.inspection.projectName}`);
  outside();

  if (model.showCommands) {
    add('Comandos a mano', c.bold);
    add('En Claude usa /nombre; en Codex, $nombre.', c.dim);
    add();
    for (const cmd of model.snapshot.guide.workflowCommands) {
      add(workflowLabel(cmd), accent);
      add(cmd.description);
      add();
    }
    add('En tu terminal', c.bold);
    for (const cli of model.snapshot.guide.cliCommands) {
      add(cli.command, c.cyan);
      add(cli.description);
      add();
    }
    return finish(['[Esc / c / Tab] volver al paso actual · [q] salir']);
  }

  const step = typeof model.step === 'number' ? model.step : model.step === 'done' ? 4 : 0;
  if (step > 0) {
    const labels = columns < 60 ? ['Skills', 'Extras', 'Revisar'] : ['Tu proyecto', 'Opcionales', 'Revisar e instalar'];
    outside(labels.map((label, i) => {
      const n = i + 1;
      return `${n < step ? '✓' : n === step ? '●' : '○'} ${label}`;
    }).join('  /  '), text => text.split('/').map(part => part.includes('●')
      ? accent(part)
      : part.includes('✓') ? c.green(part) : c.dim(part)).join(c.dim('/')));
    outside();
  }

  outside(`${doc.node.supported ? '✓' : '!'} Node ${doc.node.version}  ${Object.entries(doc.clients).map(([name, info]) => `${info.available ? '✓' : '○'} ${name}`).join('  ')}  ${Object.entries(doc.mcp).filter(([client]) => model.config.agent === 'all' || model.config.agent === client).every(([, m]) => READY_LINK_STATES.includes(m.state)) ? '✓ MCP' : '○ MCP pendiente'}`);
  const signals = model.snapshot.inspection.signals;
  outside(`Stack: ${signals.length ? signals.map(s => s.label).join(', ') : 'sin señales Node en la raíz'}`, c.dim);
  for (const signal of model.snapshot.recommendation.unmatchedSignals) outside(`${signal.label}: sin skill empaquetada aún.`, c.dim);
  for (const limit of model.snapshot.inspection.limits.slice(0, 2)) outside(`! ${limit}`, c.yellow);
  if (model.snapshot.inspection.coupling?.coupled && model.step !== 'detached') {
    outside(`✓ acoplado en ${PROJECT_TOOLKIT_DIR}/ · [d] desacoplar`, c.green);
  }
  outside();

  if (model.step === 'detached' && model.resultData) {
    const r = model.resultData;
    add('✓ Proyecto desacoplado limpiamente', c.green);
    add();
    add(`Skills retiradas del proyecto: ${r.removedCount}`);
    add(`Carpeta ${PROJECT_TOOLKIT_DIR}/ retirada: ${r.stateDirRemoved ? 'sí' : 'sin cambios'}`);
    add(`Reglas Git ignore limpiadas: ${r.gitIgnoreCleanedCount}`);
    if (r.conflicts > 0) add(`Archivos propios respetados: ${r.conflicts}`, c.yellow);
    return finish(['[Enter / q] cerrar asistente · [c] comandos']);
  }

  if (model.step === 'detach-preview' && model.detachPlan) {
    const dp = model.detachPlan;
    const actionable = dp.items.filter(item => item.action !== 'conflict');
    add('Vista previa de desacoplado', c.bold);
    add('Aún no se ha borrado nada.', c.yellow);
    add();
    for (const item of actionable.slice(0, 10)) add(`− [${item.client}] ${item.relativePath} (${item.reason})`);
    if (actionable.length > 10) add(`… y ${actionable.length - 10} skill(s) más.`, c.dim);
    if (dp.removeStateDir) add(`− [estado] ${PROJECT_TOOLKIT_DIR}/ (manifiesto y lockfile locales)`);
    for (const update of dp.gitIgnoreUpdates ?? []) add(`− [git] Retirar bloque gestionado de ${update.relativePath}`);
    for (const conflict of dp.items.filter(item => item.action === 'conflict')) add(`! ${conflict.relativePath} — ${conflict.reason}`, c.yellow);
    return finish(['[Enter / s] confirmar desacoplado', '[Esc / Bksp / n] cancelar sin borrar · [c] comandos · [q] salir']);
  }

  if (model.step === 'done' && model.resultData) {
    const r = model.resultData;
    add('✓ Instalación verificada completada', c.green);
    add();
    add(`Modo aplicado en proyecto: ${shortMode}`);
    add(`Skills instaladas en proyecto: ${r.projectLinksCreated} destino(s)`);
    add(`Estado aislado e ignorado en: ${PROJECT_TOOLKIT_DIR}/ (${shortIgnore})`);
    if (model.config.installMode === 'copy') add(`skills-lock.json actualizado: ${r.lockfileWritten ? 'sí' : 'sin cambios'}`);
    if (r.globalApplied || r.levelsCreated > 0) add(`Núcleo global actualizado: ${r.globalApplied ? 'skills enlazadas' : ''} ${r.levelsCreated ? `(${r.levelsCreated} niveles Codex)` : ''}`);
    if (r.conflicts > 0) add(`Conflictos respetados intactos: ${r.conflicts}`, c.yellow);
    add();
    add('Empieza en tu sesión', c.bold);
    for (const cmd of model.snapshot.guide.workflowCommands.slice(0, 5)) {
      add(workflowLabel(cmd), accent);
      add(cmd.description);
    }
    return finish(['[Enter / q] cerrar · [c] comandos', 'Para desacoplar después: npx nexakit detach']);
  }

  if (model.step === 3) {
    const cur = model.configCursor;
    const agentHint = config.agent === 'all'
      ? 'Instala las skills para Claude y Codex. Mantén ambos si usas los dos; cambia este ajuste si solo usas uno.'
      : `Instala las skills solo para ${config.agent === 'claude' ? 'Claude Code' : 'Codex'}. Elige ambos si también usas el otro agente.`;
    const globalHint = config.globalAlreadyReady
      ? 'Las skills base y los agentes de nivel de tu usuario ya están al día. Puedes dejar este ajuste desmarcado.'
      : `Prepara las skills base y los agentes de nivel para todos tus proyectos (${config.pendingGlobalCount} pendientes). ${config.syncGlobalCore ? 'Déjalo marcado si quieres sincronizarlos.' : 'Márcalo si quieres sincronizarlos.'}`;
    const rows = [
      { label: 'Agentes destino', value: AGENT_LABELS[config.agent], hint: agentHint },
      { label: 'Modo en proyecto', value: shortMode, hint: MODE_LABELS[config.installMode] },
      { label: 'Ignorar en Git', value: shortIgnore, hint: GIT_IGNORE_LABELS[config.gitIgnore] },
      { label: 'Núcleo global', value: `${config.syncGlobalCore ? '[x]' : '[ ]'} Sincronizar skills base y agentes de nivel`, hint: globalHint }
    ];
    add('Paso 3 de 3 · Revisar e instalar', c.bold);
    add('Aún no se ha escrito nada en disco.', c.yellow);
    add();
    const chosen = [...model.fundamentalItems, ...model.optionalItems].filter(item => item.checked);
    add(`Skills seleccionadas (${chosen.length})`, c.bold);
    add(chosen.length ? chosen.map(item => item.title).join(', ') : 'No hay skills de proyecto seleccionadas.');
    add();
    add(model.configDraft ? 'Editar configuración de instalación' : 'Configuración de instalación', c.bold);
    add();
    rows.forEach((row, i) => {
      const focused = model.configDraft && i === cur;
      add(`${model.configDraft ? (focused ? '❯ ' : '  ') : ''}${row.label}: ${row.value}`, focused ? selected : plain);
    });
    if (model.configDraft) {
      add('Casillas: [x] activado · [ ] desactivado.', c.dim);
      add();
      add(rows[cur].hint, c.cyan);
      return finish(['[↑/↓] seleccionar ajuste · [Espacio] cambiar / marcar', '[Enter] actualizar vista previa · [Esc / Bksp] descartar ajustes', '[c] comandos · [q] salir']);
    }
    add();
    add('Cambios previstos', c.bold);
    const p = model.previewData;
    if (!p) {
      add('No hay una vista previa válida. Vuelve a las skills y revisa la selección.', c.yellow);
      return finish(['[Bksp/←] volver a opcionales · [c] comandos · [q] salir']);
    }
    if (p.verifiedSkillsCount > 0) add(`✓ Integridad SHA-256 comprobada en ${p.verifiedSkillsCount} skill(s) del catálogo`, c.green);
    if (p.actions.length === 0) add('No hay cambios pendientes de escribir (todo lo seleccionado ya está al día).');
    for (const action of p.actions.slice(0, 12)) {
      const mark = markOf(action);
      add(`${mark} ${action.label}`, mark === '!' ? c.yellow : mark === '✓' ? c.green : mark === '↻' ? c.cyan : plain);
    }
    if (p.actions.length > 12) add(`… y ${p.actions.length - 12} acción(es) más en la selección.`, c.dim);
    if (p.conflictsCount > 0) {
      add();
      add(`! ${p.conflictsCount} conflicto(s) se respetarán sin borrar ni sobrescribir.`, c.yellow);
    }
    if (p.manualCommands.length > 0) {
      add();
      add('Comandos externos sugeridos (opcional)', c.bold);
      for (const cmd of p.manualCommands.slice(0, 2)) add(`$ ${cmd}`, c.cyan);
    }
    return finish(['[Enter / s] confirmar e instalar · [e] editar configuración', `[Bksp/←] volver a opcionales · [Esc / n] cancelar${detachHint}`, '[c] comandos · [q] salir']);
  }

  if (model.step === 1 || model.step === 2) {
    const fundamental = model.step === 1;
    const items = fundamental ? model.fundamentalItems : model.optionalItems;
    const cur = model.cursors[model.step];
    const checkedCount = items.filter(item => item.checked).length;
    add(`Paso ${model.step} de 3 · ${fundamental ? 'Skills para tu proyecto' : 'Skills opcionales'}`, c.bold);
    add(`${checkedCount} de ${items.length} marcadas · archivos comprobados por SHA-256`, c.green);
    add(fundamental ? 'Solo las recomendaciones validadas vienen marcadas. Las compatibles las eliges tú.' : 'Fuera del stack detectado. Tú eliges qué añadir.', c.dim);
    add();
    if (items.length === 0) {
      add(fundamental ? 'No se detectaron frameworks adicionales que requieran skills específicas en este paso.' : 'Todas las skills del catálogo ya encajaron con tu stack en el Paso 1.');
    }
    items.forEach((item, i) => add(`${i === cur ? '❯' : ' '} ${item.checked ? '[x]' : '[ ]'} ${item.title}${item.alreadyReady ? ' · ya instalada' : ''} · ${item.recommendationStatus === 'validated' ? 'Recomendada' : fundamental ? 'Compatible' : 'Opcional'}`, i === cur ? selected : item.checked ? c.green : plain));
    if (items[cur]) {
      add();
      const item = items[cur];
      add(`Por qué: ${item.reasons.length ? item.reasons.join(', ') : 'sin coincidencia con el stack; disponible para elección manual.'}`, c.cyan);
      add(`Utilidad prevista: ${item.summary}`);
      if (item.recommendationStatus === 'validated') {
        add('Recomendada: escenario funcional pasado para los agentes destino.', c.green);
        for (const evidence of item.evidence) add(`Evidencia (${evidence.client}): ${evidence.evidencePath}`, c.dim);
      } else if (fundamental) {
        add('Compatible: utilidad sin validar para este contexto.', c.yellow);
        for (const reason of item.pendingReasons) add(`Pendiente: ${reason}`, c.dim);
      }
      if (item.overlapsWith.length > 0) add(`Comparte ámbito con: ${item.overlapsWith.join(', ')}. Revisa si necesitas ambas.`, c.dim);
      if (item.installationStatus === 'conflict') add('Instalación: hay archivos propios o modificados; se conservarán.', c.yellow);
      if (item.reviewStatus === 'reviewed-with-observations') add(`Observaciones: ${item.reviewNotes}`, c.yellow);
      add(`Integridad: SHA-256 comprobado · Licencia: ${item.license}`, c.dim);
      add('La integridad de los archivos no acredita su utilidad.', c.dim);
    }
    if (!fundamental && model.snapshot.recommendation.addons.length > 0) {
      add();
      add('Añadido externo opcional · sin descarga automática', c.bold);
      for (const addon of model.snapshot.recommendation.addons) {
        add(`${addon.name} (${addon.versionReviewed} · ${addon.license})`, c.magenta);
        add('4 prácticas base ya adaptadas.', c.dim);
        add(`Claude: ${addon.installHints.claude}`, c.dim);
      }
    }
    return finish([`[↑/↓] mover · [Espacio] marcar/desmarcar · [a] todas · [Enter] ${fundamental ? 'opcionales' : 'revisar instalación'}`, `${fundamental ? '' : '[Bksp/←] atrás · '}[c] comandos${detachHint} · [q] salir`]);
  }

  return finish();
}

export async function computeInstallPreview(model, setupOptions = {}) {
  const actions = [];
  let conflictsCount = 0;
  const home = await resolveHome(setupOptions);
  const activeAgent = model.config.agent;
  const activeMode = model.config.installMode;
  const activeGitIgnore = model.config.gitIgnore ?? 'gitignore';

  let freshSetupPreview = null;
  let freshLevelsPlan = null;
  if (model.config.syncGlobalCore) {
    freshSetupPreview = await setupToolkit({
      ...setupOptions,
      agent: activeAgent,
      apply: false,
      ...(model.snapshot.codexProfile && { codexProfile: model.snapshot.codexProfile })
    });
    // Installed links say nothing; links into another valid copy are named once, below.
    const grouped = new Set(freshSetupPreview.legacy.flatMap(group => group.targets));
    const skipped = new Set(freshSetupPreview.otherCopy?.missing ?? []);
    for (const s of freshSetupPreview.skills) {
      const where = `[global ${s.client}] ${s.name}`;
      if (s.state === 'falta' && !skipped.has(s.name)) {
        actions.push({ kind: 'create', mark: '+', label: where });
      } else if (s.state === 'efimero') {
        actions.push({ kind: 'move', mark: '↻', label: `${where}: mover a la copia estable` });
      } else if (s.state === 'roto-propio') {
        actions.push({ kind: 'repair', mark: '↻', label: `${where}: reparar` });
      } else if (s.state === 'roto-ajeno' && !grouped.has(s.target)) {
        conflictsCount++;
        actions.push({ kind: 'conflict', mark: '!', label: `${where}: enlace roto que no es de nexakit (no se toca)` });
      } else if (s.state === 'conflicto') {
        conflictsCount++;
        actions.push({ kind: 'conflict', mark: '!', label: `${where}: ocupado por algo tuyo (no se toca)` });
      }
    }
    for (const group of freshSetupPreview.legacy) {
      conflictsCount += group.targets.length;
      const where = shortPath(group.root, home);
      actions.push({ kind: 'legacy', mark: '!', label: `${group.targets.length} enlaces rotos hacia ${where} parecen de una instalación anterior. Si son de nexakit: npx nexakit reparar --desde ${where}` });
    }
    if (freshSetupPreview.otherCopy) {
      const { root, missing } = freshSetupPreview.otherCopy;
      actions.push({ kind: 'info', mark: '✓', label: `Usa tu copia en ${shortPath(root, home)}` });
      if (missing.length) {
        actions.push({ kind: 'info', mark: '!', label: `Tu copia en ${shortPath(root, home)} no incluye ${missing.length} ${missing.length === 1 ? 'skill nueva' : 'skills nuevas'}; actualízala` });
      }
    }

    if (activeAgent !== 'claude') {
      freshLevelsPlan = await levelAgentPlan(setupOptions.codexHome ? { codexHome: setupOptions.codexHome } : {});
      for (const f of freshLevelsPlan.files) {
        if (f.state === 'nuevo') {
          actions.push({ kind: 'create', label: `[nivel codex] ${f.name} → ${f.path}` });
        } else if (f.state === 'distinto') {
          conflictsCount++;
          actions.push({ kind: 'conflict', label: `[distinto respetado] ${f.path} (no se sobrescribe)` });
        }
      }
    }
  }

  const selectedProjectSkills = [
    ...model.fundamentalItems.filter(i => i.checked).map(i => i.skillName),
    ...model.optionalItems.filter(i => i.checked).map(i => i.skillName)
  ];

  let freshProjectPlan = null;
  if (selectedProjectSkills.length > 0) {
    freshProjectPlan = await planProjectSkillInstall({
      projectRoot: model.snapshot.inspection.projectRoot,
      skillNames: selectedProjectSkills,
      agent: activeAgent,
      mode: activeMode,
      gitIgnore: activeGitIgnore,
      catalog: model.snapshot.catalog,
      toolkitRoot: setupOptions.toolkitRoot ?? TOOLKIT_ROOT,
      ...(setupOptions.homeDirectory && { homeDirectory: setupOptions.homeDirectory })
    });
    const verb = activeMode === 'copy' ? 'copia' : 'enlace';
    for (const l of freshProjectPlan.links) {
      const relTarget = path.relative(model.snapshot.inspection.projectRoot, l.target);
      const where = `[${verb} ${l.client}] ${l.name}`;
      // Links carry the detailed state; copies only the coarse one.
      const state = l.linkState ?? { missing: 'falta', replace: 'falta', installed: 'instalado', conflict: 'conflicto' }[l.state];
      if (state === 'falta') {
        actions.push({ kind: 'create', mark: '+', label: `${where} → ${relTarget}` });
      } else if (state === 'efimero') {
        actions.push({ kind: 'move', mark: '↻', label: `${where}: mover a la copia estable` });
      } else if (state === 'roto-propio') {
        actions.push({ kind: 'repair', mark: '↻', label: `${where}: reparar` });
      } else if (['conflicto', 'roto-ajeno'].includes(state)) {
        conflictsCount++;
        actions.push({ kind: 'conflict', mark: '!', label: `[conflicto ${l.client}] ${relTarget} (no se toca)` });
      }
    }
    if (freshProjectPlan.stateDirConflict) {
      conflictsCount++;
      actions.push({ kind: 'conflict', label: `[conflicto estado] ${PROJECT_TOOLKIT_DIR}/ no es carpeta regular (no se toca)` });
    } else if (freshProjectPlan.willWriteManifest) {
      actions.push({ kind: 'create', label: `[estado] Guardar registro de acoplamiento en ${PROJECT_TOOLKIT_DIR}/manifest.json` });
    }
    if (freshProjectPlan.willWriteLockfile) {
      actions.push({ kind: 'create', label: `[lockfile] Guardar hashes SHA-256 en ${PROJECT_TOOLKIT_DIR}/skills-lock.json` });
    } else if (freshProjectPlan.lockfileConflict) {
      conflictsCount++;
      actions.push({ kind: 'conflict', label: `[conflicto lockfile] ${PROJECT_TOOLKIT_DIR}/skills-lock.json ocupado (no se toca)` });
    }
    const ignoreTargetLabel = activeGitIgnore === 'git-exclude' ? '.git/info/exclude' : '.gitignore';
    if (freshProjectPlan.willUpdateGitIgnore) {
      actions.push({ kind: 'create', label: `[git] Ignorar ${PROJECT_TOOLKIT_DIR}/ y skills instaladas en ${ignoreTargetLabel}` });
    } else if (freshProjectPlan.gitIgnoreConflict) {
      conflictsCount++;
      actions.push({ kind: 'conflict', label: `[conflicto git] ${ignoreTargetLabel} no es archivo regular (no se toca)` });
    } else if (freshProjectPlan.gitIgnoreUnavailable && activeGitIgnore === 'git-exclude') {
      actions.push({ kind: 'conflict', label: '[aviso git] No se detectó .git para .git/info/exclude; cambia a .gitignore si deseas ignorarlo' });
    }
  }

  // Running from an npx cache, the first thing written is the stable copy everything else will point to.
  const globalNeedsStable = Boolean(freshSetupPreview?.ephemeral && !freshSetupPreview.otherCopy && (
    freshSetupPreview.skills.some(s => ACTIONABLE_LINK_STATES.includes(s.state)) ||
    Object.values(freshSetupPreview.mcp.states).some(s => ACTIONABLE_LINK_STATES.includes(s.state))));
  const projectNeedsStable = Boolean(freshProjectPlan?.ephemeral && freshProjectPlan.mode === 'symlink' &&
    freshProjectPlan.links.some(l => ['missing', 'replace'].includes(l.state)));
  if ((globalNeedsStable || projectNeedsStable) && !(await exists(path.join(actualRoot(home), 'package.json')))) {
    actions.unshift({ kind: 'create', mark: '+', label: 'Copia estable de nexakit en ~/.nexakit' });
  }

  const manualCommands = [];
  for (const client of Object.keys(model.snapshot.doctor.mcp)) {
    if ((activeAgent === 'all' || activeAgent === client) && model.snapshot.doctor.registrationCommands[client]) {
      manualCommands.push(model.snapshot.doctor.registrationCommands[client]);
    }
  }
  if (activeAgent !== 'claude' && model.snapshot.doctor.codexSandbox?.command) {
    manualCommands.push(model.snapshot.doctor.codexSandbox.command);
  }

  return {
    actions,
    conflictsCount,
    verifiedSkillsCount: selectedProjectSkills.length,
    manualCommands,
    freshSetupPreview,
    freshLevelsPlan,
    freshProjectPlan
  };
}

export async function executeApprovedPreview(model, setupOptions = {}) {
  const preview = model.previewData;
  let globalApplied = false;
  let levelsCreated = 0;
  let projectLinksCreated = 0;
  let lockfileWritten = false;
  let conflicts = 0;

  if (preview.freshSetupPreview) {
    const res = await setupToolkit({
      ...setupOptions,
      agent: model.config.agent,
      apply: true,
      ...(model.snapshot.codexProfile && { codexProfile: model.snapshot.codexProfile })
    });
    globalApplied = res.applied;
    conflicts += res.conflicts;
  }

  if (preview.freshLevelsPlan) {
    const written = await writeLevelAgents(preview.freshLevelsPlan, { force: false });
    levelsCreated = written.files.filter(f => f.state === 'escrito').length;
    conflicts += written.files.filter(f => f.state === 'distinto').length;
  }

  if (preview.freshProjectPlan) {
    const appliedInstall = await applyProjectSkillInstall(preview.freshProjectPlan, {
      ...(setupOptions.runNpm && { runNpm: setupOptions.runNpm }),
      ...(setupOptions.packageSpec && { packageSpec: setupOptions.packageSpec })
    });
    projectLinksCreated = appliedInstall.created;
    lockfileWritten = appliedInstall.lockfileWritten;
    conflicts += appliedInstall.conflicts;
  }

  return {
    globalApplied,
    levelsCreated,
    projectLinksCreated,
    lockfileWritten,
    conflicts,
    restartRequired: Boolean(globalApplied || levelsCreated > 0 || projectLinksCreated > 0)
  };
}

export function formatRecommendationReport(report) {
  const lines = [
    `Agent Toolkit · Recomendaciones para ${report.projectName}`,
    `Raíz: ${report.projectRoot}${report.profile ? ` · Perfil: ${report.profile}` : ''}${report.client ? ` · Cliente: ${report.client}` : ''}`,
    '',
    'Tecnologías detectadas:'
  ];

  if (report.signals.length === 0) {
    lines.push('  - Ninguna tecnología cubierta detectada automáticamente.');
  } else {
    for (const sig of report.signals) {
      lines.push(`  ✓ ${sig.label} ← ${sig.sources.join(', ')}`);
    }
  }
  for (const unm of report.unmatchedSignals) {
    lines.push(`  • ${unm.label} (sin skill empaquetada aún)`);
  }

  lines.push('', `Recomendaciones con escenario probado (${report.recommended.length}):`);
  if (report.recommended.length === 0) {
    lines.push('  - Ninguna cumple todavía los 4 criterios de escenario probado para este filtro.');
  } else {
    for (const rec of report.recommended) {
      lines.push(`  - ${rec.name} (${rec.license}) ← ${rec.reasons.join(', ')} [tarea: ${rec.taskClass}]`);
    }
  }

  lines.push('', `Skills compatibles por tecnología o perfil, sin escenario validado (${report.candidates.length}):`);
  if (report.candidates.length === 0) {
    lines.push('  - Ninguna skill específica adicional coincide con las señales actuales.');
  } else {
    for (const cand of report.candidates) {
      const state = cand.installed ? ` · en proyecto: ${cand.installed.integrity}` : '';
      lines.push(`  - ${cand.name} (${cand.license}, SHA-256 ✓) ← ${cand.reasons.join(', ')}${state}`);
      lines.push(`    Utilidad prevista: ${cand.summary}`);
      for (const reason of cand.pendingReasons) lines.push(`    Pendiente: ${reason}`);
      if (cand.overlapsWith.length) lines.push(`    Comparte ámbito con: ${cand.overlapsWith.join(', ')}`);
    }
  }

  if (report.optional && report.optional.length > 0) {
    lines.push('', `Opcionales disponibles en el catálogo (${report.optional.length}):`);
    for (const opt of report.optional) {
      lines.push(`  - ${opt.name} (${opt.license}) ← perfil ${opt.profiles.join('/')}`);
    }
  }

  if (report.addons.length > 0) {
    lines.push('', 'Añadidos opcionales:');
    for (const addon of report.addons) {
      lines.push(`  - ${addon.name} (${addon.versionReviewed}, ${addon.license}): ${addon.summary}`);
    }
  }

  if (report.limits.length > 0) {
    lines.push('', 'Límites de la inspección:');
    for (const lim of report.limits) lines.push(`  ! ${lim}`);
  }
  lines.push('', 'SHA-256 comprueba integridad de archivos; no acredita utilidad ni calidad.');

  return lines.join('\n') + '\n';
}

export async function runToolkitTui({
  input = process.stdin,
  output = process.stdout,
  projectRoot = process.cwd(),
  agent = 'all',
  codexProfile,
  setupOptions = {}
} = {}) {
  const snapshot = await buildToolkitTuiSnapshot({
    projectRoot,
    agent,
    codexProfile,
    setupOptions
  });
  const model = createToolkitTuiModel(snapshot);
  const useColor = Boolean(output.isTTY && !process.env.NO_COLOR);

  const render = () => {
    const frame = renderToolkitTuiFrame(model, {
      columns: output.columns || 96,
      color: useColor
    });
    output.write(`\x1b[2J\x1b[H${frame}`);
  };

  const updateReview = async (config = model.config) => {
    let snapshot = model.snapshot;
    let fundamentalItems = model.fundamentalItems;
    let optionalItems = model.optionalItems;
    if (config.agent !== snapshot.agent || config.installMode !== snapshot.installMode) {
      snapshot = await buildToolkitTuiSnapshot({
        projectRoot: snapshot.inspection.projectRoot,
        agent: config.agent,
        installMode: config.installMode,
        profile: snapshot.profile,
        codexProfile: snapshot.codexProfile,
        setupOptions
      });
      const refreshed = createToolkitTuiModel(snapshot);
      const choices = new Map([...fundamentalItems, ...optionalItems].map(item => [item.skillName, item]));
      const preserveChoice = item => {
        const previous = choices.get(item.skillName);
        return previous?.selectionSource === 'user'
          ? { ...item, checked: previous.checked, selectionSource: 'user' }
          : item;
      };
      fundamentalItems = refreshed.fundamentalItems.map(preserveChoice);
      optionalItems = refreshed.optionalItems.map(preserveChoice);
      config = { ...config, globalAlreadyReady: refreshed.config.globalAlreadyReady, pendingGlobalCount: refreshed.config.pendingGlobalCount };
    }
    const previewData = await computeInstallPreview({ ...model, snapshot, config, fundamentalItems, optionalItems }, setupOptions);
    Object.assign(model, { snapshot, config, fundamentalItems, optionalItems, previewData, configDraft: null, step: 3 });
  };

  let cleanedUp = false;
  let processingChain = Promise.resolve();

  return new Promise(resolve => {
    const cleanup = code => {
      if (cleanedUp) return;
      cleanedUp = true;
      input.off?.('data', onData);
      output.off?.('resize', render);
      try {
        if (typeof input.setRawMode === 'function') input.setRawMode(false);
      } catch {}
      try {
        input.pause?.();
      } catch {}
      output.write('\x1b[?25h\n');
      resolve(code);
    };

    const handleKey = async key => {
      if (cleanedUp) return;

      if (key === '\x03') {
        cleanup(0);
        return;
      }

      if (model.showCommands) {
        if (key === 'q' || key === 'Q') {
          cleanup(0);
          return;
        }
        if (key === '\x1b' || key === 'c' || key === 'C' || key === '\t' || key === '?') {
          model.showCommands = false;
          render();
        }
        return;
      }

      if (key === 'c' || key === 'C' || key === '\t' || key === '?') {
        model.showCommands = true;
        render();
        return;
      }

      if (key === 'q' || key === 'Q') {
        cleanup(0);
        return;
      }

      if (model.step === 'done' || model.step === 'detached') {
        if (key === '\r' || key === '\n' || key === '\x1b') {
          cleanup(0);
        }
        return;
      }

      model.statusMessage = null;

      // Detach safe preview confirmation / cancel
      if (model.step === 'detach-preview') {
        if (key === '\x1b' || key === 'n' || key === 'N' || key === '\x7f' || key === '\x08' || key === '\x1b[D') {
          model.step = 1;
          model.detachPlan = null;
          model.statusMessage = 'Desacoplado cancelado; no se eliminó ningún archivo.';
          render();
          return;
        }
        if (key === '\r' || key === '\n' || key === 's' || key === 'S') {
          try {
            const detachedResult = await applyToolkitDetach(model.detachPlan);
            model.resultData = detachedResult;
            model.step = 'detached';
          } catch (err) {
            model.step = 1;
            model.statusMessage = err?.message || 'No se pudo completar el desacoplado.';
          }
          render();
        }
        return;
      }

      // [d] Detach project shortcut from Steps 1, 2 or 3
      if ((key === 'd' || key === 'D') && !model.configDraft && (model.step === 1 || model.step === 2 || model.step === 3)) {
        try {
          const dp = await planToolkitDetach({
            projectRoot: model.snapshot.inspection.projectRoot,
            includeGlobal: false,
            agent: model.config.agent,
            catalog: model.snapshot.catalog,
            toolkitRoot: setupOptions.toolkitRoot ?? TOOLKIT_ROOT
          });
          const hasWork =
            dp.items.length > 0 ||
            dp.removeStateDir ||
            dp.removeLegacyLockfile ||
            (dp.gitIgnoreUpdates?.length ?? 0) > 0;
          if (!hasWork) {
            model.statusMessage = 'Este proyecto no tiene artefactos acoplados por Agent Toolkit para retirar.';
          } else {
            model.detachPlan = dp;
            model.step = 'detach-preview';
          }
        } catch (err) {
          model.statusMessage = err?.message || 'No se pudo calcular la vista previa de desacoplado.';
        }
        render();
        return;
      }

      // Edit a draft at the final review. Saving only regenerates the preview.
      if (model.step === 3 && model.configDraft) {
        if (key === '\x1b' || key === '\x7f' || key === '\x08') {
          model.configDraft = null;
        } else if (key === '\x1b[A' || key === 'k') {
          model.configCursor = (model.configCursor + 3) % 4;
        } else if (key === '\x1b[B' || key === 'j') {
          model.configCursor = (model.configCursor + 1) % 4;
        } else if (key === ' ' || key === '\x1b[C' || key === '\x1b[D') {
          const draft = model.configDraft;
          if (model.configCursor === 0) draft.agent = AGENTS_CYCLE[(AGENTS_CYCLE.indexOf(draft.agent) + 1) % AGENTS_CYCLE.length];
          else if (model.configCursor === 1) draft.installMode = draft.installMode === 'symlink' ? 'copy' : 'symlink';
          else if (model.configCursor === 2) draft.gitIgnore = draft.gitIgnore === 'gitignore' ? 'git-exclude' : 'gitignore';
          else draft.syncGlobalCore = !draft.syncGlobalCore;
        } else if (key === '\r' || key === '\n') {
          try {
            await updateReview(model.configDraft);
          } catch (err) {
            model.statusMessage = err?.message || 'No se pudo actualizar la vista previa. No se ha instalado nada.';
          }
        }
        render();
        return;
      }

      if (model.step === 3) {
        if (key === 'e' || key === 'E') {
          model.configDraft = { ...model.config };
          model.configCursor = 0;
        } else if (key === '\x7f' || key === '\x08' || key === '\x1b[D') {
          model.step = 2;
          model.previewData = null;
        } else if (key === '\x1b' || key === 'n' || key === 'N') {
          model.step = 1;
          model.previewData = null;
          model.statusMessage = 'Instalación cancelada; no se modificó ningún archivo.';
        } else if ((key === '\r' || key === '\n' || key === 's' || key === 'S') && model.previewData) {
          try {
            model.resultData = await executeApprovedPreview(model, setupOptions);
            model.step = 'done';
          } catch (err) {
            model.step = 1;
            model.previewData = null;
            model.statusMessage = err?.message || 'No se pudo completar la instalación.';
          }
        }
        render();
        return;
      }

      // Back from optional skills keeps both lists and their choices intact.
      if (model.step === 2 && (key === '\x7f' || key === '\x08' || key === '\x1b[D')) {
        model.step = 1;
        render();
        return;
      }

      // Project and optional skill list controls
      const activeList = model.step === 1 ? model.fundamentalItems : model.optionalItems;
      const stepNum = model.step;

      if ((key === '\x1b[A' || key === 'k') && activeList.length > 0) {
        model.cursors[stepNum] = (model.cursors[stepNum] - 1 + activeList.length) % activeList.length;
        render();
        return;
      }
      if ((key === '\x1b[B' || key === 'j') && activeList.length > 0) {
        model.cursors[stepNum] = (model.cursors[stepNum] + 1) % activeList.length;
        render();
        return;
      }
      if (key === ' ' && activeList.length > 0) {
        const item = activeList[model.cursors[stepNum]];
        if (item) {
          item.checked = !item.checked;
          item.selectionSource = 'user';
        }
        render();
        return;
      }
      if ((key === 'a' || key === 'A') && activeList.length > 0) {
        const allChecked = activeList.every(i => i.checked);
        for (const item of activeList) {
          item.checked = !allChecked;
          item.selectionSource = 'user';
        }
        render();
        return;
      }
      if (key === '\r' || key === '\n') {
        if (model.step === 1) {
          model.step = 2;
          render();
          return;
        }
        // Optional skills -> final review
        try {
          await updateReview();
        } catch (err) {
          model.statusMessage = err?.message || 'No se pudo comprobar la vista previa.';
        }
        render();
      }
    };

    const onData = chunk => {
      const key = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      if (key === '\x03') {
        cleanup(0);
        return;
      }
      processingChain = processingChain.then(() => handleKey(key)).catch(() => {});
    };

    try {
      output.write('\x1b[?25l');
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
