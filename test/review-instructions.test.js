import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  planReviewInstructions,
  applyReviewInstructions,
  removeReviewInstructions,
} from '../src/review-instructions.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
test('instructions preserve user content, are idempotent and detach only the managed block', async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'review-instructions-'));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(projectRoot, '.codex'));
  await fs.writeFile(path.join(projectRoot, '.codex', 'AGENTS.md'), 'USER RULES\n');
  const lock = { assertHeld: async () => {} };
  const plan = await planReviewInstructions({ homeDirectory: projectRoot });
  assert.equal(plan.items.length, 3);
  await applyReviewInstructions(plan, lock);
  assert.ok(
    (await fs.readFile(path.join(projectRoot, '.codex', 'AGENTS.md'), 'utf8')).startsWith('USER RULES\n'),
  );
  assert.ok(
    (await planReviewInstructions({ homeDirectory: projectRoot })).items.every((i) => i.state === 'ready'),
  );
  await removeReviewInstructions({ homeDirectory: projectRoot }, lock);
  assert.equal(await fs.readFile(path.join(projectRoot, '.codex', 'AGENTS.md'), 'utf8'), 'USER RULES\n');
  await assert.rejects(fs.access(path.join(projectRoot, '.claude', 'CLAUDE.md')));
});
test('instructions reject a file changed after confirmation and preserve it', async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'review-race-'));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  const plan = await planReviewInstructions({ homeDirectory: projectRoot });
  await fs.mkdir(path.join(projectRoot, '.codex'));
  await fs.writeFile(path.join(projectRoot, '.codex', 'AGENTS.md'), 'changed');
  await assert.rejects(applyReviewInstructions(plan, { assertHeld: async () => {} }), /cambió/);
  assert.equal(await fs.readFile(path.join(projectRoot, '.codex', 'AGENTS.md'), 'utf8'), 'changed');
});

test('edited managed rules are left alone during uninstall', async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'review-edit-'));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  const lock = { assertHeld: async () => {} };
  await applyReviewInstructions(await planReviewInstructions({ homeDirectory: projectRoot }), lock);
  const target = path.join(projectRoot, '.claude', 'CLAUDE.md');
  const edited = (await fs.readFile(target, 'utf8')).replace('Método de trabajo', 'Reglas propias');
  await fs.writeFile(target, edited);
  await removeReviewInstructions({ homeDirectory: projectRoot }, lock);
  assert.equal(await fs.readFile(target, 'utf8'), edited);
});

test('global instructions respect CODEX_HOME and never alter project files', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'review-global-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const homeDirectory = path.join(root, 'home'),
    projectRoot = path.join(root, 'project');
  await fs.mkdir(homeDirectory);
  await fs.mkdir(projectRoot);
  for (const name of ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md'])
    await fs.writeFile(path.join(projectRoot, name), 'PROJECT RULES\n');
  execFileSync('git', ['init', '-q', projectRoot]);
  execFileSync('git', ['-C', projectRoot, 'add', '.']);
  const trackedBefore = execFileSync('git', ['-C', projectRoot, 'diff', '--cached'], { encoding: 'utf8' });
  const environment = { CODEX_HOME: path.join(root, 'custom-codex') };
  const plan = await planReviewInstructions({ homeDirectory, projectRoot, environment });
  const lock = { assertHeld: async () => {} };
  await applyReviewInstructions(plan, lock);
  assert.ok(
    (await fs.readFile(path.join(environment.CODEX_HOME, 'AGENTS.md'), 'utf8')).includes(
      'Si el usuario dice',
    ),
  );
  assert.ok(
    (await fs.readFile(path.join(homeDirectory, '.claude', 'CLAUDE.md'), 'utf8')).includes('nexakit'),
  );
  assert.ok(
    (await fs.readFile(path.join(homeDirectory, '.gemini', 'GEMINI.md'), 'utf8')).includes('nexakit'),
  );
  assert.ok((await fs.stat(path.join(homeDirectory, '.nexakit', 'review-instructions.json'))).isFile());
  for (const name of ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md'])
    assert.equal(await fs.readFile(path.join(projectRoot, name), 'utf8'), 'PROJECT RULES\n');
  assert.deepEqual(
    (await fs.readdir(projectRoot)).filter((name) => name !== '.git'),
    ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'],
  );
  assert.equal(
    execFileSync('git', ['-C', projectRoot, 'diff', '--cached'], { encoding: 'utf8' }),
    trackedBefore,
  );
  assert.equal(execFileSync('git', ['-C', projectRoot, 'diff'], { encoding: 'utf8' }), '');
});

test('global detach resolves the injected CODEX_HOME and preserves the rest of that file', async (t) => {
  const { planToolkitDetach, applyToolkitDetach } = await import('../src/skill-recommendations.js');
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'review-global-detach-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const homeDirectory = path.join(root, 'home'),
    projectRoot = path.join(root, 'repo');
  const environment = { CODEX_HOME: path.join(root, 'custom-codex') };
  await fs.mkdir(homeDirectory);
  await fs.mkdir(projectRoot);
  await fs.mkdir(environment.CODEX_HOME);
  const target = path.join(environment.CODEX_HOME, 'AGENTS.md');
  await fs.writeFile(target, 'USER CODEX RULES\n');
  await applyReviewInstructions(
    await planReviewInstructions({ homeDirectory, environment, agents: ['codex'] }),
    { assertHeld: async () => {} },
  );
  const plan = await planToolkitDetach({
    projectRoot,
    homeDirectory,
    environment,
    includeGlobal: true,
    agent: 'codex',
  });
  assert.deepEqual(plan.reviewInstructions, ['AGENTS.md']);
  await applyToolkitDetach(plan);
  assert.equal(await fs.readFile(target, 'utf8'), 'USER CODEX RULES\n');
});

test('global block stays brief, includes project-handoff trigger, new session line and cerrar-memoria, and upgrades Phase 4 blocks in place', async (t) => {
  const homeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'review-phase5-'));
  t.after(() => fs.rm(homeDirectory, { recursive: true, force: true }));
  const lock = { assertHeld: async () => {} };

  // Simulate an existing Phase 4 block registered in ~/.nexakit/review-instructions.json
  const oldBlock = `<!-- nexakit:review:start -->\n# Método de trabajo de nexakit\nBloque anterior de fase 4.\n<!-- nexakit:review:end -->`;
  const oldHash = createHash('sha256').update(oldBlock).digest('hex');
  const claudeTarget = path.join(homeDirectory, '.claude', 'CLAUDE.md');
  await fs.mkdir(path.dirname(claudeTarget), { recursive: true });
  await fs.mkdir(path.join(homeDirectory, '.nexakit'), { recursive: true });
  await fs.writeFile(claudeTarget, `REGLAS DEL USUARIO\n\n${oldBlock}\n`);
  await fs.writeFile(
    path.join(homeDirectory, '.nexakit', 'review-instructions.json'),
    JSON.stringify({
      [claudeTarget]: {
        client: 'claude',
        blockHash: oldHash,
        original: 'REGLAS DEL USUARIO\n',
        created: false,
      },
    }),
  );

  const plan = await planReviewInstructions({ homeDirectory });
  const claudeItem = plan.items.find((i) => i.client === 'claude');
  assert.equal(claudeItem.state, 'pending');
  await applyReviewInstructions(plan, lock);

  for (const rel of [
    ['.claude', 'CLAUDE.md'],
    ['.codex', 'AGENTS.md'],
    ['.gemini', 'GEMINI.md'],
  ]) {
    const content = await fs.readFile(path.join(homeDirectory, ...rel), 'utf8');
    const match = content.match(/<!-- nexakit:review:start -->[\s\S]*?<!-- nexakit:review:end -->/u);
    assert.ok(match, rel.join('/'));
    const block = match[0];
    assert.ok(block.split('\n').length <= 40, `block has too many lines: ${block.split('\n').length}`);
    assert.ok(block.length <= 2200, `block is too long: ${block.length}`);
    assert.match(
      block,
      /si una tarea larga queda a medias —pausa, cambio de IA, bloqueo o cierre— escribe o actualiza la nota de seguimiento con project-handoff/iu,
    );
    assert.match(block, /recomienda sesión nueva en los casos de project-handoff/iu);
    assert.match(block, /cerrar-memoria/u);
    assert.doesNotMatch(block, /\bJuan\b/u);
  }
  const updatedClaude = await fs.readFile(claudeTarget, 'utf8');
  assert.ok(updatedClaude.startsWith('REGLAS DEL USUARIO\n\n'));
  assert.doesNotMatch(updatedClaude, /Bloque anterior de fase 4/u);
});

test('project-handoff and cerrar-memoria skills define vault tracking note, single session permission, four new-session cases, and completion on merge without personal names', async () => {
  const handoffSkill = await fs.readFile(path.join(ROOT, 'skills/project-handoff/SKILL.md'), 'utf8');
  const handoffTemplate = await fs.readFile(
    path.join(ROOT, 'skills/project-handoff/references/handoff-template.md'),
    'utf8',
  );
  const cerrarSkill = await fs.readFile(path.join(ROOT, 'skills/cerrar-memoria/SKILL.md'), 'utf8');
  const cerrarRef = await fs.readFile(path.join(ROOT, 'skills/cerrar-memoria/references/cierre.md'), 'utf8');
  const reviewSrc = await fs.readFile(path.join(ROOT, 'src/review-instructions.js'), 'utf8');

  // Single authorization per session, file tools vs read-only MCP, fallback in chat
  assert.match(handoffSkill, /una sola autorización por sesión/iu);
  assert.match(handoffSkill, /herramientas de archivos/iu);
  assert.match(handoffSkill, /MCP de memoria.*solo lectura/iu);
  assert.match(handoffSkill, /entrega el traspaso.*en el chat/iu);

  // Canonical location, sections and prohibitions
  assert.match(handoffSkill, /03-IMPLEMENTACION\/Planes\/<AAAA-MM-DD>-<slug>-seguimiento\.md/u);
  for (const section of ['Estado', 'Cambio de diseño', 'Revisiones', 'Pendiente', 'Cómo retomar']) {
    assert.match(handoffSkill, new RegExp(section, 'u'));
    assert.match(handoffTemplate, new RegExp(`## ${section}`, 'u'));
  }
  assert.match(handoffSkill, /secretos/iu);
  assert.match(handoffSkill, /conversaciones enteras/iu);
  assert.match(handoffSkill, /plan en curso/iu);
  assert.match(handoffSkill, /commit.*push/iu);

  // Four cases for recommending a new session, writing handoff first, resume phrase, never closing on its own
  assert.match(handoffSkill, /empieza una fase o una tarea grande nueva/iu);
  assert.match(handoffSkill, /instalaron o actualizaron skills o instrucciones globales/iu);
  assert.match(handoffSkill, /cambia de proyecto/iu);
  assert.match(handoffSkill, /resumió su contexto o avisa de que va a hacerlo/iu);
  assert.match(handoffSkill, /Retoma <tarea>; el contexto está en <nota de seguimiento>/u);
  assert.match(handoffSkill, /nunca la cierres por tu cuenta/iu);
  assert.equal(handoffSkill.match(/por (?:tu|su) cuenta/giu).length, 1, 'la regla de no cerrar la sesión se dice una sola vez');
  assert.match(handoffSkill, /entre pasos de una misma tarea/iu);

  // Connection with cerrar-memoria
  assert.match(cerrarSkill, /-seguimiento\.md/u);
  assert.match(cerrarRef, /estado:\s*completado/u);

  for (const text of [handoffSkill, handoffTemplate, cerrarSkill, cerrarRef, reviewSrc]) {
    assert.doesNotMatch(text, /\bJuan\b/u);
  }
});
