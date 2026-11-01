import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import { loadSkillCatalog } from './skill-catalog.js';
import {
  applyToolkitDetach,
  formatDetachReport,
  inspectSkillProject,
  planToolkitDetach,
  recommendSkills
} from './skill-recommendations.js';
import { formatRecommendationReport, runToolkitTui } from './toolkit-tui.js';
import { doctorToolkit, setupToolkit } from './toolkit-setup.js';
import { applyLegacyRepair, planLegacyRepair } from './legacy-repair.js';
import { READY_LINK_STATES } from './link-states.js';

const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const RECOMMEND_PROFILES = ['frontend', 'backend', 'mcp', 'security'];

const HELP = `Uso: npx nexakit [tui] [--project <ruta>] [--agent codex|claude|all] [--perfil-codex <nombre>]
     npx nexakit recommend [--project <ruta>] [--profile frontend|backend|mcp|security] [--client codex|claude] [--dry-run] [--json]
     npx nexakit detach [--project <ruta>] [--global] [--agent codex|claude|antigravity|all] [--apply] [--json]
     npx nexakit reparar --desde <ruta> [--agent codex|claude|antigravity|all]
     npx nexakit doctor [--agent codex|claude|antigravity|all] [--perfil-codex <nombre>] [--json]
     npx nexakit setup [--agent codex|claude|antigravity|all] [--perfil-codex <nombre>] [--apply] [--json]

(Alias local compatible: agent-toolkit)
En una terminal interactiva, npx nexakit abre el asistente por pasos:
detecta el stack del proyecto, sugiere skills verificadas por SHA-256,
guarda su estado aislado e ignorado en Git bajo .agent-toolkit/ y aplica
instalaciones o desacoplados ([d]) tras vista previa segura.
recommend inspecciona el proyecto en solo lectura sin escribir ni usar red.
detach retira las skills acopladas, .agent-toolkit/ y el bloque de ignore sin
tocar archivos propios (--apply para ejecutar; --global incluye ~/.claude y ~/.codex).
reparar re-apunta los enlaces rotos de una instalación anterior (--desde es la carpeta que ya no
existe). No puede comprobar que sean de nexakit, así que lista lo que encontró y siempre pregunta.
setup prepara enlaces globales de las skills base; --apply los crea sin reemplazar
archivos existentes. Imprime los comandos MCP para registrar por separado.
doctor comprueba instalación local sin iniciar modelos. Reinicia los clientes
tras registrar el MCP. Con Codex, también indica si su sandbox deja escribir en
~/.agent-toolkit (lo necesita $revisar) y el comando para permitirlo. Si abres
Codex con --profile, indica ese perfil con --perfil-codex.
Superpowers es un plugin opcional independiente.
`;

export async function runToolkitCli(
  argv,
  { out, err, input = process.stdin, output = process.stdout, isTTY, options = {} } = {}
) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) {
    await out(HELP);
    return 0;
  }

  if (argv.length === 0 || argv[0] === 'tui') {
    const rest = argv[0] === 'tui' ? argv.slice(1) : [];
    const parsed = { agent: 'all', projectRoot: process.cwd() };
    const seen = new Set();
    for (let i = 0; i < rest.length; i++) {
      const flag = rest[i];
      if (seen.has(flag)) { await err(HELP); return 2; }
      seen.add(flag);
      if (flag === '--project' && rest[i + 1]) parsed.projectRoot = rest[++i];
      else if (flag === '--agent' && ['codex', 'claude', 'all'].includes(rest[i + 1])) parsed.agent = rest[++i];
      else if (flag === '--perfil-codex' && PROFILE_RE.test(rest[i + 1] ?? '')) parsed.codexProfile = rest[++i];
      else { await err(HELP); return 2; }
    }
    const interactive = Boolean(isTTY ?? (input?.isTTY && output?.isTTY));
    if (!interactive) {
      await err(HELP);
      return 2;
    }
    try {
      return await runToolkitTui({
        input,
        output,
        projectRoot: parsed.projectRoot,
        agent: parsed.agent,
        codexProfile: parsed.codexProfile,
        setupOptions: options
      });
    } catch {
      await err('No se pudo abrir la interfaz interactiva. Revisa la ruta del proyecto y los permisos.\n');
      return 1;
    }
  }

  const [command, ...rest] = argv;

  if (command === 'recommend') {
    const parsed = { projectRoot: process.cwd(), json: false };
    const seen = new Set();
    for (let i = 0; i < rest.length; i++) {
      const flag = rest[i];
      if (seen.has(flag)) { await err(HELP); return 2; }
      seen.add(flag);
      if (flag === '--project' && rest[i + 1]) parsed.projectRoot = rest[++i];
      else if (flag === '--profile' && RECOMMEND_PROFILES.includes(rest[i + 1])) parsed.profile = rest[++i];
      else if (flag === '--client' && ['codex', 'claude'].includes(rest[i + 1])) parsed.client = rest[++i];
      else if (flag === '--dry-run') parsed.dryRun = true;
      else if (flag === '--json') parsed.json = true;
      else { await err(HELP); return 2; }
    }
    try {
      const catalogUrl = options.toolkitRoot
        ? pathToFileURL(path.join(options.toolkitRoot, 'catalogs/skills.json'))
        : undefined;
      const catalog = await loadSkillCatalog(catalogUrl ? { catalogUrl } : {});
      const inspection = await inspectSkillProject(parsed.projectRoot, {
        ...(parsed.client && { client: parsed.client }),
        ...(options.toolkitRoot && { toolkitRoot: options.toolkitRoot }),
        catalog
      });
      const report = recommendSkills({
        catalog,
        inspection,
        ...(parsed.profile && { profile: parsed.profile }),
        ...(parsed.client && { client: parsed.client })
      });
      await out(parsed.json ? JSON.stringify(report) + '\n' : formatRecommendationReport(report));
      return 0;
    } catch {
      await err('No se pudo analizar el proyecto o cargar el catálogo confiable de skills.\n');
      return 2;
    }
  }

  if (command === 'reparar') return runRepair(rest, { out, err, input, output, isTTY, options });

  if (command === 'detach' || command === 'unlink') {
    const parsed = { projectRoot: process.cwd(), agent: 'all', global: false, apply: false, json: false };
    const seen = new Set();
    for (let i = 0; i < rest.length; i++) {
      const flag = rest[i];
      if (seen.has(flag)) { await err(HELP); return 2; }
      seen.add(flag);
      if (flag === '--project' && rest[i + 1]) parsed.projectRoot = rest[++i];
      else if (flag === '--agent' && ['codex', 'claude', 'antigravity', 'all'].includes(rest[i + 1])) parsed.agent = rest[++i];
      else if (flag === '--global') parsed.global = true;
      else if (flag === '--apply') parsed.apply = true;
      else if (flag === '--json') parsed.json = true;
      else { await err(HELP); return 2; }
    }
    try {
      const catalogUrl = options.toolkitRoot
        ? pathToFileURL(path.join(options.toolkitRoot, 'catalogs/skills.json'))
        : undefined;
      const catalog = await loadSkillCatalog(catalogUrl ? { catalogUrl } : {});
      const plan = await planToolkitDetach({
        projectRoot: parsed.projectRoot,
        includeGlobal: parsed.global,
        agent: parsed.agent,
        catalog,
        ...(options.toolkitRoot && { toolkitRoot: options.toolkitRoot }),
        ...(options.homeDirectory && { homeDirectory: options.homeDirectory }),
        ...(options.codexHome && { codexHome: options.codexHome })
      });
      const report = parsed.apply ? await applyToolkitDetach(plan) : plan;
      if (parsed.json) {
        const cleanJson = {
          applied: report.applied,
          projectRoot: report.projectRoot,
          includeGlobal: report.includeGlobal,
          items: report.items.map(({ catalogEntry, ...itemRest }) => itemRest),
          ...(report.applied
            ? {
                removedCount: report.removedCount,
                gitIgnoreCleanedCount: report.gitIgnoreCleanedCount,
                stateDirRemoved: report.stateDirRemoved
              }
            : {
                removeStateDir: report.removeStateDir,
                removeLegacyLockfile: report.removeLegacyLockfile,
                gitIgnoreUpdates: report.gitIgnoreUpdates
              }),
          conflicts: report.conflicts,
          manualCommands: report.manualCommands
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

  if (!['doctor', 'setup'].includes(command)) {
    await err(HELP);
    return 2;
  }

  const parsed = { agent: 'all' };
  const seen = new Set();
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (seen.has(flag)) { await err(HELP); return 2; }
    seen.add(flag);
    if (flag === '--agent' && ['codex', 'claude', 'antigravity', 'all'].includes(rest[i + 1])) parsed.agent = rest[++i];
    else if (flag === '--json') parsed.json = true;
    else if (flag === '--perfil-codex' && PROFILE_RE.test(rest[i + 1] ?? '')) parsed.codexProfile = rest[++i];
    else if (flag === '--apply' && command === 'setup') parsed.apply = true;
    else { await err(HELP); return 2; }
  }
  try {
    const result = await (command === 'setup' ? setupToolkit : doctorToolkit)({ ...options, ...parsed });
    await out(JSON.stringify(result, null, parsed.json ? 0 : 2) + '\n');
    return command === 'setup'
      ? result.conflicts ? 1 : 0
      : result.node.supported &&
        Object.values(result.dependencies).every(Boolean) &&
        Object.values(result.clients).every(c => c.available) &&
        Object.values(result.mcp).every(m => READY_LINK_STATES.includes(m.state)) &&
        result.skills.every(s => READY_LINK_STATES.includes(s.state)) &&
        (!result.codexSandbox || ['allowed', 'not-needed', 'unknown'].includes(result.codexSandbox.state))
        ? 0
        : 1;
  } catch {
    await err('No se pudo inspeccionar o instalar. Revisa rutas, permisos y conflictos; no se reemplazan destinos.\n');
    return 1;
  }
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// Reads one line, and treats anything but "s" (including no answer at all) as no. The answer comes from the
// `line` event, which always precedes `close`, so an input that ends right after the answer is not lost.
async function askYesNo(input, output) {
  const rl = readline.createInterface({ input, ...(output?.isTTY && { output }) });
  try {
    const answer = await new Promise(resolve => {
      let answered = false;
      rl.once('line', line => { answered = true; resolve(line); });
      rl.once('close', () => { if (!answered) resolve(''); });
    });
    return /^s(í|i)?$/iu.test(answer.trim());
  } finally { rl.close(); }
}

async function runRepair(rest, { out, err, input, output, isTTY, options }) {
  const parsed = { agent: 'all' };
  const seen = new Set();
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (flag === '--si') { await err('reparar siempre pregunta; no admite --si.\n'); return 2; }
    if (seen.has(flag)) { await err(HELP); return 2; }
    seen.add(flag);
    if (flag === '--desde' && rest[i + 1]) parsed.from = rest[++i];
    else if (flag === '--agent' && ['codex', 'claude', 'antigravity', 'all'].includes(rest[i + 1])) parsed.agent = rest[++i];
    else { await err(HELP); return 2; }
  }
  if (!parsed.from) { await err(HELP); return 2; }

  const home = options.homeDirectory ?? os.homedir();
  const short = value => (value === home || value.startsWith(home + path.sep) ? `~${value.slice(home.length)}` : value);
  try {
    const plan = await planLegacyRepair({ ...options, ...parsed });
    const from = short(plan.from);
    if (plan.links.length === 0) {
      await out(`No encontré enlaces rotos hacia ${from}.\n`);
      return 0;
    }
    await out([
      `Encontré ${plural(plan.links.length, 'enlace roto', 'enlaces rotos')} hacia ${from}.`,
      'No puedo comprobar que sean de nexakit: revisa la lista.',
      ...plan.links.map(link => `  ${link.client} · ${link.name}`),
      ''
    ].join('\n'));
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
    if (result.changed) lines.push(`${plural(result.changed, 'enlace cambió', 'enlaces cambiaron')} mientras confirmabas y no se tocó; vuelve a ejecutar el comando.`);
    if (result.skipped.length) lines.push(`No se repararon ${result.skipped.join(', ')}: la copia en uso no las incluye.`);
    if (result.mcpCommands.length) {
      lines.push('El MCP de revisión cruzada también apunta ahí. Para moverlo ejecuta:', ...result.mcpCommands.map(command => `  ${command}`));
    }
    if (result.repaired) lines.push('Reinicia tus agentes para que carguen las skills.');
    await out(lines.join('\n') + '\n');
    return result.changed || result.skipped.length ? 1 : 0;
  } catch {
    await err('No se pudo comprobar ni reparar. Revisa rutas y permisos; no se reemplazan destinos.\n');
    return 1;
  }
}
