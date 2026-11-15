import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applyReviewInstructions, planReviewInstructions } from '../src/review-instructions.js';

const leer = (rel) => fs.readFile(new URL(`../${rel}`, import.meta.url), 'utf8');

test('la skill fabrica tiene un frontmatter válido y describe /fabrica', async () => {
  const md = await leer('skills/fabrica/SKILL.md');
  const frontmatter = md.match(/^---\n([\s\S]*?)\n---\n/u);
  assert.ok(frontmatter, 'frontmatter presente');
  assert.match(frontmatter[1], /^name: fabrica$/mu);
  assert.match(frontmatter[1].match(/^description: (.*)$/mu)[1], /\/fabrica/u);
});

test('la skill fabrica sigue el recorrido, exige aprobación y trata lo externo como dato', async () => {
  const md = await leer('skills/fabrica/SKILL.md');
  for (const herramienta of ['fabrica_proponer', 'fabrica_lanzar', 'fabrica_estado', 'fabrica_resultado', 'fabrica_cancelar'])
    assert.match(md, new RegExp(herramienta, 'u'));
  assert.match(md, /niveles:revisor-de-calidad/u);
  assert.match(md, /impeccable-finish-reviewer/u);
  assert.match(md, /superpowers:receiving-code-review/u);
  assert.match(md, /hallazgosClaude/u);
  assert.match(md, /verificado/u);
  assert.match(md, /DATO/u);
  assert.match(md, /Nunca lances sin aprobación/u);
  assert.match(md, /máximo de dos rondas/u);
});

test('la skill fabrica cubre el recorrido en curso, la estación de Claude y la invocación desde Codex', async () => {
  const md = (await leer('skills/fabrica/SKILL.md')).replace(/\s+/gu, ' ');
  assert.match(md, /sigue en curso, díselo a la persona y espera a que te lo pida, sin consultar en bucle/u);
  assert.match(md, /`estacion` de cada hallazgo debe ser una estación de Claude de este recorrido/u);
  assert.match(md, /Desde Codex\.[^.]*`nexakit-fabrica` está registrado en Codex[^.]*`\$fabrica`/u);
});

test('el bloque instalado manda a la fábrica y ya no recomienda /revisar', async (t) => {
  const homeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'fabrica-skill-'));
  t.after(() => fs.rm(homeDirectory, { recursive: true, force: true }));
  await applyReviewInstructions(await planReviewInstructions({ homeDirectory }), { assertHeld: async () => {} });
  const block = (await fs.readFile(path.join(homeDirectory, '.claude', 'CLAUDE.md'), 'utf8')).match(
    /<!-- nexakit:review:start -->[\s\S]*?<!-- nexakit:review:end -->/u,
  )[0];
  assert.match(block, /\/fabrica/u);
  assert.doesNotMatch(block, /\/revisar/u);
  assert.match(block, /sigue la skill fabrica/u);
  assert.match(block, /commits locales en ramas de trabajo sin pedir permiso; push, PR,\s+fusión y memoria solo con autorización/u);
});

test('las guías recomiendan /fabrica y la guía HTML coincide con el .md', async () => {
  const [readme, md, html] = await Promise.all([leer('README.md'), leer('docs/guias/guia-de-comandos.md'), leer('docs/guias/guia-de-comandos.html')]);
  for (const texto of [readme, md, html]) {
    assert.match(texto, /\/fabrica/u);
    assert.doesNotMatch(texto, /\/revisar|\$revisar/u);
  }
  assert.doesNotMatch(md, /agent-toolkit-workflow/u);
  assert.match(await leer('docs/agentes/coordinacion/fabrica.md'), /nexakit-fabrica/u);
});
