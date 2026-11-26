import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applyReviewInstructions, planReviewInstructions } from '../src/review-instructions.js';

const leer = (rel) => fs.readFile(new URL(`../${rel}`, import.meta.url), 'utf8');

test('el bloque global orquesta por niveles, lanza la fábrica por su cuenta y deja el modo tutor a petición', async (t) => {
  const homeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'orquesta-'));
  t.after(() => fs.rm(homeDirectory, { recursive: true, force: true }));
  await applyReviewInstructions(await planReviewInstructions({ homeDirectory }), { assertHeld: async () => {} });
  const block = (await fs.readFile(path.join(homeDirectory, '.claude', 'CLAUDE.md'), 'utf8'))
    .match(/<!-- nexakit:review:start -->[\s\S]*?<!-- nexakit:review:end -->/u)[0];
  assert.doesNotMatch(block, /automáticamente UNA revisión/u);
  assert.doesNotMatch(block, /revision-cruzada/u);
  assert.match(block, /la lanzas tú, sin pedir permiso/u);
  assert.match(block, /La persona también\s+puede pedirla con \/fabrica/u);
  assert.match(block, /Modo tutor[^.]*solo si (?:la persona )?lo pide/u);
  for (const nivel of ['ligero', 'normal', 'exigente', 'alto']) assert.match(block, new RegExp(nivel, 'u'));
  assert.match(block, /niveles:nivel-<nivel>/u);
  assert.match(block, /nivel_<nivel>/u);
  assert.match(block, /bifurca la\s+sesión \(fork\)/u);
  // Los encargos van antes que los subagentes de nivel normal y no compiten con ellos.
  const plano = block.replace(/\s+/gu, ' ');
  assert.match(plano, /Implementar con diseño claro \(normal\) y los cambios mecánicos de código \(ligero\) no van a un subagente: se encargan primero/u);
  assert.match(plano, /se hacen PRIMERO, sin preguntar, con fabrica_encargar/u);
  assert.match(plano, /Usa niveles:nivel-normal solo si el encargo no es posible \(repo sin commits, otro encargo o recorrido en marcha, sin conector\) o ya falló, y entonces pon \[sin encargo\] en la descripción del subagente/u);
  assert.match(plano, /Los encargos van de uno en uno: no los sustituyas por subagentes para paralelizar; mientras corre uno, prepara el siguiente o revisa/u);
  assert.match(plano, /ligero para comandos, búsquedas y lecturas/u);
  assert.doesNotMatch(plano, /normal para implementar con diseño claro/u);
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

test('fabrica es la única skill de revisión y revision-cruzada y revisar quedan retiradas', async () => {
  await assert.rejects(fs.access(new URL('../skills/revision-cruzada/SKILL.md', import.meta.url)));
  await assert.rejects(fs.access(new URL('../skills/revisar/SKILL.md', import.meta.url)));
  const fabrica = await leer('skills/fabrica/SKILL.md');
  assert.doesNotMatch(fabrica, /(?<!--)revision-cruzada|automátic/u);
  const { RETIRED_SKILLS } = await import('../src/toolkit-setup.js');
  assert.ok(RETIRED_SKILLS.includes('revision-cruzada'));
  assert.ok(RETIRED_SKILLS.includes('revisar'));
  for (const rel of ['skills/quality-gate/SKILL.md', 'README.md', 'docs/guias/guia-de-comandos.md', 'docs/guias/guia-de-comandos.html', 'docs/skills/superpowers-integration.md', 'docs/agentes/coordinacion/fabrica.md'])
    assert.doesNotMatch(await leer(rel), /(?<!--)revision-cruzada|[Rr]evisión automática/u, rel);
});
