// Detects the technologies of a project from its root and its first-level subfolders: from the manifests, or from
// the README keywords in a folder without manifests. Each signal keeps where it came from, so a suggestion can
// say why. Read-only and bounded.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const MAX_MANIFEST_BYTES = 512 * 1024;
const MAX_README_BYTES = 64 * 1024;
const MAX_SUBFOLDERS = 20;

export const SIGNAL_LABELS = Object.freeze({
  nodejs: 'Node.js',
  typescript: 'TypeScript',
  'mcp-sdk': 'MCP SDK',
  react: 'React',
  nextjs: 'Next.js',
  tailwindcss: 'Tailwind CSS',
  astro: 'Astro',
  vue: 'Vue',
  svelte: 'Svelte',
  supabase: 'Supabase',
  postgres: 'PostgreSQL',
  express: 'Express',
  fastify: 'Fastify',
  hono: 'Hono',
  playwright: 'Playwright',
  vitest: 'Vitest',
  django: 'Django',
  fastapi: 'FastAPI',
  flask: 'Flask',
  tauri: 'Tauri',
  python: 'Python',
  rust: 'Rust',
  'rest-api': 'API REST'
});

export const PACKAGE_TO_SIGNAL = Object.freeze({
  '@modelcontextprotocol/sdk': 'mcp-sdk',
  '@modelcontextprotocol/server': 'mcp-sdk',
  '@modelcontextprotocol/client': 'mcp-sdk',
  fastmcp: 'mcp-sdk',
  next: 'nextjs',
  react: 'react',
  'react-dom': 'react',
  tailwindcss: 'tailwindcss',
  '@tailwindcss/postcss': 'tailwindcss',
  '@tailwindcss/vite': 'tailwindcss',
  typescript: 'typescript',
  astro: 'astro',
  vue: 'vue',
  nuxt: 'vue',
  svelte: 'svelte',
  '@sveltejs/kit': 'svelte',
  '@supabase/supabase-js': 'supabase',
  '@supabase/ssr': 'supabase',
  pg: 'postgres',
  postgres: 'postgres',
  '@neondatabase/serverless': 'postgres',
  'drizzle-orm': 'postgres',
  '@prisma/client': 'postgres',
  express: 'express',
  fastify: 'fastify',
  hono: 'hono',
  '@hono/node-server': 'hono',
  playwright: 'playwright',
  '@playwright/test': 'playwright',
  vitest: 'vitest',
  '@tauri-apps/api': 'tauri',
  '@tauri-apps/cli': 'tauri'
});

const PYTHON_PACKAGE_TO_SIGNALS = Object.freeze({
  django: ['django'],
  djangorestframework: ['django', 'rest-api'],
  fastapi: ['fastapi'],
  flask: ['flask']
});

const FRAMEWORK_CONFIG_HINTS = Object.freeze([
  ['next.config.js', 'nextjs'],
  ['next.config.mjs', 'nextjs'],
  ['next.config.ts', 'nextjs'],
  ['tailwind.config.js', 'tailwindcss'],
  ['tailwind.config.ts', 'tailwindcss'],
  ['astro.config.mjs', 'astro'],
  ['svelte.config.js', 'svelte']
]);

const OUT_OF_COVERAGE_MANIFESTS = Object.freeze(['go.mod', 'composer.json', 'Gemfile']);
// A folder with any of these is described by them; its README is read only when it has none. A README often lists
// technologies it documents or talks about (nexakit's own README names every catalog technology) without using them.
const PROJECT_MANIFESTS = Object.freeze(['package.json', 'tsconfig.json', 'requirements.txt', 'pyproject.toml', 'manage.py',
  'Cargo.toml', 'tauri.conf.json', 'src-tauri/Cargo.toml', 'src-tauri/tauri.conf.json', ...OUT_OF_COVERAGE_MANIFESTS]);

// README dictionary. Case-insensitive, whole words only: "Reactor", "vue-router" or "flask_utils" do not count,
// "Express.js" does.
const README_TERMS = Object.freeze([
  [['React'], 'react'], [['Next.js'], 'nextjs'], [['Vue'], 'vue'], [['Svelte'], 'svelte'], [['Astro'], 'astro'],
  [['TypeScript'], 'typescript'], [['Tailwind'], 'tailwindcss'], [['Django'], 'django'], [['FastAPI'], 'fastapi'],
  [['Flask'], 'flask'], [['Express'], 'express'], [['Fastify'], 'fastify'], [['Hono'], 'hono'], [['Tauri'], 'tauri'],
  [['Supabase'], 'supabase'], [['PostgreSQL'], 'postgres'], [['Playwright'], 'playwright'], [['MCP'], 'mcp-sdk'],
  [['API REST', 'REST API', 'OpenAPI'], 'rest-api']
].map(([terms, signal]) => {
  const escaped = terms.map(term => term.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&').replace(/ /gu, '\\s+'));
  return [new RegExp(`(?<![\\p{L}\\p{N}_.-])(?:${escaped.join('|')})(?![\\p{L}\\p{N}_-])`, 'iu'), signal];
}));

const lstatOrNull = target => fs.lstat(target).catch(err => {
  if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
  throw err;
});
const isPlainFile = info => Boolean(info?.isFile() && !info.isSymbolicLink());

async function readHead(file, maxBytes) {
  const handle = await fs.open(file, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

// Folders Git ignores, asked to Git itself so every .gitignore rule (nested, negated, global) is respected.
function gitIgnored(root, names) {
  if (names.length === 0) return new Set();
  const result = spawnSync('git', ['check-ignore', '-z', '--stdin'], {
    cwd: root, input: names.map(name => `${name}/\0`).join(''), encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore']
  });
  if (result.error || (result.status !== 0 && result.status !== 1)) return new Set();
  return new Set(result.stdout.split('\0').filter(Boolean).map(entry => entry.replace(/\/$/u, '')));
}

async function foldersToScan(root, git, limits) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  let names = entries
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules' && !/[\n\0]/u.test(entry.name))
    .map(entry => entry.name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (git) {
    const ignored = gitIgnored(root, names);
    names = names.filter(name => !ignored.has(name));
  }
  if (names.length > MAX_SUBFOLDERS) limits.push(`Se revisaron ${MAX_SUBFOLDERS} de ${names.length} subcarpetas.`);
  return ['.', ...names.slice(0, MAX_SUBFOLDERS)];
}

// Dependency names declared in a pyproject.toml, without a TOML parser: PEP 621 `[project] dependencies`,
// `[project.optional-dependencies]` and `[dependency-groups]` arrays, and Poetry `[tool.poetry.*dependencies]` keys.
// Metadata such as `keywords` or `description` is never read.
function pyprojectDependencies(text) {
  const names = new Set();
  const nameOf = spec => spec.match(/^\s*([A-Za-z0-9._-]+)/u)?.[1].toLowerCase().replace(/_/gu, '-');
  let table = '';
  let array = null; // text of a dependency array being collected, until its closing bracket
  for (const raw of text.split(/\r?\n/u)) {
    if (array !== null) {
      array += `\n${raw}`;
    } else {
      const header = raw.match(/^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$/u);
      if (header) { table = header[1].replace(/["'\s]/gu, ''); continue; }
      const key = raw.match(/^\s*["']?([A-Za-z0-9._-]+)["']?\s*=\s*(.*)$/u);
      if (!key) continue;
      const arrayTable = table === 'project.optional-dependencies' || table === 'dependency-groups';
      if ((table === 'project' && key[1] === 'dependencies') || arrayTable) {
        if (key[2].trimStart().startsWith('[')) array = key[2];
      } else if (/^tool\.poetry(?:\.group\.[^.]+)?\.(?:dev-)?dependencies$/u.test(table)) {
        const name = nameOf(key[1]);
        if (name) names.add(name);
      }
      if (array === null) continue;
    }
    // Close the array at the bracket that balances the first one, ignoring brackets inside strings ("pkg[extra]").
    let depth = 0, quote = null, end = -1;
    for (let i = 0; i < array.length && end < 0; i++) {
      const ch = array[i];
      if (quote) { if (ch === quote) quote = null; } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '#') { const nl = array.indexOf('\n', i); if (nl < 0) break; i = nl; }
      else if (ch === '[') depth++;
      else if (ch === ']' && --depth === 0) end = i;
    }
    if (end < 0) continue;
    for (const match of array.slice(0, end).matchAll(/"([^"]*)"|'([^']*)'/gu)) {
      const name = nameOf(match[1] ?? match[2]);
      if (name) names.add(name);
    }
    array = null;
  }
  return names;
}

function pythonPackages(text, kind) {
  const found = new Set();
  if (kind === 'requirements') {
    for (const raw of text.split(/\r?\n/u)) {
      const line = raw.trim();
      if (!line || line.startsWith('#') || line.startsWith('-')) continue;
      const name = line.match(/^[A-Za-z0-9._-]+/u)?.[0].toLowerCase().replace(/_/gu, '-');
      if (name && PYTHON_PACKAGE_TO_SIGNALS[name]) found.add(name);
    }
  } else {
    for (const name of pyprojectDependencies(text)) if (PYTHON_PACKAGE_TO_SIGNALS[name]) found.add(name);
  }
  return [...found].sort();
}

async function scanFolder(root, folder, add, limits, { nestedAllowed }) {
  const dir = path.join(root, folder);
  const shown = name => (folder === '.' ? name : `${folder}/${name}`);
  // Nested manifests (src-tauri/…) are read only through a real folder that Git does not ignore: a link could
  // lead out of the project.
  const nestedDir = nestedAllowed ? lstatOrNull(path.join(dir, 'src-tauri')) : Promise.resolve(null);
  const fileInfo = async name => {
    if (name.includes('/')) {
      const info = await nestedDir;
      if (!info?.isDirectory() || info.isSymbolicLink()) return null;
    }
    return lstatOrNull(path.join(dir, name));
  };
  const readSmall = async name => {
    const info = await fileInfo(name);
    return isPlainFile(info) && info.size <= MAX_MANIFEST_BYTES ? fs.readFile(path.join(dir, name), 'utf8') : null;
  };
  const fromPackageJson = new Set();

  const pkgInfo = await fileInfo('package.json');
  if (pkgInfo) {
    if (!isPlainFile(pkgInfo) || pkgInfo.size > MAX_MANIFEST_BYTES) {
      limits.push(`${shown('package.json')} excede el límite o no es un archivo regular; no se inspeccionó.`);
    } else {
      let pkg = null;
      try { pkg = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8')); } catch {
        limits.push(`${shown('package.json')} no contiene JSON válido; no se dedujeron dependencias Node.`);
      }
      if (pkg && typeof pkg === 'object' && !Array.isArray(pkg)) {
        add('nodejs', shown('package.json'), 'manifest');
        for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
          const deps = pkg[field];
          if (!deps || typeof deps !== 'object' || Array.isArray(deps)) continue;
          for (const dep of Object.keys(deps)) {
            const signal = PACKAGE_TO_SIGNAL[dep];
            if (signal) { add(signal, `${shown('package.json')} (${dep})`, 'manifest'); fromPackageJson.add(signal); }
          }
        }
      }
    }
  }
  if (isPlainFile(await fileInfo('tsconfig.json'))) add('typescript', shown('tsconfig.json'), 'manifest');
  for (const [config, signal] of FRAMEWORK_CONFIG_HINTS) {
    if (isPlainFile(await fileInfo(config)) && !fromPackageJson.has(signal)) {
      limits.push(`Configuración observada sin dependencia confirmada en package.json: ${shown(config)}.`);
    }
  }

  for (const [name, kind] of [['requirements.txt', 'requirements'], ['pyproject.toml', 'pyproject']]) {
    const text = await readSmall(name);
    if (text === null) continue;
    add('python', shown(name), 'manifest');
    for (const pkgName of pythonPackages(text, kind)) {
      for (const signal of PYTHON_PACKAGE_TO_SIGNALS[pkgName]) add(signal, `${shown(name)} (${pkgName})`, 'manifest');
    }
  }
  if (isPlainFile(await fileInfo('manage.py'))) {
    add('python', shown('manage.py'), 'manifest');
    add('django', shown('manage.py'), 'manifest');
  }
  for (const cargo of ['Cargo.toml', 'src-tauri/Cargo.toml']) {
    const text = await readSmall(cargo);
    if (text === null) continue;
    add('rust', shown(cargo), 'manifest');
    if (/^\s*tauri\s*=/mu.test(text)) add('tauri', `${shown(cargo)} (tauri)`, 'manifest');
  }
  for (const conf of ['tauri.conf.json', 'src-tauri/tauri.conf.json']) {
    if (isPlainFile(await fileInfo(conf))) add('tauri', shown(conf), 'manifest');
  }
  for (const foreign of OUT_OF_COVERAGE_MANIFESTS) {
    const info = await fileInfo(foreign);
    if (info && !info.isSymbolicLink()) limits.push(`Stack fuera de cobertura automática observada: ${shown(foreign)}.`);
  }

  for (const manifest of PROJECT_MANIFESTS) if (await fileInfo(manifest)) return;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const readme = entries.filter(entry => entry.name.toLowerCase() === 'readme.md').map(entry => entry.name).sort()[0];
  if (readme && isPlainFile(await fileInfo(readme))) {
    const text = await readHead(path.join(dir, readme), MAX_README_BYTES);
    for (const [pattern, signal] of README_TERMS) if (pattern.test(text)) add(signal, shown(readme), 'readme');
  }
}

export async function detectSignals(root, { git = false } = {}) {
  const limits = [];
  const found = new Map();
  const add = (id, source, kind) => {
    const sources = found.get(id) ?? new Map();
    if (!sources.has(source)) sources.set(source, kind);
    found.set(id, sources);
  };
  const scanned = await foldersToScan(root, git, limits);
  const nestedIgnored = git ? gitIgnored(root, scanned.map(folder => (folder === '.' ? 'src-tauri' : `${folder}/src-tauri`))) : new Set();
  for (const folder of scanned) {
    const nested = folder === '.' ? 'src-tauri' : `${folder}/src-tauri`;
    await scanFolder(root, folder, add, limits, { nestedAllowed: !nestedIgnored.has(nested) });
  }

  const byPath = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const signals = [...found.entries()]
    .map(([id, sources]) => {
      const of = kind => [...sources].filter(([, k]) => k === kind).map(([source]) => source).sort(byPath);
      return { id, label: SIGNAL_LABELS[id] ?? id, sources: [...of('manifest'), ...of('readme')] };
    })
    .sort((a, b) => byPath(a.id, b.id));
  if (signals.length === 0) limits.push('No se detectaron tecnologías en la raíz ni en sus subcarpetas.');
  return { signals, limits, scanned };
}
