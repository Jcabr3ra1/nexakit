import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { IS_WINDOWS } from './platform.js';

// Evaluated in this order; the first one that holds wins.
export const LINK_STATES = Object.freeze(['falta', 'conflicto', 'efimero', 'instalado', 'otra-copia', 'roto-propio', 'roto-ajeno']);
// What an apply acts on, and what counts as ready.
export const ACTIONABLE_LINK_STATES = Object.freeze(['falta', 'efimero', 'roto-propio']);
export const READY_LINK_STATES = Object.freeze(['instalado', 'otra-copia']);

const PACKAGE_NAMES = new Set(['nexakit', 'agent-toolkit']);
const MAX_PACKAGE_BYTES = 1_048_576;
const BROKEN_CODES = new Set(['ENOENT', 'ENOTDIR', 'ELOOP']);

const normalized = value => (IS_WINDOWS ? value.toLowerCase() : value);
const samePath = (a, b) => normalized(a) === normalized(b);
const lstatOrNull = file => fs.lstat(file).catch(error => {
  if (error.code === 'ENOENT') return null;
  throw error;
});

export const isEphemeralPath = value => path.resolve(value).split(path.sep).includes('_npx');

export async function readLink(target) {
  const info = await lstatOrNull(target);
  if (!info) return { exists: false, isLink: false };
  if (!info.isSymbolicLink()) return { exists: true, isLink: false };
  const literal = await fs.readlink(target);
  return { exists: true, isLink: true, literal, absolute: path.resolve(path.dirname(target), literal) };
}

// Strips `suffix` from the end of `value`; null when it does not end with it.
function rootFrom(value, suffix) {
  const tail = path.normalize(suffix);
  const resolved = path.resolve(value);
  if (!normalized(resolved).endsWith(normalized(path.sep + tail))) return null;
  return resolved.slice(0, resolved.length - tail.length - 1) || null;
}

export async function recognizedRoot(resolvedPath, suffix) {
  const root = rootFrom(resolvedPath, suffix);
  if (!root) return null;
  const file = path.join(root, 'package.json');
  const info = await lstatOrNull(file);
  if (!info?.isFile() || info.isSymbolicLink() || info.size > MAX_PACKAGE_BYTES) return null;
  try {
    const pkg = JSON.parse(await fs.readFile(file, 'utf8'));
    return PACKAGE_NAMES.has(pkg?.name) ? root : null;
  } catch { return null; }
}

async function realpathOrNull(file) {
  try { return await fs.realpath(file); } catch (error) {
    if (BROKEN_CODES.has(error.code)) return null;
    throw error;
  }
}

export async function classifyLink({ target, suffix, activeRoots = [], isOwned = () => false }) {
  const link = await readLink(target);
  if (!link.exists) return { target, suffix, state: 'falta' };
  if (!link.isLink) return { target, suffix, state: 'conflicto' };
  return classifyReference({ target, literal: link.literal, absolute: link.absolute, suffix, activeRoots, isOwned });
}

// Classifies a path that points into a copy of nexakit without being a link itself, such as the script
// an MCP entry runs. `target` identifies the reference for `isOwned`; `absolute` defaults to the literal.
export async function classifyReference({ target, literal, absolute = path.resolve(literal), suffix, activeRoots = [], isOwned = () => false }) {
  const base = { target, suffix };
  const resolved = await realpathOrNull(absolute);

  // Before `instalado`, so a link into the cache this run came from is never taken as good.
  if (isEphemeralPath(absolute) || (resolved && isEphemeralPath(resolved))) {
    return { ...base, state: 'efimero', literal, root: rootFrom(resolved ?? absolute, suffix) ?? undefined };
  }

  if (resolved) {
    const tail = path.normalize(suffix);
    for (const candidate of activeRoots) {
      if (isEphemeralPath(candidate)) continue;
      const real = await realpathOrNull(candidate);
      if (real && samePath(resolved, path.join(real, tail))) return { ...base, state: 'instalado', literal, root: real };
    }
    const other = await recognizedRoot(resolved, suffix);
    if (other) return { ...base, state: 'otra-copia', literal, root: other };
    return { ...base, state: 'conflicto', literal };
  }

  const owned = await isOwned(target, literal);
  return { ...base, state: owned ? 'roto-propio' : 'roto-ajeno', literal, root: rootFrom(absolute, suffix) ?? undefined };
}

export function chooseActiveRoot(items, fallbackRoot) {
  const counts = new Map();
  for (const item of items) {
    if (item.state !== 'otra-copia' || !item.root || isEphemeralPath(item.root)) continue;
    counts.set(item.root, (counts.get(item.root) ?? 0) + 1);
  }
  let best = null;
  for (const [root, count] of counts) {
    if (count * 2 > items.length && (!best || count > best.count)) best = { root, count };
  }
  return best?.root ?? fallbackRoot;
}

export function legacyGroups(items, { skillNames, mcpDeadRoot } = {}) {
  const groups = new Map();
  for (const item of items) {
    if (item.state !== 'roto-ajeno' || !item.root || !skillNames?.has(path.basename(item.target))) continue;
    groups.set(item.root, [...(groups.get(item.root) ?? []), item.target]);
  }
  return [...groups]
    .filter(([root, targets]) => targets.length >= 3 || (mcpDeadRoot !== undefined && root === mcpDeadRoot))
    .map(([root, targets]) => ({ root, targets }));
}

// `expectedLiteral` is the readlink value the plan saw; null means the path must not exist yet.
// Re-reads right before writing and touches nothing when the link is no longer what the plan saw.
export async function relinkIfUnchanged({ target, expectedLiteral, source }) {
  const type = IS_WINDOWS ? 'junction' : 'dir';
  const absoluteSource = path.resolve(source);
  const info = await lstatOrNull(target);

  if (expectedLiteral === null) {
    if (info) return 'cambio';
    try { await fs.symlink(absoluteSource, target, type); } catch (error) {
      if (error.code === 'EEXIST') return 'cambio';
      throw error;
    }
    return 'hecho';
  }

  if (!info?.isSymbolicLink() || await fs.readlink(target) !== expectedLiteral) return 'cambio';

  if (IS_WINDOWS) {
    // A junction cannot be renamed over; this window is not atomic there.
    await fs.unlink(target);
    await fs.symlink(absoluteSource, target, type);
    return 'hecho';
  }

  // Build the new link beside the old one and rename over it, so the name is never missing.
  const temporary = `${target}.nx-${crypto.randomUUID()}`;
  await fs.symlink(absoluteSource, temporary, type);
  try {
    if (await fs.readlink(target) !== expectedLiteral) {
      await fs.unlink(temporary);
      return 'cambio';
    }
    await fs.rename(temporary, target);
  } catch (error) {
    await fs.unlink(temporary).catch(() => {});
    if (error.code === 'ENOENT' || error.code === 'EINVAL') return 'cambio';
    throw error;
  }
  return 'hecho';
}
