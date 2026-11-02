import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const HTML_PATH = path.join(ROOT, 'docs/guias/guia-de-comandos.html');
const README_PATH = path.join(ROOT, 'README.md');

async function walkFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(full)));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

test('HTML command guide presents a 3-step route, the new auto-review and handoff workflow, and the updated Spanish command library', async () => {
  const html = await fs.readFile(HTML_PATH, 'utf8');

  const routeMatch = html.match(/<ol class="route">([\s\S]*?)<\/ol>/u);
  assert.ok(routeMatch, 'route list exists');
  const routeItems = [...routeMatch[1].matchAll(/<li><a href="#([^"]+)">/gu)].map((m) => m[1]);
  assert.deepEqual(routeItems, ['requisitos', 'ejecutar', 'trabajar']);
  assert.match(html, /<progress id="progress" value="0" max="3"/u);

  // Mentions all 3 AIs and Node 24
  assert.match(html, /Node\.js 24/u);
  assert.match(html, /Claude Code/u);
  assert.match(html, /Codex/u);
  assert.match(html, /Antigravity/u);

  // Explains the new workflow
  assert.match(html, /¿A dónde mando la revisión\?/u);
  assert.match(html, /sin revisión/u);
  assert.match(html, /\/revisar/u);
  assert.match(html, /seguimiento/u);
  assert.match(html, /\/cerrar-memoria/u);

  // Includes all new Spanish commands in the interactive library
  for (const cmd of [
    'npx nexakit',
    'npx nexakit --si',
    'npx nexakit comprobar',
    'npx nexakit quitar',
    'npx nexakit reparar --desde',
    'npx nexakit setup --omitir',
    'npx nexakit setup --reponer',
    'npx nexakit memoria',
    'nexakit revision',
    'nexakit modelo',
    '/revisar',
    '/cerrar-memoria',
  ]) {
    assert.ok(html.includes(cmd), `HTML guide should include command: ${cmd}`);
  }

  // Does not recommend retired workflow commands or manual MCP registration
  assert.match(html, /Quité una skill y vuelve a aparecer/u);
  assert.doesNotMatch(html, /\/programar|\$programar/u);
  assert.doesNotMatch(html, /\/estado|\$estado/u);
  assert.doesNotMatch(html, /agent-toolkit-workflow/u);
});

test('README.md documents the 3 AIs, 3-step setup, auto-review workflow, Spanish commands, and newly detected technologies', async () => {
  const readme = await fs.readFile(README_PATH, 'utf8');

  assert.match(readme, /Claude Code/u);
  assert.match(readme, /Codex/u);
  assert.match(readme, /Antigravity/u);
  assert.match(readme, /¿A dónde mando la revisión\?/u);
  assert.match(readme, /sin revisión/u);
  assert.match(readme, /\/revisar/u);

  for (const cmd of [
    'npx nexakit',
    'npx nexakit --si',
    'npx nexakit comprobar',
    'npx nexakit quitar',
    'npx nexakit reparar --desde',
    'npx nexakit memoria',
    'nexakit revision',
    'nexakit modelo',
  ]) {
    assert.ok(readme.includes(cmd), `README should include command: ${cmd}`);
  }

  for (const tech of ['Django', 'FastAPI', 'Flask', 'Tauri', 'OpenAPI']) {
    assert.ok(readme.includes(tech), `README should mention detected technology: ${tech}`);
  }

  assert.doesNotMatch(readme, /\/programar|\$programar|\/estado|\$estado/u);
});

test('package sources, skills, HTML guide and README contain no personal names', async () => {
  const files = [
    ...(await walkFiles(path.join(ROOT, 'src'))),
    ...(await walkFiles(path.join(ROOT, 'bin'))),
    ...(await walkFiles(path.join(ROOT, 'skills'))),
    HTML_PATH,
    README_PATH,
  ];
  for (const file of files) {
    const text = await fs.readFile(file, 'utf8');
    assert.doesNotMatch(text, /\bJuan\b/u, path.relative(ROOT, file));
  }
});
