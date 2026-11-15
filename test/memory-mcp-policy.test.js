import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { loadMemoryPolicy, validateMemoryCall, recheckMemoryRoot, recheckMemoryEntries,
  checkMemoryResult, MEMORY_MCP_LIMITS as LIMIT, MEMORY_READ_TOOLS } from "../src/memory-mcp-policy.js";
import { memoryFixture } from "../test-support/memory-mcp-fixture.js";
import { READ_TOOLS } from "../src/connect.js";
import { fileSymlinkSkipReason } from "../testing/symlink-capability.js";

const fileSymlinkSkip = fileSymlinkSkipReason();

const code = expected => error => { assert.equal(error.code, expected); return true; };
test("RG read catalogue agrees with legacy without changing connect", () => assert.deepEqual(MEMORY_READ_TOOLS, READ_TOOLS));
test("RG manifest resolves vault against manifest, never cwd", async t => {
  const f = await memoryFixture(t), before = await fs.readFile(f.manifestPath);
  const policy = await loadMemoryPolicy(f.manifestPath);
  assert.equal(policy.root, f.root); assert.ok(Object.isFrozen(policy));
  assert.deepEqual(await fs.readFile(f.manifestPath), before);
  if (process.platform !== 'win32') assert.equal((await fs.lstat(f.manifestPath)).mode & 0o7777, 0o600);
});
for (const kind of ["malformed", "duplicate-key", "unknown-field", "write-mode", "credential", "wide-root", "home-root", "overlap", "linked-manifest", "linked-root", "writable-root", "writable-manifest", "hardlinked-manifest", "oversize"])
  test("RG manifest rejects " + kind, { skip: kind === 'linked-manifest' ? fileSymlinkSkip : process.platform === 'win32' && ['writable-root','writable-manifest'].includes(kind) ? 'POSIX mode permissions' : false }, async t => {
    const f = await memoryFixture(t); let target = f.manifestPath;
    if (kind === "malformed") await fs.writeFile(target, "{");
    if (kind === "duplicate-key") await fs.writeFile(target, '{"project":{},"project":{}}');
    if (kind === "unknown-field") await f.save({ ...f.manifest, extra: true });
    if (kind === "write-mode") await f.save({ ...f.manifest, security: { ...f.manifest.security, mcpAccess: "write" } });
    if (kind === "credential") await f.save({ ...f.manifest, source: { ...f.manifest.source, remoteUrl: "https://demo:fictional-password@invalid.example/repo" } });
    if (kind === "wide-root") await f.save({ ...f.manifest, memory: { ...f.manifest.memory, vaultPath: "/" } });
    if (kind === "home-root") await f.save({ ...f.manifest, memory: { ...f.manifest.memory, vaultPath: f.base } });
    if (kind === "overlap") await f.save({ ...f.manifest, source: { ...f.manifest.source, repositoryPath: f.root } });
    if (kind === "linked-manifest") { target = path.join(f.base, "alias.json"); await fs.symlink(f.manifestPath, target); }
    if (kind === "linked-root") { await fs.rename(f.root, f.root + "-real"); await fs.symlink(f.root + '-real', f.root, process.platform === 'win32' ? 'junction' : 'dir'); }
    if (kind === "writable-root") await fs.chmod(f.root, 0o777);
    if (kind === "writable-manifest") await fs.chmod(target, 0o666);
    if (kind === "hardlinked-manifest") await fs.link(target, target + "-copy");
    if (kind === "oversize") await fs.truncate(target, LIMIT.manifestBytes + 1);
    await assert.rejects(loadMemoryPolicy(target, kind === "home-root" ? { home: f.base } : {}));
  });
test("RG rejects unsupported platform without reading a manifest", async () => {
  let touched = 0;
  await assert.rejects(loadMemoryPolicy("/fictitious/manifest.json", { platform: "freebsd", io: { lstat() { touched++; } } }), code("RG_PLATFORM_UNSUPPORTED"));
  assert.equal(touched, 0);
});
test("RG source alias is checked physically for overlap", async t => {
  const f = await memoryFixture(t), alias = path.join(f.base, "source-alias");
  await fs.symlink(f.root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await f.save({ ...f.manifest, source: { ...f.manifest.source, repositoryPath: alias } });
  await assert.rejects(loadMemoryPolicy(f.manifestPath), code("RG_ROOT_DENIED"));
});
for (const kind of ["outside", "sibling", "traversal", "relative", "control", "symlink", "symlink-parent", "hardlink", "directory", "fifo", "credential", "git", "obsidian", "writable", "unreadable"])
  test("RG rejects unsafe read " + kind + " before content IO", { skip: kind === 'symlink' ? fileSymlinkSkip : process.platform === 'win32' && ['fifo','writable','unreadable'].includes(kind) ? 'POSIX FIFO and mode permissions' : false }, async t => {
    const f = await memoryFixture(t), policy = await loadMemoryPolicy(f.manifestPath);
    let file = f.note, opens = 0;
    if (kind === "outside") file = path.join(f.source, "outside.md");
    if (kind === "sibling") file = f.root + "-sibling/note.md";
    if (kind === "traversal") file = f.root + "/notes/../../source/outside.md";
    if (kind === "relative") file = "notes/state.md";
    if (kind === "control") file += "\n";
    if (kind === "symlink") { file = path.join(f.root, "alias.md"); await fs.symlink(f.note, file); }
    if (kind === "symlink-parent") { await fs.symlink(path.dirname(f.note), path.join(f.root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir'); file = path.join(f.root, "alias/state.md"); }
    if (kind === "hardlink") await fs.link(f.note, f.note + "-copy");
    if (kind === "directory") file = f.root;
    if (kind === "fifo") { file = path.join(f.root, "pipe"); execFileSync("mkfifo", [file]); }
    if (kind === "credential") file = await f.put(".env", "fictitious sentinel");
    if (kind === "git") file = await f.put(".git/config", "fictitious sentinel");
    if (kind === "obsidian") file = await f.put(".obsidian/private.json", "fictitious sentinel");
    if (kind === "writable") await fs.chmod(file, 0o666);
    if (kind === "unreadable") await fs.chmod(file, 0o000);
    await assert.rejects(validateMemoryCall(policy, "read_text_file", { path: file }, { io: { open() { opens++; throw Error(); } } }), code("RG_PATH_DENIED"));
    assert.equal(opens, 0);
  });
for (const [name, args] of [["write_file", { path: "/outside", content: "x" }], ["invented", {}],
  ["read_text_file", { path: "/outside", extra: "x" }], ["read_text_file", { path: "/outside", head: 1, tail: 1 }],
  ["read_text_file", { path: "/outside", head: 0 }], ["read_multiple_files", { paths: [] }],
  ["read_multiple_files", { paths: Array(101).fill("/outside") }], ["list_allowed_directories", { path: "/outside" }]])
  test("RG closed schema " + name + " " + JSON.stringify(args).slice(0, 70), async () => {
    let metadata = 0;
    await assert.rejects(validateMemoryCall({ root: "/fictitious/vault", uid: process.getuid?.() }, name, args, { io: { lstat() { metadata++; } } }));
    assert.equal(metadata, 0);
  });
test("RG file and batch size limits checked before content IO", async t => {
  const f = await memoryFixture(t), policy = await loadMemoryPolicy(f.manifestPath);
  await fs.truncate(f.note, LIMIT.fileBytes);
  assert.equal((await validateMemoryCall(policy, "read_text_file", { path: f.note })).snapshots.length, 1);
  await fs.truncate(f.note, LIMIT.fileBytes + 1);
  await assert.rejects(validateMemoryCall(policy, "read_text_file", { path: f.note }), code("RG_READ_LIMIT"));
  const second = await f.put("second.md");
  await fs.truncate(f.note, LIMIT.fileBytes); await fs.truncate(second, LIMIT.totalBytes - LIMIT.fileBytes);
  assert.equal((await validateMemoryCall(policy, "read_multiple_files", { paths: [f.note, second] })).snapshots.length, 2);
  await fs.truncate(second, LIMIT.totalBytes - LIMIT.fileBytes + 1);
  await assert.rejects(validateMemoryCall(policy, "read_multiple_files", { paths: [f.note, second] }), code("RG_READ_LIMIT"));
});
test("RG root replacement and entry mutation detected", async t => {
  const f = await memoryFixture(t), policy = await loadMemoryPolicy(f.manifestPath);
  const checked = await validateMemoryCall(policy, "read_text_file", { path: f.note });
  await fs.appendFile(f.note, "Changed fixture.\n");
  await assert.rejects(recheckMemoryEntries(checked.snapshots), code("RG_ENTRY_CHANGED"));
  await fs.rename(f.root, f.root + "-old"); await fs.mkdir(f.root, { mode: 0o700 });
  await assert.rejects(recheckMemoryRoot(policy), code("RG_ROOT_CHANGED"));
});
test("RG outgoing content and size rejection without raw error propagation", () => {
  assert.deepEqual(checkMemoryResult({ content: [{ type: "text", text: "Allowed text." }], _meta: { private: "not forwarded" } }), { content: [{ type: "text", text: "Allowed text." }] });
  assert.throws(() => checkMemoryResult({ isError: true, content: [{ type: "text", text: "private path" }] }), code("RG_BACKEND_ERROR"));
  assert.throws(() => checkMemoryResult({ content: [{ type: "text", text: "password=fictional-secret-value" }] }), code("RG_CONTENT_DENIED"));
  assert.throws(() => checkMemoryResult({ content: [{ type: "resource_link", uri: "https://invalid.example" }] }), code("RG_BACKEND_PROTOCOL"));
  assert.throws(() => checkMemoryResult({ content: [{ type: "text", text: "a".repeat(LIMIT.responseBytes) }] }), code("RG_RESPONSE_LIMIT"));
});

test('RG private Windows path components and NTFS streams are denied before content IO', async t => {
  const f = await memoryFixture(t), policy = await loadMemoryPolicy(f.manifestPath);
  for (const relative of ['.env', '.git/config', '.codex/session.json', '.aws/credentials']) {
    const file = await f.put(relative);
    await assert.rejects(validateMemoryCall(policy, 'read_text_file', { path: file }), code('RG_PATH_DENIED'));
  }
  if (process.platform === 'win32') for (const file of [f.note + ':secret', String.raw`\\.\pipe\agent`]) {
    let metadata = 0;
    await assert.rejects(validateMemoryCall(policy, 'read_text_file', { path: file }, { io: { lstat() { metadata++; throw Error(); } } }), code('RG_PATH_DENIED'));
    assert.equal(metadata, 0);
  }
});

test('RG Windows home aliases remain forbidden despite path casing', {skip: process.platform !== 'win32'}, async t => {
  const f = await memoryFixture(t);
  await assert.rejects(loadMemoryPolicy(f.manifestPath, {home: f.root.toUpperCase()}), code('RG_ROOT_DENIED'));
});

test("RG policy loads without depending on the retired task flow", async () => {
  const source = await fs.readFile(new URL("../src/memory-mcp-policy.js", import.meta.url), "utf8");
  assert.match(source, /from "\.\/task-document\.js"/u);
  assert.doesNotMatch(source, /task-prepare|task-verify|task-cli|peer-review|revision/u);
  const document = await fs.readFile(new URL("../src/task-document.js", import.meta.url), "utf8");
  assert.doesNotMatch(document, /from "\.\/(?:task-prepare|task-prepare-files|task-verify|revision|peer-)/u);
});
