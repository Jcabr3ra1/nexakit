// Applies the confirmation, block by block, in the fixed order of setup-plan.js. The state is gathered again right
// before applying, so what changed meanwhile is respected. The first block that fails stops the run: what was
// applied stays, nothing is undone, and running `npx nexakit` again resumes from the real state.
import fs from 'node:fs/promises';
import path from 'node:path';
import { connectMemory } from './connect.js';
import { diagnoseMemory } from './doctor.js';
import { initializeMemory } from './init.js';
import { acquireLock } from './install-lock.js';
import { AGENT_NAMES, buildConfirmation } from './setup-plan.js';
import { gatherSetupState } from './setup-state.js';
import {
  applyProjectSkillInstall, applyToolkitDetach, planProjectSkillInstall, planToolkitDetach, writeSetupAnswers
} from './skill-recommendations.js';
import { planStableCommand, writeStableCommand } from './stable-command.js';
import { ensureStableInstall, nexakitDir } from './stable-install.js';
import { packageVersion, setupToolkit } from './toolkit-setup.js';

const RETRY = 'Vuelve a ejecutar `npx nexakit` para reintentar.';

// Project skill folders: Claude reads .claude/skills; Codex and Antigravity share .agents/skills.
function projectAgent(agents) {
  const claude = agents.includes('claude');
  const shared = agents.includes('codex') || agents.includes('antigravity');
  if (claude && shared) return 'all';
  if (claude) return 'claude';
  return agents.includes('codex') ? 'codex' : 'antigravity';
}

// An older memory may not declare an agent (Antigravity came later): declare it, enabled, with the same skill.
// Only this repository's memory is touched, and the read-modify-replace runs under the install lock.
async function ensureMemoryAgent(vaultPath, agent, repositoryRoot, lock) {
  const file = path.join(vaultPath, 'project-memory.json');
  await lock.assertHeld();
  const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
  const source = await fs.realpath(manifest.source?.repositoryPath ?? '').catch(() => null);
  if (source !== await fs.realpath(repositoryRoot)) throw new Error('La memoria es de otro proyecto; no se modifica.');
  const current = manifest.agents.find(entry => entry.id === agent);
  if (current?.enabled) return;
  if (current) current.enabled = true;
  else manifest.agents.push({ id: agent, enabled: true, skillName: manifest.agents[0]?.skillName ?? manifest.project.id });
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  try {
    await lock.assertHeld();
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function withLock(homeDirectory, acquire, fn) {
  const lock = await acquire(nexakitDir(homeDirectory));
  try { return await fn(lock); } finally { await lock.release(); }
}

export async function applySetup(options, answers, { onProgress = () => {}, runNpm, packageSpec, acquire = acquireLock, gather = gatherSetupState } = {}) {
  const memoryPath = answers.memory.decision === 'path' ? answers.memory.path : null;
  // The chosen memory path is always inspected again, also one typed in "otra carpeta…".
  const stateOptions = { ...options, memoryPaths: memoryPath ? [memoryPath] : [] };
  const state = await gather(stateOptions);
  const confirmation = buildConfirmation(state, answers);
  const { homeDirectory } = state;
  const { catalog, toolkitRoot, environment, codexHome, nodePath, runCommand } = state.internal;
  let linkRoot = state.internal.linkRoot;
  const done = [];
  let finalCheck = null;

  const blocks = {
    'stable-copy': () => withLock(homeDirectory, acquire, async lock => {
      const result = await ensureStableInstall({ homeDirectory, version: await packageVersion(toolkitRoot), lock,
        ...(runNpm && { runNpm }), ...(packageSpec && { packageSpec }) });
      linkRoot = path.join(nexakitDir(homeDirectory), 'actual');
      return result;
    }),
    'stable-command': () => withLock(homeDirectory, acquire, async lock =>
      writeStableCommand(await planStableCommand({ homeDirectory, nodePath, toolkitRoot: linkRoot }), lock)),
    'project-skills': async () => {
      const chosen = answers.skills.chosen;
      if (chosen.length) {
        const plan = await planProjectSkillInstall({ projectRoot: state.project.root, skillNames: chosen, agent: projectAgent(answers.agents),
          mode: 'symlink', catalog, toolkitRoot, homeDirectory });
        await applyProjectSkillInstall(plan, { ...(runNpm && { runNpm }), ...(packageSpec && { packageSpec }), acquire });
      }
      if (confirmation.removeSkills.length) {
        const detach = await planToolkitDetach({ projectRoot: state.project.root, skillNames: confirmation.removeSkills, catalog, toolkitRoot, homeDirectory });
        await applyToolkitDetach(detach);
      }
    },
    'memory-init': async () => {
      const report = initializeMemory({ destination: memoryPath, projectId: state.project.id, projectName: state.project.displayName,
        sourcePath: state.project.root, syncMode: 'none', agents: answers.agents, apply: true });
      if (report.status === 'conflict') throw new Error('La carpeta de la memoria ya tiene archivos que no son de nexakit.');
      const diagnosis = await diagnoseMemory(memoryPath);
      if (diagnosis.summary.errors > 0) throw new Error('La memoria se creó, pero su comprobación encontró errores.');
    },
    answers: () => withLock(homeDirectory, acquire, lock => writeSetupAnswers(state.project.root, answers, lock)),
    'final-check': async () => {
      const after = buildConfirmation(await gather(stateOptions), answers).lines;
      const pending = after.filter(line => ['+', '−', '↻'].includes(line.mark)).map(line => line.text);
      const warnings = after.filter(line => line.mark === '!').map(line => line.text);
      const memoryErrors = memoryPath ? (await diagnoseMemory(memoryPath)).summary.errors : 0;
      if (memoryErrors) pending.push('la memoria tiene errores');
      finalCheck = pending.length
        ? { ok: false, message: `quedó pendiente: ${pending.join('; ')}.`, warnings }
        : { ok: true, message: warnings.length ? `responde, con avisos: ${warnings.join('; ')}.` : 'todo responde', warnings };
    }
  };
  const runBlock = async id => {
    if (blocks[id]) return blocks[id]();
    const [kind, agent] = id.split(':');
    if (kind === 'global-skills') {
      return setupToolkit({ agent, apply: true, homeDirectory, toolkitRoot, environment, codexHome,
        ...(runNpm && { runNpm }), ...(packageSpec && { packageSpec }), acquire });
    }
    if (kind === 'memory-connect') {
      await withLock(homeDirectory, acquire, lock => ensureMemoryAgent(memoryPath, agent, state.project.root, lock));
      const report = await connectMemory({ targetPath: memoryPath, agentId: agent, apply: true },
        { homeDirectory, nodePath, toolkitRoot: linkRoot, ...(runCommand && { runCommand }) });
      if (report.status === 'conflict') {
        const reason = report.components.find(component => component.action === 'conflict')?.message ?? '';
        throw new Error(`No se pudo conectar la memoria a ${AGENT_NAMES[agent]}: ${reason}`);
      }
      return report;
    }
    throw new Error(`Bloque desconocido: ${id}`);
  };

  for (const { id } of confirmation.blocks) {
    onProgress(id, 'start');
    try {
      await runBlock(id);
    } catch (error) {
      const detail = error instanceof Error ? (error.details?.join(' ') || error.message) : String(error);
      const message = id.startsWith('memory-connect:')
        ? `${detail.startsWith('No se pudo') ? detail : `No se pudo conectar la memoria a ${AGENT_NAMES[id.split(':')[1]]}: ${detail}`} ${RETRY}`
        : `Falló «${confirmation.blocks.find(block => block.id === id).label}»: ${detail} ${RETRY}`;
      onProgress(id, 'failed', message);
      return { ok: false, done, failed: { id, message }, finalCheck };
    }
    done.push(id);
    onProgress(id, 'done');
  }
  // A final check that finds something still pending is a failure: the person must not read «Listo».
  return { ok: finalCheck?.ok ?? true, done, finalCheck };
}
