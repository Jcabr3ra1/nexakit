import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const SYNC_LEDGER = "00-INICIO/Registro de sincronización.md";
export const syncWriteLockPath = (vault) => path.join(vault, "00-INICIO/.project-memory-sync-record.lock");
export const hashBytes = (value) => createHash("sha256").update(value).digest("hex");
// Git paths always use '/', while path.relative returns native separators.
// path.relative applies native casing rules: Windows is case-insensitive;
// POSIX remains case-sensitive. Callers canonicalize filesystem aliases first.
export const sameNativePath = (left, right) => path.relative(left, right) === '';
// Windows may expose the same directory through 8.3 short names (for example
// RUNNER~1 in %TEMP%) that fs.realpathSync keeps, while Git reports the long
// name. The native realpath asks the OS for the final path (short names,
// junctions, casing), so both sides are canonicalized the same way before the
// exact comparison. A subdirectory of the repository is still a different path.
export const sameGitRoot = (reported, vault) => sameNativePath(fs.realpathSync.native(reported), fs.realpathSync.native(vault));
export const relativeGitPath = (root, file) => path.relative(root, file).split(path.sep).join("/");
// Only textual worktree comparisons tolerate Git's LF/CRLF conversion. Hashes,
// snapshots and comparisons between HEAD and the index remain byte-exact.
export const normalizeSyncText = (text) => text.replaceAll("\r\n", "\n");
export const sameSyncText = (left, right) => normalizeSyncText(left) === normalizeSyncText(right);
export class SyncFileError extends Error {
  constructor(code, message, status = "conflict") { super(message); this.code = code; this.status = status; }
}
export const rejectFile = (code, message, status) => { throw new SyncFileError(code, message, status); };

export function assertPhysicalPath(full) {
  let current = path.parse(full).root;
  const parts = full.slice(current.length).split(path.sep).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || i < parts.length - 1 && !stat.isDirectory()) rejectFile("unsafe-path", "Una ruta contiene enlaces o componentes incompatibles.");
  }
}
export function physicalFile(input) {
  // Resolve OS aliases outside the resource boundary (e.g. macOS /var), but
  // never follow a leaf symlink or any directory symlink inside the vault.
  if (fs.lstatSync(input).isSymbolicLink()) rejectFile("unsafe-path", "No se admiten archivos enlazados.");
  const full = fs.realpathSync(input); assertPhysicalPath(full); return full;
}
export function memoryPath(vault, relative) {
  const full = path.resolve(vault, relative);
  if (!full.startsWith(vault + path.sep)) rejectFile("unsafe-path", "La ruta escapa a la memoria.");
  assertPhysicalPath(full); return full;
}
export function readSyncFile(full, limit, binary = false) {
  assertPhysicalPath(full);
  const stat = fs.lstatSync(full);
  if (!stat.isFile() || stat.size > limit) rejectFile("file-limit", "Un archivo no es regular o supera el límite permitido.", "blocked");
  const fd = fs.openSync(full, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  let bytes;
  try {
    const opened = fs.fstatSync(fd);
    if (JSON.stringify(identity(stat)) !== JSON.stringify(identity(opened))) rejectFile("concurrent-change", "Un archivo cambió mientras se leía.");
    const buffer = Buffer.alloc(Math.min(limit + 1, stat.size + 1));
    let offset = 0, count;
    do { count = fs.readSync(fd, buffer, offset, buffer.length - offset, offset); offset += count; } while (count && offset < buffer.length);
    const after = fs.fstatSync(fd);
    if (after.size !== offset || JSON.stringify(identity(after)) !== JSON.stringify(identity(opened))) rejectFile("concurrent-change", "Un archivo cambió mientras se leía.");
    bytes = buffer.subarray(0, offset);
  } finally { fs.closeSync(fd); }
  return { path: full, bytes, text: binary ? undefined : decodeUtf8(bytes), hash: hashBytes(bytes), mode: stat.mode & 0o777, identity: identity(stat) };
}
export function decodeUtf8(bytes) {
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { rejectFile("invalid-text", "Un archivo no contiene texto UTF-8 válido.", "blocked"); }
}
export function syncGit(vault, args) {
  try {
    return execFileSync("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "-C", vault, ...args],
      { timeout: 10_000, maxBuffer: 5 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  } catch { rejectFile("git-error", "No se pudo inspeccionar Git de forma segura."); }
}
export const gitText = (vault, args) => decodeUtf8(syncGit(vault, args));
export function syncGitState(vault, ignored = []) {
  if (!sameGitRoot(gitText(vault, ["rev-parse", "--show-toplevel"]).trim(), vault)) rejectFile("git-root", "La bóveda debe tener su propio repositorio Git.");
  const head = gitText(vault, ["rev-parse", "HEAD"]).trim();
  const branch = gitText(vault, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  const changes = [], entries = gitText(vault, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).split("\0");
  for (let i = 0; i < entries.length; i++) {
    if (!entries[i]) continue;
    const state = entries[i].slice(0, 2), name = entries[i].slice(3);
    if (/[RC]/.test(state)) i++;
    if (!ignored.includes(name)) changes.push({ path: name, state });
  }
  changes.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const index = readSyncFile(path.resolve(vault, gitText(vault, ["rev-parse", "--git-path", "index"]).trim()), 5 * 1024 * 1024, true);
  return { head, branch, changes, index: { hash: index.hash, identity: index.identity } };
}
export function requireRegularGitFile(vault, relative) {
  const entries = gitText(vault, ["ls-files", "--stage", "-z", "--", relative]).split("\0").filter(Boolean);
  if (entries.length !== 1 || !/^100(?:644|755) [a-f0-9]+ 0\t/.test(entries[0])) rejectFile("untracked-file", "Una nota o el registro no está versionado como archivo regular sin conflictos.");
}
export function requireVisibleGitFiles(vault) {
  if (gitText(vault, ["ls-files", "-v", "-z"]).split("\0").filter(Boolean).some((line) => line[0] === "S" || /[a-z]/.test(line[0]))) rejectFile("hidden-git-changes", "Hay archivos con assume-unchanged o skip-worktree.");
}
export function assertSameState(before, after) {
  if (JSON.stringify(before) !== JSON.stringify(after)) rejectFile("concurrent-change", "La memoria, propuesta, manifiesto o Git cambiaron; vuelve a revisar el plan.");
}
export function assertOwnedArtifact(file, expected) {
  assertPhysicalPath(file);
  // Inodes on Windows may exceed Number.MAX_SAFE_INTEGER. Never round ownership.
  const stat = fs.lstatSync(file, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.dev !== expected.dev || stat.ino !== expected.ino) rejectFile("artifact-conflict", "Un artefacto fue sustituido; no se tocará.");
}
function identity(stat) { return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs]; }
