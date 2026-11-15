import { IS_WINDOWS, warnPlatformPermissions, toGitPath } from './platform.js';
import fs from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { parseTaskDocument } from "./task-document.js";
import { containsSensitiveData, isCredentialPath } from "./sensitive-data.js";

export const MEMORY_READ_TOOLS = Object.freeze([
  "read_text_file", "read_media_file", "read_multiple_files", "list_directory",
  "list_directory_with_sizes", "directory_tree", "search_files", "get_file_info",
  "list_allowed_directories"
]);
export const MEMORY_MCP_LIMITS = Object.freeze({
  requestBytes: 1024 * 1024, responseBytes: 16 * 1024 * 1024,
  fileBytes: 8 * 1024 * 1024, totalBytes: 12 * 1024 * 1024,
  files: 100, pathChars: 4096, timeoutMs: 10000, manifestBytes: 512 * 1024
});
export class MemoryMcpError extends Error {
  constructor(code, fatal = false) { super(code); this.code = code; this.fatal = fatal; }
}
const fail = (code, fatal = false) => { throw new MemoryMcpError(code, fatal); };
const control = /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/u;
const forbidden = input => { const value = toGitPath(input); return isCredentialPath(value) ||
  /(?:^|\/)(?:\.git|\.obsidian|\.codex|\.claude|\.gemini|\.agents|\.secrets|\.credentials|\.npmrc|\.netrc|\.envrc)(?:\/|$)/i.test(value) || /\.(?:keychain(?:-db)?|kdbx)$/i.test(value); };
const globCase = value => value.replace(/[a-z]/g, c => `[${c}${c.toUpperCase()}]`);
const recursiveExclusions = Object.freeze([
  ".git", ".obsidian", ".codex", ".claude", ".gemini", ".agents", ".secrets", ".credentials",
  ".env", ".env.*", ".envrc", ".npmrc", ".netrc", "secret", "secrets", "credential", "credentials", "id_rsa", "id_ed25519"
].flatMap(name => [`**/${globCase(name)}`, `**/${globCase(name)}/**`]).concat(
  ["pem", "key", "p12", "pfx", "keychain", "keychain-db", "kdbx"].map(ext => `**/*.${globCase(ext)}`)));
const text = { type: "string", minLength: 1, maxLength: MEMORY_MCP_LIMITS.pathChars };
const list = { type: "array", maxItems: MEMORY_MCP_LIMITS.files, items: text };
const object = (properties, required = []) => ({ type: "object", additionalProperties: false, properties, required });
export const MEMORY_TOOL_SCHEMAS = Object.freeze({
  read_text_file: object({ path: text, head: { type: "integer", minimum: 1 }, tail: { type: "integer", minimum: 1 } }, ["path"]),
  read_media_file: object({ path: text }, ["path"]),
  read_multiple_files: object({ paths: { ...list, minItems: 1 } }, ["paths"]),
  list_directory: object({ path: text }, ["path"]),
  list_directory_with_sizes: object({ path: text, sortBy: { enum: ["name", "size"] } }, ["path"]),
  directory_tree: object({ path: text, excludePatterns: list }, ["path"]),
  search_files: object({ path: text, pattern: text, excludePatterns: list }, ["path", "pattern"]),
  get_file_info: object({ path: text }, ["path"]),
  list_allowed_directories: object({})
});
const ajv = new Ajv2020({ strict: true, allErrors: true, ownProperties: true });
const inputs = new Map(MEMORY_READ_TOOLS.map(name => [name, ajv.compile(MEMORY_TOOL_SCHEMAS[name])]));
let manifestValidator;
const getManifestValidator = () => manifestValidator ??= fs.readFile(new URL("../schemas/project-memory.schema.json", import.meta.url), "utf8")
  .then(JSON.parse).then(schema => ajv.compile(schema));
const identity = s => JSON.stringify([s.dev, s.ino, s.uid, s.mode]);
const fileIdentity = s => JSON.stringify([s.dev, s.ino, s.uid, s.mode, s.nlink, s.size, s.mtimeMs, s.ctimeMs]);
const inside = (root, target) => { const rel = path.relative(root, target); return rel === "" || (!path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + path.sep)); };
const canonical = value => typeof value === "string" && value.length > 0 && value.length <= MEMORY_MCP_LIMITS.pathChars &&
  value === value.trim() && !control.test(value) && (!IS_WINDOWS || !value.slice(path.parse(value).root.length).includes(':') && !/^\\\\[?.]\\/u.test(value)) && path.isAbsolute(value) && path.normalize(value) === value &&
  value.split(path.sep).every(part => part !== "." && part !== "..");

async function physical(io, full) {
  let current = path.parse(full).root, last;
  const parts = full.slice(current.length).split(path.sep).filter(Boolean);
  if (!parts.length || parts.length > 64) fail("RG_PATH_DENIED");
  for (const [i, part] of parts.entries()) {
    current = path.join(current, part); last = await io.lstat(current);
    if (last.isSymbolicLink() || i < parts.length - 1 && !last.isDirectory()) fail("RG_PATH_DENIED");
  }
  return last;
}
function safe(s, uid, directory) {
  if ((!IS_WINDOWS && (s.uid !== uid || (s.mode & 0o7022))) || s.isSymbolicLink() ||
    (directory ? !s.isDirectory() : !s.isFile() || s.nlink !== 1)) fail("RG_PATH_DENIED");
}

/** The only file content read here is the explicitly supplied manifest. */
export async function loadMemoryPolicy(manifestPath, context = {}) {
  const io = { ...fs, ...context.io }, uid = context.uid ?? process.getuid?.();
  const platform = context.platform ?? process.platform;
  if (!["darwin", "linux", "win32"].includes(platform) || platform !== "win32" && typeof uid !== "number") fail("RG_PLATFORM_UNSUPPORTED");
  warnPlatformPermissions();
  if (!canonical(manifestPath) || forbidden(manifestPath)) fail("RG_MANIFEST_INVALID");
  let manifest;
  try {
    const before = await physical(io, manifestPath); safe(before, uid, false);
    if (!before.size || before.size > MEMORY_MCP_LIMITS.manifestBytes) fail("RG_MANIFEST_INVALID");
    const handle = await io.open(manifestPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (fileIdentity(await handle.stat()) !== fileIdentity(before)) fail("RG_MANIFEST_INVALID");
      const bytes = Buffer.alloc(before.size); let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!Number.isSafeInteger(bytesRead) || bytesRead <= 0 || bytesRead > bytes.length - offset) fail("RG_MANIFEST_INVALID");
        offset += bytesRead;
      }
      if (fileIdentity(await handle.stat()) !== fileIdentity(before) || fileIdentity(await physical(io, manifestPath)) !== fileIdentity(before)) fail("RG_MANIFEST_INVALID");
      manifest = parseTaskDocument(bytes);
    } finally { await handle.close(); }
    if (!(await getManifestValidator())(manifest) || manifest.security.mcpAccess !== "read-only" || containsSensitiveData(JSON.stringify(manifest))) fail("RG_MANIFEST_INVALID");
    const root = path.resolve(path.dirname(manifestPath), manifest.memory.vaultPath);
    const source = await io.realpath(path.resolve(path.dirname(manifestPath), manifest.source.repositoryPath));
    if (!canonical(root) || forbidden(root) || root === path.parse(root).root || path.relative(root, context.home ?? os.homedir()) === "" ||
      inside(root, source) || inside(source, root)) fail("RG_ROOT_DENIED");
    if (!(await io.lstat(source)).isDirectory()) fail("RG_ROOT_DENIED");
    const stat = await physical(io, root); safe(stat, uid, true);
    return Object.freeze({ root, uid, rootIdentity: identity(stat) });
  } catch (error) { if (error instanceof MemoryMcpError) throw error; fail("RG_MANIFEST_INVALID"); }
}

export async function recheckMemoryRoot(policy, context = {}) {
  try {
    const s = await physical({ ...fs, ...context.io }, policy.root);
    safe(s, policy.uid, true);
    if (identity(s) !== policy.rootIdentity) fail("RG_ROOT_CHANGED", true);
  } catch { fail("RG_ROOT_CHANGED", true); }
}

/** Validate the whole batch before a backend is allowed to read any listed file. */
export async function validateMemoryCall(policy, name, args, context = {}) {
  if (!inputs.has(name)) fail("RG_TOOL_DENIED");
  if (!inputs.get(name)(args) || name === "read_text_file" && args.head !== undefined && args.tail !== undefined) fail("RG_INPUT_INVALID");
  const io = { ...fs, ...context.io }, paths = args.paths ?? (args.path !== undefined ? [args.path] : []);
  if ([args.pattern, ...(args.excludePatterns ?? [])].some(v => v !== undefined && control.test(v))) fail("RG_INPUT_INVALID");
  const fileRead = ["read_text_file", "read_media_file", "read_multiple_files"].includes(name);
  const snapshots = []; let total = 0;
  for (const full of paths) {
    if (!canonical(full) || forbidden(full) || !inside(policy.root, full)) fail("RG_PATH_DENIED");
    try {
      const s = await physical(io, full), directory = !fileRead && name !== "get_file_info" || s.isDirectory();
      safe(s, policy.uid, directory);
      if (fileRead && (!s.isFile() || !IS_WINDOWS && !(s.mode & 0o400))) fail("RG_PATH_DENIED");
      if (fileRead) { total += s.size; if (s.size > MEMORY_MCP_LIMITS.fileBytes || total > MEMORY_MCP_LIMITS.totalBytes) fail("RG_READ_LIMIT"); }
      snapshots.push({ path: full, signature: fileIdentity(s) });
    } catch (error) { if (error instanceof MemoryMcpError) throw error; fail("RG_PATH_DENIED"); }
  }
  const forwarded = structuredClone(args);
  if (["directory_tree", "search_files"].includes(name))
    forwarded.excludePatterns = [...new Set([...(args.excludePatterns ?? []), ...recursiveExclusions])];
  return { args: forwarded, snapshots };
}

export async function recheckMemoryEntries(snapshots, context = {}) {
  try { for (const entry of snapshots) if (fileIdentity(await physical({ ...fs, ...context.io }, entry.path)) !== entry.signature) fail("RG_ENTRY_CHANGED"); }
  catch { fail("RG_ENTRY_CHANGED"); }
}

export function checkMemoryResult(result, mediaPaths = []) {
  if (!result || !Array.isArray(result.content) || result.isError) fail("RG_BACKEND_ERROR");
  if (Buffer.byteLength(JSON.stringify(result)) > MEMORY_MCP_LIMITS.responseBytes - 1024) fail("RG_RESPONSE_LIMIT", true);
  const checkBlob = data => {
    if (typeof data !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4) fail("RG_BACKEND_PROTOCOL", true);
    const bytes = Buffer.from(data, "base64");
    if (bytes.toString("base64") !== data) fail("RG_BACKEND_PROTOCOL", true);
    if (bytes.length > MEMORY_MCP_LIMITS.fileBytes) fail("RG_RESPONSE_LIMIT", true);
    if (containsSensitiveData(bytes.toString("utf8"))) fail("RG_CONTENT_DENIED");
  };
  const content = result.content.map(block => {
    if (block.type === "text" && typeof block.text === "string") {
      if (containsSensitiveData(block.text)) fail("RG_CONTENT_DENIED");
      return { type: "text", text: block.text };
    }
    if (["image", "audio"].includes(block.type) && mediaPaths.length && typeof block.data === "string" && typeof block.mimeType === "string") {
      checkBlob(block.data);
      return { type: block.type, data: block.data, mimeType: block.mimeType };
    }
    if (block.type === "resource" && mediaPaths.length && typeof block.resource?.blob === "string") {
      let file; try { file = fileURLToPath(block.resource.uri); } catch { fail("RG_BACKEND_PROTOCOL", true); }
      if (!mediaPaths.includes(file) || pathToFileURL(file).href !== block.resource.uri || typeof block.resource.mimeType !== "string") fail("RG_BACKEND_PROTOCOL", true);
      checkBlob(block.resource.blob);
      return { type: "resource", resource: { uri: block.resource.uri, mimeType: block.resource.mimeType, blob: block.resource.blob } };
    }
    fail("RG_BACKEND_PROTOCOL", true);
  });
  if (result.structuredContent !== undefined) {
    if (Array.isArray(result.structuredContent?.content) && mediaPaths.length &&
      JSON.stringify(result.structuredContent.content) === JSON.stringify(result.content))
      return { content, structuredContent: { content } };
    if (typeof result.structuredContent?.content !== "string" || containsSensitiveData(result.structuredContent.content)) fail("RG_CONTENT_DENIED");
    return { content, structuredContent: { content: result.structuredContent.content } };
  }
  return { content };
}
