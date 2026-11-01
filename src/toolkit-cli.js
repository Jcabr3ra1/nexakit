import path from 'node:path';
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
import { READY_LINK_STATES } from './link-states.js';

const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const RECOMMEND_PROFILES = ['frontend', 'backend', 'mcp', 'security'];

const HELP = `Uso: npx nexakit [tui] [--project <ruta>] [--agent codex|claude|all] [--perfil-codex <nombre>]
     npx nexakit recommend [--project <ruta>] [--profile frontend|backend|mcp|security] [--client codex|claude] [--dry-run] [--json]
     npx nexakit detach [--project <ruta>] [--global] [--agent codex|claude|all] [--apply] [--json]
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

  if (command === 'detach' || command === 'unlink') {
    const parsed = { projectRoot: process.cwd(), agent: 'all', global: false, apply: false, json: false };
    const seen = new Set();
    for (let i = 0; i < rest.length; i++) {
      const flag = rest[i];
      if (seen.has(flag)) { await err(HELP); return 2; }
      seen.add(flag);
      if (flag === '--project' && rest[i + 1]) parsed.projectRoot = rest[++i];
      else if (flag === '--agent' && ['codex', 'claude', 'all'].includes(rest[i + 1])) parsed.agent = rest[++i];
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
