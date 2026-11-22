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
  const descripcion = frontmatter[1].match(/^description: (.*)$/mu)[1];
  assert.match(descripcion, /\/fabrica/u);
  assert.match(descripcion, /por tu cuenta/u);
  assert.doesNotMatch(descripcion, /nunca por tu cuenta/u);
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
  assert.match(md, /la lanzas tú, sin pedir aprobación/u);
  assert.match(md, /no encadenes recorridos para el mismo diff/u);
  assert.match(md, /huella de la propuesta es obligatoria/u);
  assert.match(md, /solo hay un recorrido a la vez/u);
  assert.match(md.replace(/\s+/gu, ' '), /si el recorrido trae alguna, no lances por tu cuenta: enséñalas y pide la aprobación de la persona/u);
  assert.match(md.replace(/\s+/gu, ' '), /diff es trivial \(solo documentación o unas pocas líneas sin lógica\), puedes omitirla; dilo en una línea/u);
  assert.match(md.replace(/\s+/gu, ' '), /Si falla:\*\* sin servidor ni orden, o con un error, dilo en una línea y sigue\. Nunca bloquea el trabajo/u);
  assert.doesNotMatch(md, /opcional|solo corre cuando la persona|No la propongas en cada cierre/u);
  assert.match(md, /máximo de dos rondas/u);
});

test('la skill fabrica enseña las órdenes permitidas y avisa de las del repo', async () => {
  const md = (await leer('skills/fabrica/SKILL.md')).replace(/\s+/gu, ' ');
  assert.match(md, /ÓRDENES PERMITIDAS/u);
  assert.match(md, /`ordenesPermitidas`/u);
  assert.match(md, /`\.nexakit\/fabrica\.json`[^.]*no son de fiar/u);
});

test('la skill fabrica pide mostrar la explicación de cada estación y los avisos de evidencia', async () => {
  const md = (await leer('skills/fabrica/SKILL.md')).replace(/\s+/gu, ' ');
  assert.match(md, /explicación de cada estación \(`explicacion`[^)]*\)/u);
  assert.match(md, /avisos de evidencia del recorrido \(`avisos`[^)]*caducada[^)]*`nexakit fabrica banco planificar`/u);
  assert.match(md, /nunca lances el banco por tu cuenta/u);
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
  assert.match(block, /sigue\s+la skill fabrica/u);
  // Regla autónoma: se lanza sin pedir permiso al cerrar con código y antes de un PR.
  const plano = block.replace(/\s+/gu, ' ');
  assert.match(plano, /la lanzas tú, sin pedir permiso/u);
  assert.match(plano, /antes de proponer o crear un PR/u);
  assert.match(plano, /fabrica_proponer y después fabrica_lanzar con la huella de esa propuesta/u);
  assert.match(plano, /nunca bloquea el trabajo/u);
  assert.match(plano, /Si el diff es trivial \(solo documentación o pocas líneas sin lógica\), omítela y dilo en una línea/u);
  assert.match(plano, /Si no hay servidor ni orden, o falla, dilo en una línea y sigue/u);
  assert.match(plano, /Salvo que el recorrido traiga órdenes del repo revisado \(\.nexakit\/fabrica\.json\): entonces pide aprobación/u);
  assert.match(plano, /~\/\.nexakit\/nexakit \(Windows: nexakit\.cmd en esa carpeta\)/u);
  assert.doesNotMatch(plano, /es opcional|solo con \/fabrica/u);
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
