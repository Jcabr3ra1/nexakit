import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = fileURLToPath(new URL('../', import.meta.url));

async function archivos(carpeta) {
  const lista = [];
  for (const entrada of await fs.readdir(path.join(REPO, carpeta), { withFileTypes: true })) {
    if (entrada.name === 'node_modules') continue;
    const relativa = path.posix.join(carpeta, entrada.name);
    if (entrada.isDirectory()) lista.push(...(await archivos(relativa)));
    else if (entrada.isFile()) lista.push(relativa);
  }
  return lista;
}

const RETIRADO = /peer-review|agent-task|agent-toolkit-inbox|revision-process|\/revisar(?![-\w])/u;
// La marca antigua de los agentes de Codex sigue reconociéndose: es lo único retirado que se nombra a propósito.
const MARCA_ANTIGUA = 'src/skill-recommendations.js';

test('nada del código, las skills ni los plugins nombra lo retirado', async () => {
  const lista = (await Promise.all(['src', 'bin', 'skills', 'plugins'].map(archivos))).flat();
  assert.ok(lista.length > 100);
  const encontrados = [];
  for (const archivo of lista) {
    if (!/\.(?:js|ts|mjs|json|md|toml|txt|yml|yaml)$/u.test(archivo)) continue;
    const texto = await fs.readFile(path.join(REPO, archivo), 'utf8');
    const permitido = archivo === MARCA_ANTIGUA ? texto.replaceAll('agent-toolkit-inbox agentes', '') : texto;
    if (RETIRADO.test(permitido)) encontrados.push(archivo);
  }
  assert.deepEqual(encontrados, []);
});

test('los binarios, módulos y carpetas retirados ya no existen', async () => {
  const retirados = [
    'bin/agent-task.js', 'bin/agent-toolkit-mcp.js', 'bin/agent-toolkit-inbox.js',
    'src/task-cli.js', 'src/task-prepare.js', 'src/task-prepare-files.js', 'src/task-verify.js',
    'src/task-verify-cli.js', 'src/task-verify-files.js', 'src/task-external-verifier.js',
    'src/task-workflow-mcp.js', 'src/task-workflow-store.js',
    'src/peer-handoff.js', 'src/peer-inbox-cli.js', 'src/peer-review-store.js', 'src/peer-review-mcp.js',
    'src/codex-delivery.js', 'src/claude-code-runner.js', 'src/codex-cli-runner.js',
    'src/revision.js', 'src/revision-adapters.js', 'src/revision-context.js', 'src/revision-isolation.js',
    'src/revision-process.js', 'src/revision-provenance.js', 'src/revision-snapshot.js',
    'skills/revisar', 'schemas/agent-task-prepare.schema.json', 'schemas/agent-task-verify.schema.json',
    'examples/task-prepare', 'examples/task-verify', 'examples/external-verifier',
    'test-support/revision-fixtures',
  ];
  for (const ruta of retirados) await assert.rejects(fs.access(path.join(REPO, ruta)), { code: 'ENOENT' }, ruta);
  // El nivel de Codex sigue vivo: codex-team lo importa.
  await fs.access(path.join(REPO, 'src/level-agents.js'));
});

test('package.json ya no publica agent-task, agent-toolkit-mcp ni agent-toolkit-inbox', async () => {
  const { bin } = JSON.parse(await fs.readFile(path.join(REPO, 'package.json'), 'utf8'));
  for (const nombre of ['agent-task', 'agent-toolkit-mcp', 'agent-toolkit-inbox']) assert.equal(nombre in bin, false, nombre);
  assert.equal(bin['nexakit-fabrica-mcp'], 'bin/nexakit-fabrica-mcp.js');
  for (const ruta of Object.values(bin)) await fs.access(path.join(REPO, ruta));
});

test('revisar se añade a las skills retiradas para quitar su enlace global', async () => {
  const { RETIRED_SKILLS } = await import('../src/toolkit-setup.js');
  assert.ok(RETIRED_SKILLS.includes('revisar'));
});

test('nexakit revision responde que la orden está retirada y sale con 2', async () => {
  const { runToolkitCli } = await import('../src/toolkit-cli.js');
  const salida = [], errores = [];
  const codigo = await runToolkitCli(['revision', '--disponibles'], { out: (t) => salida.push(t), err: (t) => errores.push(t) });
  assert.equal(codigo, 2);
  assert.match(errores.join(''), /Orden retirada: usa \/fabrica o `nexakit fabrica`/u);
  assert.equal(salida.join(''), '');
});

test('todos los src/*.js se importan sin error', async () => {
  const modulos = (await fs.readdir(path.join(REPO, 'src'))).filter((nombre) => nombre.endsWith('.js'));
  assert.ok(modulos.length > 50);
  for (const nombre of modulos) await import(pathToFileURL(path.join(REPO, 'src', nombre)).href);
});

test('ningún enlace relativo a un .md de docs, README o skills apunta a un archivo que no existe', async () => {
  const lista = [
    'README.md',
    ...(await Promise.all(['docs', 'skills', 'templates', 'examples'].map(archivos))).flat(),
  ].filter((archivo) => archivo.endsWith('.md') && !archivo.startsWith('docs/superpowers/'));
  const rotos = [];
  for (const archivo of lista) {
    const texto = (await fs.readFile(path.join(REPO, archivo), 'utf8')).replace(/```[\s\S]*?```/gu, '');
    for (const [, destino] of texto.matchAll(/\]\(([^)\s#]+\.md)(?:#[^)]*)?\)/gu)) {
      if (/^[a-z]+:/iu.test(destino)) continue;
      try { await fs.access(path.resolve(REPO, path.dirname(archivo), decodeURIComponent(destino))); }
      catch { rotos.push(`${archivo} -> ${destino}`); }
    }
  }
  assert.deepEqual(rotos, []);
});
