import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runTaskCli } from "../src/task-cli.js";
import { readTaskInputs, parseTaskDocument } from "../src/task-prepare-files.js";
import { createTaskPreparer, taskHash, TASK_LIMITS } from "../src/task-prepare.js";

const read = p => JSON.parse(fsSync.readFileSync(new URL(p, import.meta.url), "utf8"));
const BASE = { task: read("../examples/task-prepare/task.example.json"), ...Object.fromEntries(["request", "catalog", "policy"].map(n => [n, read(`../examples/model-selection/${n}.preference.example.json`)])) };
const EXTERNAL_VERIFIER = Object.fromEntries(["task", "request", "catalog", "policy"].map(n => [n, read(`../examples/external-verifier/${n}.example.json`)]));
const schemas = ["agent-task-prepare", "agent-model-selection", "agent-model-preference"].map(n => read(`../schemas/${n}.schema.json`));
const core = createTaskPreparer(...schemas), bin = fileURLToPath(new URL("../bin/agent-task.js", import.meta.url));
const names = ["task", "request", "catalog", "policy"], localTest = test;
function capture() { const out = [], err = []; return { out, err, io: { out: t => out.push(t), err: t => err.push(t) } }; }
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agent-task-test-"))); await fs.chmod(root, 0o700); const owner = await fs.lstat(root);
  t.after(async () => { const s = await fs.lstat(root).catch(() => null); if (s?.isDirectory() && !s.isSymbolicLink() && s.dev === owner.dev && s.ino === owner.ino) await fs.rm(root, { recursive: true }); });
  const data = structuredClone(BASE), paths = Object.fromEntries(names.map(n => [n, path.join(root, n + ".json")]));
  const save = async (name, value = data[name]) => { await fs.writeFile(paths[name], JSON.stringify(value, null, 2) + "\n", { mode: 0o600 }); };
  for (const n of names) await save(n);
  const argv = ["prepare", ...names.flatMap(n => ["--" + n, paths[n]])];
  return { root, data, paths, argv, save };
}
localTest("TP CLI summary/json/show-brief use the same selection; no writes or private data by default", async t => {
  const f = await fixture(t); f.data.task.objective = "private-sentinel"; f.data.task.base.repositoryRoot = "/fictitious/private-project"; await f.save("task");
  const before = await Promise.all(names.map(n => fs.readFile(f.paths[n])));
  for (const flags of [[], ["--json"], ["--show-brief"]]) {
    const c = capture(), code = await runTaskCli([...f.argv, ...flags], c.io); assert.equal(code, 0); assert.deepEqual(c.err, []); assert.equal(c.out.length, 1);
    if (flags.includes("--show-brief")) { assert.match(c.out[0], /private-sentinel/); assert.match(c.out[0], /borrador pendiente/); }
    else assert.doesNotMatch(c.out[0], /private-sentinel|private-project|checkedAt|scopeRefs|repositoryRoot/);
    if (flags.includes("--json")) { const r = JSON.parse(c.out[0]); assert.equal(r.state, "prepared-draft"); assert.equal(r.executed, false); assert.equal(r.permissionVerified, false); }
  }
  assert.deepEqual(await Promise.all(names.map(n => fs.readFile(f.paths[n]))), before); assert.deepEqual((await fs.readdir(f.root)).sort(), names.map(n => n + ".json").sort());
});
localTest("TP CLI labels external verifier in summary and shows the read-only brief only on request", async t => {
  const f = await fixture(t);
  for (const n of names) { f.data[n] = structuredClone(EXTERNAL_VERIFIER[n]); await f.save(n); }
  const summary = capture();
  assert.equal(await runTaskCli([...f.argv, "--json"], summary.io), 0);
  assert.equal(JSON.parse(summary.out[0]).identity.purpose, "external-verifier");
  const summaryText = capture();
  assert.equal(await runTaskCli(f.argv, summaryText.io), 0);
  assert.match(summaryText.out[0], /Propósito: verificador externo \(solo lectura declarada\)/);
  const brief = capture();
  assert.equal(await runTaskCli([...f.argv, "--show-brief"], brief.io), 0);
  assert.match(brief.out[0], /Verificador externo/);
  assert.match(brief.out[0], /Si el cliente no puede imponer acceso de solo lectura, no ejecutes este encargo/);
});
for (const args of [[], ["--help"], ["-h"], ["prepare", "--help"], ["prepare", "-h"]]) test("TP help without IO " + JSON.stringify(args), async () => {
  let calls = 0; const c = capture(), code = await runTaskCli(args, c.io, { readPackagedSchema() { calls++; throw Error("private"); }, fileIo: { lstat() { calls++; throw Error("private"); } } });
  assert.equal(code, 0); assert.match(c.out[0], /sin ejecución/); assert.equal(calls, 0);
});
for (const args of [["run"], ["prepare"], ["prepare", "--help", "--force"], ["prepare", "--task"], ["prepare", "--task", "--json"], ["prepare", "--unknown", "private-sentinel"], ["prepare", "positional"], ["prepare", "--apply"], ["prepare", "--output", "private-sentinel"]])
  test("TP invalid arguments no IO " + JSON.stringify(args), async () => {
    const c = capture(); let calls = 0; const code = await runTaskCli(args, c.io, { readPackagedSchema() { calls++; throw Error("private"); } });
    assert.equal(code, 2); assert.equal(calls, 0); assert.deepEqual(c.out, []); assert.deepEqual(c.err, ["agent-task: task-invalid-option\n"]);
  });
localTest("TP duplicate options, mutually exclusive formats and missing values reject before reads", async t => {
  const { argv } = await fixture(t);
  for (const extra of [["--task", "private-sentinel"], ["--json", "--json"], ["--show-brief", "--show-brief"], ["--json", "--show-brief"], ["--force"]]) {
    const c = capture(); let reads = 0; assert.equal(await runTaskCli([...argv, ...extra], c.io, { readPackagedSchema() { reads++; throw Error(); } }), 2);
    assert.equal(reads, 0); assert.deepEqual(c.out, []); assert.doesNotMatch(c.err.join(""), /private-sentinel/);
  }
});
localTest("TP only four input contents read; all task references and Git/HOME paths untouched", async t => {
  const f = await fixture(t); const seen = [], c = capture();
  const code = await runTaskCli(f.argv, c.io, { fileIo: { async open(full, flags) { seen.push(full); assert.ok(Object.values(f.paths).includes(full)); return fs.open(full, flags); },
    async lstat(full, options) { assert.doesNotMatch(full, /fictitious|memory\/Inicio|AGENTS\.md/); return fs.lstat(full, options); } } });
  assert.equal(code, 0); assert.deepEqual(seen, names.map(n => f.paths[n]));
});
localTest("TP byte hashes differ from canonical JSON hashes; each descriptor closes", async t => {
  const f = await fixture(t); let opens = 0, closes = 0;
  const result = await readTaskInputs(f.paths, f.root, { io: { async open(...args) { opens++; const h = await fs.open(...args); return {
    stat: (...args) => h.stat(...args), read: (...a) => h.read(...a), close: async () => { closes++; return h.close(); }
  }; } } });
  assert.equal(opens, 4); assert.equal(closes, 4);
  for (const n of names) assert.equal(result.byteHashes[n], createHash("sha256").update(await fs.readFile(f.paths[n])).digest("hex"));
  assert.notEqual(result.byteHashes.task, taskHash(result.data.task));
  const compact = JSON.stringify(result.data.task); await fs.writeFile(f.paths.task, compact); const later = await readTaskInputs(f.paths, f.root);
  assert.equal(taskHash(later.data.task), taskHash(result.data.task)); assert.notEqual(later.byteHashes.task, result.byteHashes.task);
});
for (const kind of ["symlink", "ancestor-symlink", "hardlink", "directory", "missing", "mode", "size", "duplicate", "credential-path", "foreign-owner"])
  localTest("TP unsafe input " + kind + " yields redacted error", async t => {
    if (process.platform === "win32" && ["mode", "foreign-owner"].includes(kind)) { t.skip("Windows does not implement POSIX mode/uid permissions."); return; }
    const f = await fixture(t); let fileIo;
    if (kind === "symlink") { await fs.rename(f.paths.task, path.join(f.root, "actual.json")); await fs.symlink(process.platform === "win32" ? f.root : path.join(f.root, "actual.json"), f.paths.task, process.platform === "win32" ? "junction" : "file"); }
    if (kind === "ancestor-symlink") { const link = path.join(f.root, "alias"); await fs.symlink(f.root, link, process.platform === "win32" ? "junction" : "dir"); f.paths.task = path.join(link, "task.json"); }
    if (kind === "hardlink") await fs.link(f.paths.task, path.join(f.root, "other.json"));
    if (kind === "directory") { await fs.unlink(f.paths.task); await fs.mkdir(f.paths.task); }
    if (kind === "missing") await fs.unlink(f.paths.task);
    if (kind === "mode") await fs.chmod(f.paths.task, 0o666);
    if (kind === "size") await fs.truncate(f.paths.task, TASK_LIMITS.fileBytes + 1);
    if (kind === "duplicate") f.paths.policy = f.paths.task;
    if (kind === "credential-path") { const p = path.join(f.root, ".credentials.json"); await fs.rename(f.paths.task, p); f.paths.task = p; }
    if (kind === "foreign-owner") fileIo = { async lstat(p) { const s = await fs.lstat(p); if (p === f.paths.task) s.uid++; return s; } };
    const c = capture(), argv = ["prepare", ...names.flatMap(n => ["--" + n, f.paths[n]]), "--show-brief"];
    assert.equal(await runTaskCli(argv, c.io, { fileIo }), 2); assert.deepEqual(c.out, []); assert.doesNotMatch(c.err.join(""), /agent-task-test|\/Users\/|actual|credentials|Error:|stack/);
  });
localTest("TP FIFO rejected with metadata before any open", async t => {
  const f = await fixture(t); let opens = 0;
  const io = { async lstat(p) { const s = await fs.lstat(p); if (p === f.paths.task) s.isFile = () => false; return s; }, open() { opens++; throw Error(); } };
  await assert.rejects(readTaskInputs(f.paths, f.root, { io }), e => e.code === "task-file-unsafe"); assert.equal(opens, 0);
});
for (const kind of ["before-open", "after-read", "handle-stat", "close-error"]) localTest("TP changing input " + kind + " never produces output", async t => {
  const f = await fixture(t); let closed = 0;
  const io = { async open(p, flags) {
    if (p === f.paths.task && kind === "before-open") await fs.appendFile(p, " ");
    const h = await fs.open(p, flags); let once = false;
    return { async stat(options) { const s = await h.stat(options); if (p === f.paths.task && kind === "handle-stat") s.ino++; return s; },
      async read(...args) { const v = await h.read(...args); if (!once && p === f.paths.task && kind === "after-read") { once = true; await fs.appendFile(p, " "); } return v; },
      async close() { closed++; await h.close(); if (kind === "close-error") throw Error("private-sentinel"); }
    };
  } };
  const c = capture(); assert.equal(await runTaskCli(f.argv, c.io, { fileIo: io }), 2); assert.equal(c.out.length, 0); assert.ok(closed > 0); assert.doesNotMatch(c.err.join(""), /private-sentinel|agent-task-test/);
});
const invalidJson = ["", "[]", '{"x":1,"x":2}', '{"x":1,"\\u0078":2}', '{"x":{"y":0,"y":1}}', '{"x":01}', '{"x":1e9999}', '{"x":9007199254740993}', '{"x":1.0000000000000001}', '{"x":0.100000000000000005}', '{"x":1e-9999}', '{"x":"\\ud800"}', '{"__proto__":{}}', '{}{}', '{"x":true,}'];
for (const [i, text] of invalidJson.entries()) test("TP strict JSON file case " + i, () => assert.throws(() => parseTaskDocument(Buffer.from(text)), /^Error: Task input rejected$/));
test("TP valid decimal/Unicode JSON preserves round-trip data without interpreting string numbers", () => {
  for (const text of ['{"x":0.1}', '{"x":-0}', '{"x":1.20e+2}', '{"x":9007199254740991}', '{"x":0e9999}', '{"x":"9007199254740993","emoji":"😀\\ud83d\\ude00"}'])
    assert.deepEqual(JSON.parse(JSON.stringify(parseTaskDocument(Buffer.from(text)))), JSON.parse(JSON.stringify(JSON.parse(text))));
  for (const seq of [[0xff], [0xed, 0xa0, 0x80], [0xc0, 0x80]]) assert.throws(() => parseTaskDocument(Buffer.from(seq)));
});
test("TP JSON byte/depth limits do not accept a truncated or oversized document", () => {
  assert.throws(() => parseTaskDocument(Buffer.alloc(TASK_LIMITS.fileBytes + 1, 32)));
  assert.throws(() => parseTaskDocument(Buffer.from("{\"x\":".repeat(34) + "0" + "}".repeat(34))));
  assert.throws(() => parseTaskDocument(Buffer.from('{"x":"\\u001b[2J"}')));
});
localTest("TP relative input names resolve only against explicit cwd, without HOME discovery", async t => {
  const f = await fixture(t), args = ["prepare", ...names.flatMap(n => ["--" + n, n + ".json"])], c = capture();
  assert.equal(await runTaskCli(args, c.io, { cwd: f.root }), 0); assert.match(c.out[0], /prepared-draft/);
  const paths = { ...f.paths, task: path.join(f.root, ".env") }; let calls = 0;
  await assert.rejects(readTaskInputs(paths, f.root, { io: { lstat() { calls++; throw Error(); } } }), e => e.code === "task-file-path"); assert.equal(calls, 0);
});
test("TP private path components are rejected before any filesystem access on native separators", async t => {
  const f = await fixture(t);
  for (const component of [".codex", ".git", ".env", "credentials"]) {
    let calls = 0;
    await assert.rejects(readTaskInputs({ ...f.paths, task: path.join(f.root, component, "task.json") }, f.root,
      { io: { lstat() { calls++; throw Error(); }, open() { calls++; throw Error(); } } }), { code: "task-file-path" });
    assert.equal(calls, 0);
  }
});
test("TP preserves distinct file ids above Number.MAX_SAFE_INTEGER during descriptor revalidation", async t => {
  const f = await fixture(t), firstId = 9_007_199_254_740_992n;
  await assert.rejects(readTaskInputs(f.paths, f.root, { io: {
    async lstat(full) { const s = await fs.lstat(full, { bigint: true }); if (full === f.paths.task) s.ino = firstId; return s; },
    async open(full, flags) {
      const handle = await fs.open(full, flags);
      return { async stat() { const s = await handle.stat({ bigint: true }); if (full === f.paths.task) s.ino = firstId + 1n; return s; },
        read: (...args) => handle.read(...args), close: () => handle.close() };
    }
  } }), { code: "task-file-changed" });
});
localTest("TP malformed/sensitive payload errors cannot expose private raw values", async t => {
  const f = await fixture(t);
  for (const body of ['{"private-sentinel":', '{"private-sentinel":true}', JSON.stringify({ ...f.data.task, objective: "password: privatevalue" })]) {
    await fs.writeFile(f.paths.task, body); const c = capture(), code = await runTaskCli([...f.argv, "--show-brief"], c.io);
    assert.ok([1, 2].includes(code)); assert.doesNotMatch(c.out.join("") + c.err.join(""), /private-sentinel|privatevalue|password/);
  }
});
localTest("TP needs-info/blocked/invalid map to exit 1/1/2, never full brief", async t => {
  const f = await fixture(t); f.data.task.objective = "private-sentinel"; await f.save("task");
  for (const state of ["needs-info", "blocked", "invalid"]) {
    const req = structuredClone(BASE.request);
    if (state === "needs-info") delete req.risk;
    if (state === "blocked") for (const a of req.availability) a.status = "unknown";
    if (state === "invalid") req.schemaVersion = "1.0.0";
    await f.save("request", req); const c = capture(); assert.equal(await runTaskCli([...f.argv, "--show-brief"], c.io), state === "invalid" ? 2 : 1);
    assert.match(c.out[0], new RegExp(state)); assert.doesNotMatch(c.out.join(""), /private-sentinel|# Encargo/);
  }
});
localTest("TP output and schema failures redact errors without retry", async t => {
  const f = await fixture(t); let outputs = 0; const err = [];
  assert.equal(await runTaskCli(f.argv, { out() { outputs++; throw Error("private-sentinel"); }, err: s => err.push(s) }), 2);
  assert.equal(outputs, 1); assert.deepEqual(err, ["agent-task: task-output-failed\n"]);
  const c = capture(); assert.equal(await runTaskCli(f.argv, c.io, { readPackagedSchema() { throw Error("private-sentinel"); } }), 2);
  assert.deepEqual(c.out, []); assert.doesNotMatch(c.err.join(""), /private-sentinel/);
});
localTest("TP real local bin uses only fictitious inputs and preserves memory CLI mapping/dependencies", async t => {
  const f = await fixture(t);
  const result = await new Promise((resolve, reject) => execFile(process.execPath, [bin, ...f.argv, "--json"], { timeout: 10000, env: { ...process.env, AGENT_TOOLKIT_QUIET_PLATFORM_WARNINGS: "1" } }, (e, stdout, stderr) => e ? reject(e) : resolve({ stdout, stderr })));
  assert.equal(JSON.parse(result.stdout).state, "prepared-draft"); assert.equal(result.stderr, "");
  const pkg = read("../package.json"), lock = read("../package-lock.json"); assert.equal(pkg.bin["project-memory"], "bin/project-memory.js"); assert.equal(pkg.bin["agent-task"], "bin/agent-task.js");
  assert.equal(lock.packages[""].bin["agent-task"], "bin/agent-task.js");
  assert.equal(pkg.bin["agent-toolkit-mcp"], "bin/agent-toolkit-mcp.js");
  assert.equal(pkg.bin["project-memory-mcp"], "bin/project-memory-mcp.js");
  assert.equal(lock.packages[""].bin["project-memory-mcp"], "bin/project-memory-mcp.js");
  assert.deepEqual(pkg.dependencies, {
    "@modelcontextprotocol/sdk": "1.32.2",
    "@modelcontextprotocol/server": "^2.4.0",
    "@modelcontextprotocol/server-filesystem": "2026.8.31",
    ajv: "^8.17.1",
    "eslint-visitor-keys": "5.0.1",
    "toml-eslint-parser": "1.0.3",
    zod: "^4.6.7"
  });
  assert.equal(pkg.engines.node, ">=24");
  assert.deepEqual(lock.packages[""].dependencies, pkg.dependencies);
  assert.equal(lock.packages[""].engines.node, pkg.engines.node);
});
localTest("TP EPIPE in owned Node bin exits with redacted error rather than uncaught stack", async t => {
  const f = await fixture(t);
  const c = spawn(process.execPath, [bin, ...f.argv], { env: { ...process.env, AGENT_TOOLKIT_QUIET_PLATFORM_WARNINGS: "1" }, stdio: ["ignore", "pipe", "pipe"] }); c.stdout.destroy(); let text = ""; c.stderr.on("data", b => { text += b; });
  const exit = await new Promise(resolve => c.on("close", resolve)); assert.equal(exit, 2); assert.equal(text, "agent-task: task-output-failed\n");
});
