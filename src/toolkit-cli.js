import os from 'node:os';
import { runCli } from './cli.js';
import { runModelCommand } from './model-command.js';
import { runAhorroCommand } from './ahorro-command.js';
import { runCodexCommand } from './codex-command.js';
import { runLeccionesCommand } from './lecciones-command.js';
import { runRevisionCommand } from './revision.js';
import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import { resolveProjectRoot } from './project-root.js';
import { loadSkillCatalog } from './skill-catalog.js';
import { scanSkillDirectory } from './skill-scan.js';
import { formatScanReport } from './skill-scan-report.js';
import {
  applyToolkitDetach,
  formatDetachReport,
  inspectSkillProject,
  planToolkitDetach,
  recommendSkills,
} from './skill-recommendations.js';
import { formatRecommendationReport } from './recommend-report.js';
import { applySetup } from './setup-apply.js';
import { buildConfirmation, groupLines, joinNames, suggestedAnswers } from './setup-plan.js';
import { gatherSetupState } from './setup-state.js';
import { runSetupTui } from './setup-tui.js';
import { doctorToolkit, setupToolkit } from './toolkit-setup.js';
import { applyLegacyRepair, planLegacyRepair } from './legacy-repair.js';
import { READY_LINK_STATES, REMOVED_BY_USER_STATE, SETTLED_LINK_STATES } from './link-states.js';

const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const SKILL_NAME_RE = /^[a-z0-9-]+$/u;
const RECOMMEND_PROFILES = ['frontend', 'backend', 'mcp', 'security'];

const HELP = `Uso: npx nexakit [--project <ruta>] [--si]
     npx nexakit comprobar [--agent codex|claude|antigravity|all] [--perfil-codex <nombre>] [--json]
     npx nexakit quitar [--project <ruta>] [--global] [--agent codex|claude|antigravity|all] [--si|--apply] [--json]
     npx nexakit reparar --desde <ruta> [--agent codex|claude|antigravity|all]
     npx nexakit memoria <subcomando> [opciones]
     nexakit revision --disponibles [--principal claude|codex|antigravity]
     nexakit revision --con <ia> --modelo <m> --esfuerzo <e> --encargo <archivo> [--base <rama>]
     nexakit modelo [--nivel <nivel>] [--ia claude|codex|antigravity] [--perfil-codex <nombre>]
     nexakit codex auditar|preparar|consumo|hook|ejecutar|comparar [opciones]
     nexakit ahorro [--json]
     nexakit lecciones [--json | --descartar]
     npx nexakit recommend [--project <ruta>] [--profile frontend|backend|mcp|security] [--client codex|claude] [--dry-run] [--json]
     npx nexakit scan <carpeta de skill> [--json]
     npx nexakit doctor [--agent codex|claude|antigravity|all] [--perfil-codex <nombre>] [--json]
     npx nexakit setup [--agent codex|claude|antigravity|all] [--perfil-codex <nombre>] [--omitir <skill>] [--reponer <skill>] [--apply] [--json]

npx nexakit hace tres preguntas con la respuesta ya sugerida (skills, memoria e IA)
y, con una sola confirmación, deja listo el proyecto: skills, memoria conectada a
tus IA y la orden ~/.nexakit/nexakit. Si todo está listo, no pregunta nada.
Sin terminal interactiva muestra lo que haría; --si lo aplica sin preguntas.
comprobar (o doctor) revisa en solo lectura Node, tus IA, skills base y restos antiguos.
quitar (o detach) retira las skills del proyecto, .agent-toolkit/ y su bloque de
.gitignore sin tocar archivos tuyos (--si o --apply para ejecutar; --global incluye las globales).
scan revisa el contenido de una skill sin ejecutarla (1 si encuentra un bloqueo).
reparar re-apunta enlaces rotos de una instalación anterior (--desde es la carpeta
que ya no existe); lista lo que encontró y siempre pregunta.
memoria ejecuta los subcomandos de project-memory (init, connect, doctor, status, sync).
revision y modelo piden una revisión a otra IA o consultan los modelos disponibles.
ahorro resume cuánta salida de comandos recortó el mod nexakit-ahorro (caracteres y tokens estimados).
lecciones resume las correcciones y lecciones que registra el mod nexakit-lecciones y las que siguen pendientes.
recommend inspecciona el proyecto en solo lectura; setup prepara las skills base globales y respeta las que quitaste
(--omitir <skill> declara quitada una que ya no tiene enlace; --reponer <skill> devuelve una; ambos se repiten).
(Alias local compatible: agent-toolkit)
`;

export async function runToolkitCli(
  argv,
  { out, err, input = process.stdin, output = process.stdout, isTTY, options = {} } = {},
) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) {
    await out(HELP);
    return 0;
  }

  if (argv.length === 0 || argv[0] === 'tui' || argv[0].startsWith('--')) {
    const rest = argv[0] === 'tui' ? argv.slice(1) : argv;
    const parsed = { projectRoot: process.cwd(), yes: false };
    const seen = new Set();
    for (let i = 0; i < rest.length; i++) {
      const flag = rest[i];
      if (seen.has(flag)) {
        await err(HELP);
        return 2;
      }
      seen.add(flag);
      if (flag === '--project' && rest[i + 1]) parsed.projectRoot = rest[++i];
      else if (flag === '--si') parsed.yes = true;
      else {
        await err(HELP);
        return 2;
      }
    }
    return runSetup(parsed, { out, err, input, output, isTTY, options });
  }

  const [command, ...rest] = argv;
  if (command === 'modelo') return runModelCommand(rest, { out, err }, options);
  if (command === 'codex') return runCodexCommand(rest, { out, err, input, output }, options);
  if (command === 'ahorro') return runAhorroCommand(rest, { out, err }, options);
  if (command === 'lecciones') return runLeccionesCommand(rest, { out, err }, options);
  if (command === 'revision') return runRevisionCommand(rest, { out, err }, { options });
  if (command === 'memoria') {
    return runCli(
      rest,
      {
        out: (message) => out(`${message}\n`),
        err: (message) => err(`${message}\n`),
      },
      { ...options, commandName: 'npx nexakit memoria' },
    );
  }

  if (command === 'scan') {
    const flags = rest.filter(arg => arg.startsWith('--'));
    const dirs = rest.filter(arg => !arg.startsWith('--'));
    if (dirs.length !== 1 || flags.some(flag => flag !== '--json') || flags.length > 1) {
      await err(HELP);
      return 2;
    }
    try {
      const report = await scanSkillDirectory(dirs[0]);
      await out(flags.length ? JSON.stringify(report, null, 2) + '\n' : formatScanReport(report, dirs[0]));
      return report.blocked ? 1 : 0;
    } catch (error) {
      await err(`No se pudo escanear ${dirs[0]}: ${error.code === 'ENOENT' ? 'la carpeta no existe' : error.message}\n`);
      return 2;
    }
  }

  if (command === 'recommend') {
    const parsed = { projectRoot: process.cwd(), json: false };
    const seen = new Set();
    for (let i = 0; i < rest.length; i++) {
      const flag = rest[i];
      if (seen.has(flag)) {
        await err(HELP);
        return 2;
      }
      seen.add(flag);
      if (flag === '--project' && rest[i + 1]) parsed.projectRoot = rest[++i];
      else if (flag === '--profile' && RECOMMEND_PROFILES.includes(rest[i + 1])) parsed.profile = rest[++i];
      else if (flag === '--client' && ['codex', 'claude'].includes(rest[i + 1])) parsed.client = rest[++i];
      else if (flag === '--dry-run') parsed.dryRun = true;
      else if (flag === '--json') parsed.json = true;
      else {
        await err(HELP);
        return 2;
      }
    }
    try {
      const catalogUrl = options.toolkitRoot
        ? pathToFileURL(path.join(options.toolkitRoot, 'catalogs/skills.json'))
        : undefined;
      const catalog = await loadSkillCatalog(catalogUrl ? { catalogUrl } : {});
      const inspection = await inspectSkillProject(parsed.projectRoot, {
        ...(parsed.client && { client: parsed.client }),
        ...(options.toolkitRoot && { toolkitRoot: options.toolkitRoot }),
        catalog,
      });
      const report = recommendSkills({
        catalog,
        inspection,
        ...(parsed.profile && { profile: parsed.profile }),
        ...(parsed.client && { client: parsed.client }),
      });
      await out(parsed.json ? JSON.stringify(report) + '\n' : formatRecommendationReport(report));
      return 0;
    } catch {
      await err('No se pudo analizar el proyecto o cargar el catálogo confiable de skills.\n');
      return 2;
    }
  }

  if (command === 'reparar') return runRepair(rest, { out, err, input, output, isTTY, options });

  if (command === 'detach' || command === 'unlink' || command === 'quitar') {
    const parsed = { projectRoot: process.cwd(), agent: 'all', global: false, apply: false, json: false };
    const seen = new Set();
    for (let i = 0; i < rest.length; i++) {
      const flag = rest[i];
      if (seen.has(flag)) {
        await err(HELP);
        return 2;
      }
      seen.add(flag);
      if (flag === '--project' && rest[i + 1]) parsed.projectRoot = rest[++i];
      else if (flag === '--agent' && ['codex', 'claude', 'antigravity', 'all'].includes(rest[i + 1]))
        parsed.agent = rest[++i];
      else if (flag === '--global') parsed.global = true;
      else if (flag === '--apply' || flag === '--si') parsed.apply = true;
      else if (flag === '--json') parsed.json = true;
      else {
        await err(HELP);
        return 2;
      }
    }
    try {
      const catalogUrl = options.toolkitRoot
        ? pathToFileURL(path.join(options.toolkitRoot, 'catalogs/skills.json'))
        : undefined;
      const catalog = await loadSkillCatalog(catalogUrl ? { catalogUrl } : {});
      // Skills are installed at the repository root, so they are removed from there too.
      const { root } = await resolveProjectRoot(
        parsed.projectRoot,
        options.homeDirectory ? { homeDirectory: options.homeDirectory } : {},
      );
      const plan = await planToolkitDetach({
        projectRoot: root,
        includeGlobal: parsed.global,
        environment: options.environment ?? (options.homeDirectory ? {} : process.env),
        agent: parsed.agent,
        catalog,
        ...(options.toolkitRoot && { toolkitRoot: options.toolkitRoot }),
        ...(options.homeDirectory && { homeDirectory: options.homeDirectory }),
        ...(options.codexHome && { codexHome: options.codexHome }),
      });
      const report = parsed.apply ? await applyToolkitDetach(plan) : plan;
      if (parsed.json) {
        const cleanJson = {
          applied: report.applied,
          reviewInstructions: report.reviewInstructions ?? [],
          projectRoot: report.projectRoot,
          includeGlobal: report.includeGlobal,
          items: report.items.map(({ catalogEntry, ...itemRest }) => itemRest),
          ...(report.applied
            ? {
                removedCount: report.removedCount,
                gitIgnoreCleanedCount: report.gitIgnoreCleanedCount,
                stateDirRemoved: report.stateDirRemoved,
              }
            : {
                removeStateDir: report.removeStateDir,
                removeLegacyLockfile: report.removeLegacyLockfile,
                gitIgnoreUpdates: report.gitIgnoreUpdates,
              }),
          conflicts: report.conflicts,
          manualCommands: report.manualCommands,
        };
        await out(JSON.stringify(cleanJson) + '\n');
      } else {
        await out(formatDetachReport(report));
      }
      return report.conflicts ? 1 : 0;
    } catch {
      await err('No se pudo inspeccionar o desacoplar el proyecto. Revisa la ruta y los permisos.\n');
      return 1;
    }
  }

  if (!['doctor', 'comprobar', 'setup'].includes(command)) {
    await err(HELP);
    return 2;
  }

  const parsed = { agent: 'all' };
  const seen = new Set();
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if ((flag === '--reponer' || flag === '--omitir') && command === 'setup') {
      const name = rest[i + 1] ?? '';
      if (!SKILL_NAME_RE.test(name)) {
        await err(HELP);
        return 2;
      }
      (parsed[flag === '--reponer' ? 'restore' : 'omit'] ??= []).push(name);
      i++;
      continue;
    }
    if (seen.has(flag)) {
      await err(HELP);
      return 2;
    }
    seen.add(flag);
    if (flag === '--agent' && ['codex', 'claude', 'antigravity', 'all'].includes(rest[i + 1]))
      parsed.agent = rest[++i];
    else if (flag === '--json') parsed.json = true;
    else if (flag === '--perfil-codex' && PROFILE_RE.test(rest[i + 1] ?? '')) parsed.codexProfile = rest[++i];
    else if (flag === '--apply' && command === 'setup') parsed.apply = true;
    else {
      await err(HELP);
      return 2;
    }
  }
  try {
    const result = await (command === 'setup' ? setupToolkit : doctorToolkit)({ ...options, ...parsed });
    if (command === 'comprobar' && !parsed.json) {
      await out(formatComprobarReport(result, { homeDirectory: options.homeDirectory ?? os.homedir() }));
    } else {
      await out(JSON.stringify(result, null, parsed.json ? 0 : 2) + '\n');
    }
    if (command === 'setup') return result.conflicts ? 1 : 0;
    if (command === 'comprobar') {
      return result.node.supported &&
        Object.values(result.dependencies).every(Boolean) &&
        Object.values(result.clients).some((c) => c.available) &&
        result.skills.every((s) => SETTLED_LINK_STATES.includes(s.state)) &&
        !(result.retiredSkills ?? []).some((s) => !s.owned) &&
        superpowersReady(result)
        ? 0
        : 1;
    }
    return result.node.supported &&
      Object.values(result.dependencies).every(Boolean) &&
      Object.values(result.clients).every((c) => c.available) &&
      Object.values(result.mcp).every((m) => READY_LINK_STATES.includes(m.state)) &&
      result.skills.every((s) => SETTLED_LINK_STATES.includes(s.state)) &&
      (!result.codexSandbox || ['allowed', 'not-needed', 'unknown'].includes(result.codexSandbox.state)) &&
      superpowersReady(result)
      ? 0
      : 1;
  } catch {
    await err(
      'No se pudo inspeccionar o instalar. Revisa rutas, permisos y conflictos; no se reemplazan destinos.\n',
    );
    return 1;
  }
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
// The plan under the same headings as the screen; the lines keep their two-space indent below each heading.
const groupedLines = (lines) =>
  groupLines(lines)
    .map((group) => [group.title, ...group.lines.map((line) => `  ${line.mark} ${line.text}`)].join('\n'))
    .join('\n');
// Required: missing or disabled fails the check; a list that could not be read is reported but does not fail.
const superpowersReady = (result) =>
  !Object.values(result.superpowers?.states ?? {}).some((state) => ['falta', 'desactivado'].includes(state));

// nexakit's Claude Code mods: warnings only, a missing mod never fails the check.
function modsReport(mods) {
  if (!mods) return [];
  const names = (state) => Object.keys(mods).filter((name) => mods[name] === state);
  const missing = names('falta'), outdated = names('actualizable'), disabled = names('desactivado');
  const active = names('activo');
  if (names('desconocido').length) return ['! No pude comprobar los mods de Claude Code; revisa /plugin'];
  const lines = [];
  const prefix = '! Mods de Claude Code:';
  const one = (list) => list.length === 1;
  if (missing.length)
    lines.push(`${prefix} ${one(missing) ? 'falta' : 'faltan'} ${joinNames(missing)} (ejecuta npx nexakit para ${one(missing) ? 'instalarlo' : 'instalarlos'})`);
  if (outdated.length)
    lines.push(`${prefix} hay versión nueva de ${joinNames(outdated)} (ejecuta npx nexakit para ${one(outdated) ? 'actualizarlo' : 'actualizarlos'})`);
  if (disabled.length)
    lines.push(`${prefix} ${one(disabled) ? 'desactivado' : 'desactivados'} ${joinNames(disabled)}; ${one(disabled) ? 'actívalo' : 'actívalos'} desde /plugin`);
  if (!lines.length) lines.push(`✓ Mods de Claude Code activos (${active.length} de ${Object.keys(mods).length})`);
  return lines;
}

function formatComprobarReport(result, { homeDirectory }) {
  const short = (value) =>
    value === homeDirectory ||
    value.startsWith(homeDirectory + '/') ||
    value.startsWith(homeDirectory + '\\')
      ? `~${value.slice(homeDirectory.length)}`
      : value;
  const lines = [
    result.node.supported
      ? `✓ Node.js ${result.node.version}`
      : `! Node.js ${result.node.version} (se necesita Node.js 24 o superior)`,
  ];
  const missingDeps = Object.entries(result.dependencies)
    .filter(([, ok]) => !ok)
    .map(([name]) => name);
  lines.push(
    missingDeps.length === 0
      ? '✓ Dependencias instaladas'
      : `! Faltan dependencias: ${missingDeps.join(', ')}`,
  );
  const availableClients = Object.entries(result.clients)
    .filter(([, state]) => state.available)
    .map(([name]) => name);
  lines.push(
    availableClients.length > 0
      ? `✓ IA disponibles: ${availableClients.join(', ')}`
      : '! No encontré ninguna IA instalada (claude, codex o agy)',
  );
  const readySkills = result.skills.filter((s) => READY_LINK_STATES.includes(s.state));
  const removedSkills = result.skills.filter((s) => s.state === REMOVED_BY_USER_STATE);
  const pendingSkills = result.skills.filter((s) => !SETTLED_LINK_STATES.includes(s.state));
  if (pendingSkills.length === 0) {
    lines.push(`✓ Skills base listas (${readySkills.length})`);
  } else {
    lines.push(
      `! ${plural(pendingSkills.length, 'enlace de skill base pendiente o con problema', 'enlaces de skills base pendientes o con problema')} (ejecuta npx nexakit para revisarlos)`,
    );
  }
  if (removedSkills.length > 0) {
    lines.push(
      `✓ ${plural(removedSkills.length, 'skill que quitaste', 'skills que quitaste')} (nexakit no las recrea; para devolver una: npx nexakit setup --reponer <nombre> --apply)`,
    );
  }
  for (const group of result.legacy ?? []) {
    lines.push(
      `! ${plural(group.count, 'enlace roto', 'enlaces rotos')} hacia ${short(group.root)} parecen de una instalación anterior. Si son de nexakit: npx nexakit reparar --desde ${short(group.root)}`,
    );
  }
  for (const item of (result.retiredSkills ?? []).filter((s) => !s.owned)) {
    lines.push(`! ${item.client} · ${item.name}: comando retirado con contenido ajeno; no lo toco`);
  }
  const superpowers = Object.entries(result.superpowers?.states ?? {});
  const active = superpowers.filter(([, state]) => state === 'activo').map(([name]) => name);
  if (active.length) lines.push(`✓ Superpowers activo en ${active.join(', ')}`);
  for (const [name, state] of superpowers.filter(([, state]) => state !== 'activo')) {
    lines.push(
      state === 'falta'
        ? `! Falta Superpowers en ${name} (ejecuta npx nexakit para instalarlo)`
        : state === 'desactivado'
          ? `! Superpowers está desactivado en ${name}; actívalo desde su gestor de plugins`
          : `! No pude comprobar Superpowers en ${name}`,
    );
  }
  lines.push(...modsReport(result.mods));
  for (const item of result.obsolete ?? []) {
    lines.push(`! ${item.message} ${item.command}`);
  }
  return lines.join('\n') + '\n';
}

// Reads one line, and treats anything but "s" (including no answer at all) as no. The answer comes from the
// `line` event, which always precedes `close`, so an input that ends right after the answer is not lost.
async function askYesNo(input, output) {
  const rl = readline.createInterface({ input, ...(output?.isTTY && { output }) });
  try {
    const answer = await new Promise((resolve) => {
      let answered = false;
      rl.once('line', (line) => {
        answered = true;
        resolve(line);
      });
      rl.once('close', () => {
        if (!answered) resolve('');
      });
    });
    return /^s(í|i)?$/iu.test(answer.trim());
  } finally {
    rl.close();
  }
}

async function runRepair(rest, { out, err, input, output, isTTY, options }) {
  const parsed = { agent: 'all' };
  const seen = new Set();
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (flag === '--si') {
      await err('reparar siempre pregunta; no admite --si.\n');
      return 2;
    }
    if (seen.has(flag)) {
      await err(HELP);
      return 2;
    }
    seen.add(flag);
    if (flag === '--desde' && rest[i + 1]) parsed.from = rest[++i];
    else if (flag === '--agent' && ['codex', 'claude', 'antigravity', 'all'].includes(rest[i + 1]))
      parsed.agent = rest[++i];
    else {
      await err(HELP);
      return 2;
    }
  }
  if (!parsed.from) {
    await err(HELP);
    return 2;
  }

  const home = options.homeDirectory ?? os.homedir();
  const short = (value) =>
    value === home || value.startsWith(home + path.sep) ? `~${value.slice(home.length)}` : value;
  try {
    const plan = await planLegacyRepair({ ...options, ...parsed });
    const from = short(plan.from);
    if (plan.links.length === 0) {
      await out(`No encontré enlaces rotos hacia ${from}.\n`);
      return 0;
    }
    await out(
      [
        `Encontré ${plural(plan.links.length, 'enlace roto', 'enlaces rotos')} hacia ${from}.`,
        'No puedo comprobar que sean de nexakit: revisa la lista.',
        ...plan.links.map((link) => `  ${link.client} · ${link.name}`),
        '',
      ].join('\n'),
    );
    const interactive = Boolean(isTTY ?? (input?.isTTY && output?.isTTY));
    if (!interactive) {
      await err('Este comando necesita una terminal interactiva.\n');
      return 2;
    }
    await out('¿Los re-apunto a la copia de nexakit en uso? [s/N]\n');
    if (!(await askYesNo(input, output))) {
      await out('No se cambió nada.\n');
      return 0;
    }
    const result = await applyLegacyRepair(plan, options);
    const lines = [`Listo: ${plural(result.repaired, 'enlace re-apuntado', 'enlaces re-apuntados')}.`];
    if (result.changed)
      lines.push(
        `${plural(result.changed, 'enlace cambió', 'enlaces cambiaron')} mientras confirmabas y no se tocó; vuelve a ejecutar el comando.`,
      );
    if (result.skipped.length)
      lines.push(`No se repararon ${result.skipped.join(', ')}: la copia en uso no las incluye.`);
    if (result.mcpCommands.length) {
      lines.push(
        'El MCP de revisión cruzada también apunta ahí. Para moverlo ejecuta:',
        ...result.mcpCommands.map((command) => `  ${command}`),
      );
    }
    if (result.repaired) lines.push('Reinicia tus agentes para que carguen las skills.');
    await out(lines.join('\n') + '\n');
    return result.changed || result.skipped.length ? 1 : 0;
  } catch {
    await err('No se pudo comprobar ni reparar. Revisa rutas y permisos; no se reemplazan destinos.\n');
    return 1;
  }
}

// Options tests and callers pass (homeDirectory, toolkitRoot, codexHome, environment, runCommand, runNpm, ...).
function setupStateOptions(projectRoot, options) {
  const { runNpm, packageSpec, acquire, ...rest } = options;
  return {
    stateOptions: { ...rest, start: projectRoot },
    applyOptions: {
      ...(runNpm && { runNpm }),
      ...(packageSpec && { packageSpec }),
      ...(acquire && { acquire }),
    },
  };
}

async function runSetup(parsed, { out, err, input, output, isTTY, options }) {
  const { stateOptions, applyOptions } = setupStateOptions(parsed.projectRoot, options);
  const interactive = Boolean(isTTY ?? (input?.isTTY && output?.isTTY));
  try {
    if (interactive && !parsed.yes)
      return await runSetupTui({ input, output, options: stateOptions, applyOptions });
    const state = await gatherSetupState(stateOptions);
    const answers = suggestedAnswers(state);
    const confirmation = buildConfirmation(state, answers);
    const title = `nexakit · ${state.project.displayName}${state.project.fromSubfolder ? ' (repositorio completo)' : ''}`;
    if (confirmation.allReady) {
      await out(
        `${title}\nTodo está listo.\n${groupedLines(confirmation.lines)}\n`,
      );
      return 0;
    }
    if (!parsed.yes) {
      await out(
        `${title}\nCon las respuestas sugeridas prepararía:\n${groupedLines(confirmation.lines)}\n\n` +
          'No hay una terminal interactiva para preguntarte.\nPara aplicarlo sin preguntas: npx nexakit --si\n',
      );
      return 2;
    }
    await out(`${title}\n`);
    const labels = Object.fromEntries(confirmation.blocks.map((block) => [block.id, block.label]));
    const result = await applySetup(stateOptions, answers, {
      ...applyOptions,
      onProgress: async (id, phase, message) => {
        // The final check prints its own line with the result, below.
        if (phase === 'done' && id !== 'final-check') await out(`  ◇ ${labels[id] ?? id}\n`);
        if (phase === 'failed') await err(`  ✗ ${labels[id] ?? id}: ${message}\n`);
      },
    });
    if (result.finalCheck)
      await out(`  ${result.finalCheck.ok ? '◇' : '!'} Comprobación final: ${result.finalCheck.message}\n`);
    if (result.ok) await out('Listo. Cierra y abre tu IA para que cargue las skills y la memoria.\n');
    return result.ok ? 0 : 1;
  } catch (error) {
    await err(`No se pudo preparar el proyecto: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
