import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { copyTaskJson, TASK_LIMITS, TaskInputError, reject, parseTaskDocument } from "./task-document.js";
import { containsSensitiveData, isCredentialPath } from "./sensitive-data.js";
import { IS_WINDOWS, warnPlatformPermissions, toGitPath, isPortableAbsolutePath } from "./platform.js";

// Reexportados desde task-document.js mientras existan sus importadores.
export { TaskInputError, parseTaskDocument };
const signature = s => JSON.stringify([s.dev, s.ino, s.uid, s.gid, s.mode, s.nlink, s.size, s.mtimeMs, s.ctimeMs, s.mtimeNs, s.ctimeNs], (_key, value) => typeof value === "bigint" ? String(value) : value);
// NTFS file ids may exceed Number.MAX_SAFE_INTEGER. Preserve exact device/inode ids;
// the bounded sizes and permission fields remain numbers for existing read budgets.
function metadata(stat) {
  if (typeof stat.mode !== "bigint") return stat;
  const result = { ...stat };
  // BigIntStats methods require their original bigint mode; bind to that object.
  for (const method of ["isFile", "isDirectory", "isSymbolicLink", "isFIFO", "isSocket", "isBlockDevice", "isCharacterDevice"]) result[method] = stat[method].bind(stat);
  for (const key of ["uid", "gid", "mode", "nlink", "size", "mtimeMs", "ctimeMs"]) result[key] = Number(stat[key]);
  return result;
}
export const taskLstat = async (io, full) => metadata(await io.lstat(full, IS_WINDOWS ? { bigint: true } : undefined));
export const taskHandleStat = async handle => metadata(await handle.stat(IS_WINDOWS ? { bigint: true } : undefined));
const forbiddenInput = value => {
  const p = toGitPath(value);
  return isCredentialPath(p) || /(?:^|\/)(?:\.git|\.obsidian|\.claude|\.codex|\.gemini|\.agents|\.(?:credentials?|secrets?)(?:\.[^/]*)?)(?:\/|$)/i.test(p) || /\.keychain(?:-db)?$/i.test(p);
};

/** Only explicit source files; no referenced paths, credentials, config, Git or writes. */
export async function readTaskInputs(paths, cwd, dependencies = {}) {
  warnPlatformPermissions();
  const names = ["task", "request", "catalog", "policy"], io = { ...fs, ...dependencies.io }, uid = process.getuid?.();
  let entries;
  try {
    const p = copyTaskJson(paths);
    if (!path.isAbsolute(cwd) || (!IS_WINDOWS && typeof uid !== "number") || !["darwin", "linux", "win32"].includes(process.platform) ||
        !p || Array.isArray(p) || Object.keys(p).sort().join() !== [...names].sort().join()) reject("task-file-path");
    entries = names.map(name => {
      const value = p[name];
      if (typeof value !== "string" || !value || value !== value.trim() || value.length > 4096 || /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/u.test(value)) reject("task-file-path");
      const full = path.resolve(cwd, value);
      if ((IS_WINDOWS && !isPortableAbsolutePath(full)) || forbiddenInput(full) || containsSensitiveData(full)) reject("task-file-path");
      return { name, full };
    });
    if (new Set(entries.map(e => e.full.normalize("NFC").toLowerCase())).size !== 4) reject("task-file-path");
  } catch { reject("task-file-path"); }
  const physical = async full => {
    let curr = path.parse(full).root;
    const parts = full.slice(curr.length).split(path.sep).filter(Boolean); if (parts.length > 64) reject("task-file-path");
    for (const [index, part] of parts.entries()) {
      curr = path.join(curr, part); const s = await taskLstat(io, curr);
      if (s.isSymbolicLink() || index !== parts.length - 1 && !s.isDirectory()) reject("task-file-unsafe");
    }
  };
  const safe = s => {
    if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || (!IS_WINDOWS && (s.uid !== uid || s.mode & 0o7022))) reject("task-file-unsafe");
    if (s.size < 1 || s.size > TASK_LIMITS.fileBytes) reject("task-file-limit");
  };
  const data = {}, byteHashes = {}; let total = 0;
  try {
    for (const { name, full } of entries) {
      await physical(full); const before = await taskLstat(io, full); safe(before);
      const handle = await io.open(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      try {
        const start = await taskHandleStat(handle); safe(start); if (signature(start) !== signature(before)) reject("task-file-changed");
        const buffer = Buffer.alloc(before.size + 1); let offset = 0;
        while (offset < buffer.length) {
          const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset); if (!bytesRead) break; offset += bytesRead;
          if (offset > before.size || total + offset > TASK_LIMITS.totalBytes) reject("task-file-limit");
        }
        const after = await taskHandleStat(handle), named = await taskLstat(io, full); safe(after); safe(named);
        if (offset !== before.size || signature(before) !== signature(after) || signature(before) !== signature(named)) reject("task-file-changed");
        await physical(full); total += offset;
        const bytes = buffer.subarray(0, offset); data[name] = parseTaskDocument(bytes);
        byteHashes[name] = createHash("sha256").update(bytes).digest("hex");
      } finally { await handle.close(); }
    }
    return { data: copyTaskJson(data), byteHashes };
  } catch (e) { reject(e instanceof TaskInputError ? e.code : "task-file-read-failed"); }
}
