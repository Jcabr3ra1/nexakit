import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { LockError } from './install-lock.js';
import { IS_WINDOWS } from './platform.js';

const PACKAGE_NAME = 'nexakit';
const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/u;
const COMPLETE_MARKER = '.completa';
const PROBED_IMPORTS = ['ajv', 'zod', '@modelcontextprotocol/sdk/client/index.js'];
const NPM_TIMEOUT_MS = 10 * 60 * 1000;
const PROBE_TIMEOUT_MS = 30 * 1000;

export class StableInstallError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StableInstallError';
  }
}

export const nexakitDir = homeDirectory => path.join(homeDirectory, '.nexakit');
export const actualRoot = homeDirectory => path.join(nexakitDir(homeDirectory), 'actual');

const lstatOrNull = file => fs.lstat(file).catch(error => {
  if (error.code === 'ENOENT') return null;
  throw error;
});
const realpathOrNull = file => fs.realpath(file).catch(error => {
  if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code)) return null;
  throw error;
});
const samePath = (a, b) => (IS_WINDOWS ? a.toLowerCase() === b.toLowerCase() : a === b);
const firstLine = text => (String(text ?? '').split('\n').map(line => line.trim()).find(Boolean) ?? 'sin detalle').slice(0, 300);

export function compareVersions(a, b) {
  const left = VERSION_RE.exec(a), right = VERSION_RE.exec(b);
  if (!left || !right) return 0;
  for (let index = 1; index <= 3; index++) {
    const difference = Number(left[index]) - Number(right[index]);
    if (difference !== 0) return difference > 0 ? 1 : -1;
  }
  // A release is newer than its own prerelease.
  if (left[4] === right[4]) return 0;
  if (left[4] === undefined) return 1;
  if (right[4] === undefined) return -1;
  return left[4] > right[4] ? 1 : -1;
}

export async function readActualVersion(homeDirectory) {
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(actualRoot(homeDirectory), 'package.json'), 'utf8'));
    return manifest?.name === PACKAGE_NAME && typeof manifest.version === 'string' && VERSION_RE.test(manifest.version)
      ? manifest.version : null;
  } catch { return null; }
}

// The npm that launched us (`npx` sets npm_execpath) runs as `node npm-cli.js`, so no .cmd shim is involved.
// Without it POSIX falls back to `npm` on the PATH; Windows has no safe fallback and reports unavailable (null).
export function npmInvocation(args, { environment = process.env, platform = process.platform } = {}) {
  const script = environment.npm_execpath;
  if (typeof script === 'string' && path.isAbsolute(script) && /\.[cm]?js$/iu.test(script)) {
    return { command: environment.npm_node_execpath || process.execPath, args: [script, ...args] };
  }
  return platform === 'win32' ? null : { command: 'npm', args };
}

export function defaultRunNpm(args) {
  const invocation = npmInvocation(args);
  if (!invocation) return { status: 1, stderr: 'No se encontró npm. Ejecuta nexakit con `npx nexakit`.' };
  const result = spawnSync(invocation.command, invocation.args, {
    encoding: 'utf8', shell: false, timeout: NPM_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, windowsHide: true
  });
  return { status: result.status ?? 1, stderr: result.stderr || result.error?.message || '' };
}

export async function validatePackageRoot(root, version) {
  const fail = reason => { throw new StableInstallError(`La copia de nexakit ${version} no es válida (${reason}): ${root}`); };
  let manifest;
  try { manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')); } catch { fail('falta package.json'); }
  if (manifest?.name !== PACKAGE_NAME) fail('el paquete no es nexakit');
  if (manifest.version !== version) fail(`trae la versión ${manifest.version}`);

  const mcp = await lstatOrNull(path.join(root, 'bin/agent-toolkit-mcp.js'));
  if (!mcp?.isFile()) fail('falta bin/agent-toolkit-mcp.js');

  for (const folder of ['skills', 'catalogs/skills']) {
    let entries;
    try { entries = await fs.readdir(path.join(root, folder), { withFileTypes: true }); } catch { fail(`falta ${folder}/`); }
    for (const entry of entries.filter(item => item.isDirectory())) {
      const file = await lstatOrNull(path.join(root, folder, entry.name, 'SKILL.md'));
      if (!file?.isFile()) fail(`la skill ${entry.name} no tiene SKILL.md`);
    }
  }

  // Importing (not just resolving) catches a dependency that is present but cannot load.
  const probe = spawnSync(process.execPath, ['--input-type=module', '-e', `for (const name of ${JSON.stringify(PROBED_IMPORTS)}) await import(name);`], {
    cwd: root, encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, windowsHide: true
  });
  if (probe.status !== 0) {
    fail(`no se cargan sus dependencias: ${firstLine((probe.stderr ?? '').split('\n').find(line => /Error/u.test(line)))}`);
  }
}

async function ensureRealDirectory(directory) {
  const info = await lstatOrNull(directory);
  if (!info) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    return;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new StableInstallError(`${directory} no es una carpeta normal; muévela o bórrala para continuar.`);
  }
}

async function ensurePointerSlot(actual) {
  const info = await lstatOrNull(actual);
  if (info && !info.isSymbolicLink()) {
    throw new StableInstallError(`${actual} no es un enlace de nexakit; muévelo para continuar.`);
  }
  return info;
}

async function publishVersion({ stagingDir, versionDir, version, packageSpec, runNpm, lock }) {
  // We hold the lock, so anything left in the staging folder is from a run that died.
  for (const entry of await fs.readdir(stagingDir)) await fs.rm(path.join(stagingDir, entry), { recursive: true, force: true });
  const staging = path.join(stagingDir, `${version}-${crypto.randomUUID()}`);
  try {
    const result = await runNpm(['install', '--prefix', staging, '--no-audit', '--no-fund', packageSpec]);
    if (result?.status !== 0) throw new StableInstallError(`npm no pudo instalar ${packageSpec}: ${firstLine(result?.stderr)}`);
    await validatePackageRoot(path.join(staging, 'node_modules', PACKAGE_NAME), version);
    await fs.writeFile(path.join(staging, COMPLETE_MARKER), `${new Date().toISOString()}\n`, { flag: 'wx', mode: 0o600 });
    await lock.assertHeld();
    await fs.rename(staging, versionDir);
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true });
    throw error;
  }
}

// Puts the link `temporary` where `actual` is. Renaming over the old link is atomic; Windows refuses that for a
// junction, so there the old pointer is moved aside first and put back if the second rename fails: the pointer
// can be missing for an instant there, but it is never lost.
export async function replacePointer(temporary, actual, { windows = IS_WINDOWS, rename = fs.rename } = {}) {
  try {
    await rename(temporary, actual);
    return;
  } catch (error) {
    if (!windows || !['EPERM', 'EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
  }
  const aside = `${actual}.anterior.${crypto.randomUUID()}`;
  await rename(actual, aside);
  try {
    await rename(temporary, actual);
  } catch (error) {
    await rename(aside, actual).catch(() => {});
    throw error;
  }
  await fs.unlink(aside).catch(() => {});
}

async function movePointer({ base, actual, packageRoot, lock }) {
  const current = await ensurePointerSlot(actual);
  if (current) {
    const [real, wanted] = await Promise.all([realpathOrNull(actual), fs.realpath(packageRoot)]);
    if (real && samePath(real, wanted)) return 'igual';
  }
  // Build the new link beside the old one and rename over it: the pointer never goes missing.
  const temporary = path.join(base, `actual.${crypto.randomUUID()}`);
  await fs.symlink(packageRoot, temporary, IS_WINDOWS ? 'junction' : 'dir');
  try {
    await lock.assertHeld();
    await replacePointer(temporary, actual);
  } catch (error) {
    await fs.unlink(temporary).catch(() => {});
    throw error;
  }
  return 'movido';
}

// Leaves `~/.nexakit/actual` pointing at a complete, validated copy of this version (or keeps a newer one).
// Must run under the install lock; `runNpm(args)` returns `{ status, stderr }` and may be async.
export async function ensureStableInstall({
  homeDirectory, version, lock, runNpm = defaultRunNpm,
  packageSpec = process.env.NEXAKIT_PAQUETE || `nexakit@${version}`
}) {
  if (typeof version !== 'string' || !VERSION_RE.test(version)) {
    throw new StableInstallError(`Versión de nexakit no válida: ${String(version)}`);
  }
  const base = nexakitDir(homeDirectory);
  const versionsDir = path.join(base, 'versiones');
  const stagingDir = path.join(base, 'preparacion');
  const actual = actualRoot(homeDirectory);
  try {
    await lock.assertHeld();
    for (const directory of [base, versionsDir, stagingDir]) await ensureRealDirectory(directory);
    await ensurePointerSlot(actual);

    const activeVersion = await readActualVersion(homeDirectory);
    if (activeVersion && compareVersions(activeVersion, version) > 0) {
      return { root: actual, version: activeVersion, reused: true, pointer: 'mayor-conservado' };
    }

    const versionDir = path.join(versionsDir, version);
    const packageRoot = path.join(versionDir, 'node_modules', PACKAGE_NAME);
    let reused = false;
    if (await lstatOrNull(path.join(versionDir, COMPLETE_MARKER))) {
      await validatePackageRoot(packageRoot, version);
      reused = true;
    } else {
      if (await lstatOrNull(versionDir)) {
        throw new StableInstallError(`La carpeta ${versionDir} existe pero está incompleta; bórrala para reinstalar.`);
      }
      await publishVersion({ stagingDir, versionDir, version, packageSpec, runNpm, lock });
    }
    const pointer = await movePointer({ base, actual, packageRoot, lock });
    return { root: actual, version, reused, pointer };
  } catch (error) {
    if (error instanceof StableInstallError || error instanceof LockError || error?.code === 'perdido') throw error;
    throw new StableInstallError(`No se pudo preparar la copia estable de nexakit: ${error.message}`);
  }
}
