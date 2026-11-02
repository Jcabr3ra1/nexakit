import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { getStaticTOMLValue, parseTOML } from 'toml-eslint-parser';
import { agentModels } from './agent-models.js';
import { resolveCliInvocation } from './cli-executable.js';
import { runRevisionProcess } from './revision-process.js';
import pkg from '../package.json' with { type: 'json' };

export async function inspectModels({
  homeDirectory = os.homedir(),
  environment = process.env,
  codexProfile,
  runCommand,
  includeAntigravity = true,
} = {}) {
  const codexHome = environment.CODEX_HOME ?? path.join(homeDirectory, '.codex');
  const claudeHome = environment.CLAUDE_CONFIG_DIR ?? path.join(homeDirectory, '.claude');
  const old = await agentModels({ codexHome, claudeHome });
  let cache = {},
    config = {},
    settings = {};
  try {
    cache = JSON.parse(await fs.readFile(path.join(codexHome, 'models_cache.json'), 'utf8'));
  } catch {}
  try {
    config = getStaticTOMLValue(parseTOML(await fs.readFile(path.join(codexHome, 'config.toml'), 'utf8')));
  } catch {}
  try {
    settings = JSON.parse(await fs.readFile(path.join(claudeHome, 'settings.json'), 'utf8'));
  } catch {}
  const profile = codexProfile ?? config.profile;
  const selected = profile ? config.profiles?.[profile] : null;
  let storedCodex =
    profile && !selected
      ? null
      : {
          model: selected?.model ?? config.model ?? null,
          effort: selected?.model_reasoning_effort ?? config.model_reasoning_effort ?? null,
        };
  // Modern Codex profiles can also be separate files; no shell interpolation.
  if (profile && /^[a-zA-Z0-9._-]+$/u.test(profile)) {
    try {
      const layer = getStaticTOMLValue(
        parseTOML(await fs.readFile(path.join(codexHome, `${profile}.config.toml`), 'utf8')),
      );
      storedCodex = {
        model: layer.model ?? config.model ?? null,
        effort: layer.model_reasoning_effort ?? config.model_reasoning_effort ?? null,
      };
    } catch {}
  }
  let antigravity = [],
    error = null;
  if (includeAntigravity) {
    try {
      let result;
      if (runCommand) result = await runCommand('agy', ['models']);
      else {
        const cli = await resolveCliInvocation({ name: 'agy', environment });
        result = await runRevisionProcess(
          { executable: cli.executable, args: [...cli.argsPrefix, 'models'], env: environment },
          { prompt: '', timeoutMs: 20000 },
        );
      }
      if (result.status !== 0 || result.timedOut) throw new Error('No se pudo consultar agy models.');
      antigravity = result.stdout.split('\n').flatMap((line) => {
        const [model, label] = line.split('\t');
        const effort = model?.match(/-(low|medium|high|xhigh|max)$/u)?.[1];
        return model && label && effort
          ? [{ model, description: label, efforts: [effort], defaultEffort: effort }]
          : [];
      });
    } catch (e) {
      error = e.message;
    }
  }
  const codex = old.codex.models.map((item) => ({
    ...item,
    defaultEffort: cache.models?.find((m) => m.slug === item.model)?.default_reasoning_level ?? null,
  }));
  return {
    catalogs: { claude: old.claude.map((m) => ({ ...m, defaultEffort: 'medium' })), codex, antigravity },
    stored: {
      claude: {
        model: settings.model ?? null,
        effort: settings.modelSettings?.[settings.model]?.effortLevel ?? settings.effortLevel ?? null,
      },
      codex: storedCodex,
      antigravity: null,
    },
    sources: {
      claude: `lista incluida en nexakit ${pkg.version}`,
      codex: 'models_cache.json de Codex',
      antigravity: error ?? 'agy models; el esfuerzo forma parte del id',
    },
    levels: old.levels,
  };
}

export async function validateReviewChoice(options) {
  const data = await inspectModels({ ...options, includeAntigravity: options.client === 'antigravity' });
  const match = data.catalogs[options.client]?.find((item) => item.model === options.model);
  if (!match || !match.efforts.includes(options.effort))
    throw new Error('Modelo o esfuerzo no disponible en el catálogo real; consulta nexakit modelo.');
}
export async function runModelCommand(args, { out, err }, options = {}) {
  let level, client, profile;
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i],
      value = args[++i];
    if (seen.has(flag) || !value) {
      await err('Argumentos de modelo inválidos.\n');
      return 2;
    }
    seen.add(flag);
    if (flag === '--nivel') level = value;
    else if (flag === '--ia') client = value;
    else if (flag === '--perfil-codex') profile = value;
    else return 2;
  }
  if (client && !['claude', 'codex', 'antigravity'].includes(client)) return 2;
  const data = await inspectModels({ ...options, codexProfile: profile });
  const row = level ? data.levels.find((x) => x.level.toLowerCase() === level.toLowerCase()) : null;
  if (level && !row) return 2;
  for (const ia of client ? [client] : ['claude', 'codex', 'antigravity']) {
    await out(`${ia}: ${data.sources[ia]}\n`);
    for (const model of data.catalogs[ia])
      await out(
        `  ${model.model} · ${model.efforts.join(', ')} · defecto ${model.defaultEffort ?? 'no informado'}\n`,
      );
    const stored = data.stored[ia],
      wanted = row?.[ia];
    const mark =
      !stored?.model || !stored?.effort || !wanted
        ? '?'
        : stored.model === wanted.model && stored.effort === wanted.effort
          ? '✓'
          : '→';
    await out(
      `${mark} Guardado: ${stored?.model ?? 'no comprobable'} · ${stored?.effort ?? 'no informado'}${wanted ? ` · recomendado ${wanted.model} · ${wanted.effort}` : ''}\n`,
    );
  }
  await out('Compara lo guardado; una sesión abierta puede diferir. Compruébalo en /model.\n');
  return 0;
}
