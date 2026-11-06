import fs from 'node:fs/promises';
import path from 'node:path';
import { loadGeneratorsCatalog } from './generators-catalog.js';
import {
  planCleanProject,
  checkRequirements,
  runCleanProject,
  initGit,
  ensureCleanIgnore,
  appendCleanLog,
} from './clean-project.js';
import { runCleanCommand } from './clean-command.js';
import { acquireLock } from './install-lock.js';
import { readCleanProjectAnswers, writeCleanProjectAnswers } from './skill-recommendations.js';
import { gatherSetupState } from './setup-state.js';

export async function createCleanProject(
  { folder, choice, git, insideGit },
  {
    options = {},
    runCommand = runCleanCommand,
    onProgress = () => {},
    gather = gatherSetupState,
    timeoutMs,
    platform = process.platform,
    signal,
  } = {},
) {
  const catalog = await loadGeneratorsCatalog();
  const plan = planCleanProject({ choice, catalog, name: path.basename(folder), platform });
  const requirements = await checkRequirements(plan, catalog, { runCommand, platform, signal });
  if (requirements.some((r) => !r.ok))
    return {
      ok: false,
      failed: { part: 'proyecto', argv: [], output: 'Faltan requisitos para crear el proyecto.' },
    };
  const stat = await fs.lstat(folder).catch((e) => {
    if (e.code === 'ENOENT') return null;
    throw e;
  });
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink()))
    throw Error('La carpeta del proyecto no es segura.');
  if (!stat) await fs.mkdir(folder);
  const root = await fs.realpath(folder),
    saved = await readCleanProjectAnswers(root);
  if (saved)
    return {
      ok: saved.status === 'creado',
      state: await gather({ ...options, start: root }),
      failed: {
        part: 'proyecto',
        argv: [],
        output: 'La creación ya fue registrada; no se ejecutará sobre archivos existentes.',
      },
    };
  const save = async (status) => {
    const lock = await acquireLock(path.join(root, '.agent-toolkit'));
    try {
      await writeCleanProjectAnswers(root, { choice, git, ...status }, lock);
    } finally {
      await lock.release();
    }
  };
  let confirmed = false;
  const result = await runCleanProject(plan, {
    projectRoot: root,
    runCommand,
    onProgress,
    timeoutMs,
    platform,
    signal,
    onCreated: async () => {
      if (!confirmed) {
        await save({ status: 'confirmado' });
        confirmed = true;
      }
    },
  });
  if (!result.ok) {
    await ensureCleanIgnore(root, plan.gitignore);
    await save({ status: 'fallido', failedPart: result.failed.part });
    return { ...result, state: await gather({ ...options, start: root }) };
  }
  let gitResult = 'omitido';
  try {
    await ensureCleanIgnore(root, plan.gitignore);
    if (git && !insideGit)
      gitResult = await initGit(root, {
        runCommand,
        insideGit,
        gitignore: plan.gitignore,
        onCommand: (argv, output) => appendCleanLog(root, `${argv.join(' ')}\n${output}`),
      });
    await save({ status: 'creado' });
    return { ...result, gitResult, state: await gather({ ...options, start: root }) };
  } catch (error) {
    await save({ status: 'fallido', failedPart: 'proyecto' });
    return {
      ok: false,
      done: result.done,
      state: await gather({ ...options, start: root }),
      failed: { part: 'proyecto', argv: error.argv ?? ['git'], output: error.message },
    };
  }
}
