import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applyReviewInstructions, planReviewInstructions } from '../src/review-instructions.js';

const leer = (rel) => fs.readFile(new URL(`../${rel}`, import.meta.url), 'utf8');

test('el bloque global orquesta por niveles, revisa solo bajo demanda y deja el modo tutor a petición', async (t) => {
  const homeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'orquesta-'));
  t.after(() => fs.rm(homeDirectory, { recursive: true, force: true }));
  await applyReviewInstructions(await planReviewInstructions({ homeDirectory }), { assertHeld: async () => {} });
  const block = (await fs.readFile(path.join(homeDirectory, '.claude', 'CLAUDE.md'), 'utf8'))
    .match(/<!-- nexakit:review:start -->[\s\S]*?<!-- nexakit:review:end -->/u)[0];
  assert.doesNotMatch(block, /automáticamente UNA revisión/u);
  assert.doesNotMatch(block, /revision-cruzada/u);
  assert.match(block, /solo con \/revisar/u);
  assert.match(block, /Modo tutor[^.]*solo si (?:la persona )?lo pide/u);
  for (const nivel of ['ligero', 'normal', 'exigente', 'alto']) assert.match(block, new RegExp(nivel, 'u'));
  assert.match(block, /niveles:nivel-<nivel>/u);
  assert.match(block, /nivel_<nivel>/u);
  assert.match(block, /bifurca la\s+sesión \(fork\)/u);
});

test('los subagentes de nivel se ofrecen para cualquier tarea, no solo para la revisión', async () => {
  for (const nivel of ['ligero', 'normal', 'exigente', 'alto']) {
    const md = await leer(`plugins/niveles/agents/nivel-${nivel}.md`);
    assert.doesNotMatch(md, /revision-cruzada|revisión cruzada/u, nivel);
    assert.match(md.match(/^description: (.*)$/mu)[1], /Úsalo (?:para|cuando)/u, nivel);
    assert.match(md, /menos de 200 palabras/u, nivel);
    assert.match(md, /solo rutas con línea/u, nivel);
  }
  const { levelAgentPlan } = await import('../src/level-agents.js');
  assert.equal(typeof levelAgentPlan, 'function');
  assert.doesNotMatch(await leer('src/level-agents.js'), /revision-cruzada|revisión cruzada/u);
  assert.match(await leer('src/level-agents.js'), /menos de 200 palabras/u);
});

test('revisar es la única skill de revisión y revision-cruzada queda retirada', async () => {
  await assert.rejects(fs.access(new URL('../skills/revision-cruzada/SKILL.md', import.meta.url)));
  const revisar = await leer('skills/revisar/SKILL.md');
  assert.doesNotMatch(revisar, /revision-cruzada|automátic/u);
  assert.match(revisar, /--disponibles/u);
  assert.match(revisar, /¿A dónde mando la revisión\?/u);
  const { RETIRED_SKILLS } = await import('../src/toolkit-setup.js');
  assert.ok(RETIRED_SKILLS.includes('revision-cruzada'));
  for (const rel of ['skills/quality-gate/SKILL.md', 'README.md', 'docs/guias/guia-de-comandos.md', 'docs/guias/guia-de-comandos.html', 'docs/skills/superpowers-integration.md', 'docs/agentes/coordinacion/peer-review-workflow.md'])
    assert.doesNotMatch(await leer(rel), /revision-cruzada|[Rr]evisión automática/u, rel);
});
