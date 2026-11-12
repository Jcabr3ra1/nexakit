import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createMemoryGateway, runMemoryMcp, createFilesystemBackend, filesystemBackendArgs, FILESYSTEM_BACKEND_VERSION } from "../src/memory-mcp-server.js";
import { MemoryMcpTransport } from "../src/memory-mcp-transport.js";
import { MEMORY_READ_TOOLS, MEMORY_MCP_LIMITS as LIMIT, MEMORY_TOOL_SCHEMAS } from "../src/memory-mcp-policy.js";
import { memoryFixture, fakeMemoryBackend } from "../test-support/memory-mcp-fixture.js";

const bin = fileURLToPath(new URL("../bin/project-memory-mcp.js", import.meta.url));
const matches = expected => e => { assert.equal(e.code, expected); return true; };
const content = result => result.content.filter(b => b.type === "text").map(b => b.text).join("\n");
async function fake(t, options = {}, context = {}) {
  const f = await memoryFixture(t), b = fakeMemoryBackend(f.root, options);
  const gateway = await createMemoryGateway(f.manifestPath, { ...context, backendFactory: () => b.backend });
  t.after(() => gateway.close()); return { ...f, ...b, gateway };
}
test("RG invalid policy blocks before backend factory or spawn", async t => {
  const f = await memoryFixture(t); await f.save({ ...f.manifest, memory: { ...f.manifest.memory, vaultPath: "/" } });
  let factories = 0;
  await assert.rejects(createMemoryGateway(f.manifestPath, { backendFactory: () => { factories++; throw Error(); } }));
  assert.equal(factories, 0);
});
test("RG catalogue filtered to nine even if backend publishes writers", async t => {
  const all = MEMORY_READ_TOOLS.map(name => ({ name, inputSchema: MEMORY_TOOL_SCHEMAS[name], annotations: { readOnlyHint: true } }));
  all.push({ name: "write_file", inputSchema: { type: "object" } });
  const f = await fake(t, { tools: all }), tools = await f.gateway.listTools();
  assert.deepEqual(tools.map(t => t.name), MEMORY_READ_TOOLS);
  assert.ok(tools.every(t => t.annotations.readOnlyHint));
  const before = f.log.calls.length;
  for (const name of ["write_file", "edit_file", "create_directory", "move_file", "unknown"])
    await assert.rejects(f.gateway.call(name, { path: f.note }), matches("RG_TOOL_DENIED"));
  assert.equal(f.log.calls.length, before);
});
for (const kind of ["missing", "not-readonly", "required-extra", "non-object", "duplicate", "wrong-argument-type"])
  test("RG incompatible catalogue blocks readiness " + kind, async t => {
    const f = await memoryFixture(t);
    const tools = structuredClone(MEMORY_READ_TOOLS.map(name => ({ name, inputSchema: MEMORY_TOOL_SCHEMAS[name], annotations: { readOnlyHint: true } })));
    if (kind === "missing") tools.pop();
    if (kind === "not-readonly") tools[0].annotations.readOnlyHint = false;
    if (kind === "required-extra") tools[0].inputSchema.required.push("new-param");
    if (kind === "non-object") tools[0].inputSchema.type = "array";
    if (kind === "duplicate") tools.push(tools[0]);
    if (kind === "wrong-argument-type") tools[0].inputSchema.properties.path.type = "number";
    const b = fakeMemoryBackend(f.root, { tools });
    await assert.rejects(createMemoryGateway(f.manifestPath, { backendFactory: () => b.backend }), matches("RG_BACKEND_CATALOG"));
    assert.equal(b.log.closes, 1);
  });
test("RG wrong backend root rejects startup and never publishes catalogue", async t => {
  const f = await memoryFixture(t), b = fakeMemoryBackend(f.root, { scope: f.source });
  await assert.rejects(createMemoryGateway(f.manifestPath, { backendFactory: () => b.backend }), matches("RG_BACKEND_SCOPE"));
  assert.equal(b.log.catalogs, 0); assert.equal(b.log.closes, 1);
});
test("RG invalid batch does not delegate even its safe first file", async t => {
  const f = await fake(t), before = f.log.calls.length;
  await assert.rejects(f.gateway.call("read_multiple_files", { paths: [f.note, path.join(f.source, "private.md")] }), matches("RG_PATH_DENIED"));
  assert.equal(f.log.calls.length, before);
});
test("RG backend partial batch failure is not relayed as successful content", async t => {
  let file;
  const f = await fake(t, { call: () => ({ content: [{ type: "text", text: file + ": Error - private-sentinel" }] }) }); file = f.note;
  await assert.rejects(f.gateway.call("read_multiple_files", { paths: [f.note] }), e => {
    assert.equal(e.code, "RG_BACKEND_ERROR"); assert.doesNotMatch(e.message, /private-sentinel/); return true;
  });
});
test("RG catches backend scope drift before reading note", async t => {
  const f = await fake(t), prior = f.backend.call;
  f.backend.call = async (name, args) => name === "list_allowed_directories"
    ? { content: [{ type: "text", text: "Allowed directories:\n" + f.source }] } : prior(name, args);
  await assert.rejects(f.gateway.call("read_text_file", { path: f.note }), matches("RG_BACKEND_SCOPE"));
  assert.equal(f.log.calls.filter(c => c.name === "read_text_file").length, 0);
  assert.equal(f.log.closes, 1); assert.equal(f.gateway.closed, true);
});
test("RG timeout during startup closes backend exactly once", async t => {
  const f = await memoryFixture(t), b = fakeMemoryBackend(f.root, { start: () => new Promise(() => {}) });
  await assert.rejects(createMemoryGateway(f.manifestPath, { timeoutMs: 20, backendFactory: () => b.backend }), matches("RG_TIMEOUT"));
  assert.equal(b.log.starts, 1); assert.equal(b.log.closes, 1);
});
test("RG already cancelled startup never starts a backend", async t => {
  const f = await memoryFixture(t), b = fakeMemoryBackend(f.root), ctrl = new AbortController(); ctrl.abort();
  await assert.rejects(createMemoryGateway(f.manifestPath, { signal: ctrl.signal, backendFactory: () => b.backend }), matches("RG_CANCELLED"));
  assert.equal(b.log.starts, 0); assert.equal(b.log.closes, 1);
});
test("RG unexpected backend callback closes without forwarding or retry", async t => {
  const f = await memoryFixture(t), b = fakeMemoryBackend(f.root); let callback;
  const gateway = await createMemoryGateway(f.manifestPath, { backendFactory: (_, onFatal) => { callback = onFatal; return b.backend; } });
  const before = b.log.calls.length; callback("RG_BACKEND_CALLBACK"); await gateway.close();
  await assert.rejects(gateway.call("read_text_file", { path: f.note }), matches("RG_SESSION_CLOSED"));
  assert.equal(b.log.calls.length, before); assert.equal(b.log.starts, 1); assert.equal(b.log.closes, 1);
});
test("RG occupied, cancellation and late result cannot revive a session", async t => {
  let enter, finish;
  const entered = new Promise(r => { enter = r; }), late = new Promise(r => { finish = r; });
  const f = await fake(t, { call: async () => { enter(); return late; } });
  const ctrl = new AbortController(), pending = f.gateway.call("read_text_file", { path: f.note }, ctrl.signal);
  await entered;
  await assert.rejects(f.gateway.call("get_file_info", { path: f.note }), matches("RG_BUSY"));
  ctrl.abort(); await assert.rejects(pending, matches("RG_CANCELLED"));
  finish({ content: [{ type: "text", text: "Late private fixture." }] });
  await assert.rejects(f.gateway.listTools(), matches("RG_SESSION_CLOSED"));
  await f.gateway.close(); assert.equal(f.log.closes, 1);
});
test("RG active request timeout leaves no retries", async t => {
  // Freeze the deadline while asynchronous path/scope validation runs. Advance
  // only after the backend read starts, regardless of filesystem/suite load.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let enter;
  const entered = new Promise(resolve => { enter = resolve; });
  const f = await fake(t, { call: () => { enter(); return new Promise(() => {}); } }, { timeoutMs: 20 });
  const pending = f.gateway.call("read_text_file", { path: f.note });
  const rejected = assert.rejects(pending, matches("RG_TIMEOUT"));
  await entered;
  assert.equal(f.log.calls.filter(c => c.name === "read_text_file").length, 1);
  t.mock.timers.tick(19); await Promise.resolve();
  assert.equal(f.gateway.closed, false); assert.equal(f.log.closes, 0);
  t.mock.timers.tick(1); await rejected;
  assert.equal(f.gateway.closed, true);
  await assert.rejects(f.gateway.call("read_text_file", { path: f.note }), matches("RG_SESSION_CLOSED"));
  assert.equal(f.log.calls.filter(c => c.name === "read_text_file").length, 1);
  assert.equal(f.log.starts, 1); assert.equal(f.log.closes, 1);
});
test("RG safe content denied without leaking text; raw backend exceptions sanitized", async t => {
  const f = await fake(t, { call: () => ({ content: [{ type: "text", text: "password=fictional-secret-value" }] }) });
  await assert.rejects(f.gateway.call("read_text_file", { path: f.note }), matches("RG_CONTENT_DENIED"));
  f.backend.call = async () => { throw Error("private-token-and-path"); };
  await assert.rejects(f.gateway.listTools(), e => { assert.equal(e.code, "RG_BACKEND_ERROR"); assert.doesNotMatch(e.message, /private-token/); return true; });
  assert.equal(f.log.closes, 1);
});

test("RG real packaged backend supports all nine calls and is terminated", async t => {
  const f = await memoryFixture(t), png = await f.put("pixel.png", Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR9sAAAAASUVORK5CYII=", "base64"));
  const before = await fs.readFile(f.note), mode = (await fs.lstat(f.note)).mode;
  const gateway = await createMemoryGateway(f.manifestPath), pid = gateway.backendPid;
  t.after(() => gateway.close());
  const calls = [
    ["read_text_file", { path: f.note }], ["read_media_file", { path: png }], ["read_multiple_files", { paths: [f.note] }],
    ["list_directory", { path: f.root }], ["list_directory_with_sizes", { path: f.root, sortBy: "size" }],
    ["directory_tree", { path: f.root }], ["search_files", { path: f.root, pattern: "**/*.md" }],
    ["get_file_info", { path: f.note }], ["list_allowed_directories", {}]
  ];
  for (const [name, args] of calls) {
    const result = await gateway.call(name, args); assert.ok(result.content.length, name);
    if (name === "read_text_file") assert.equal(content(result), before.toString());
    if (name === "read_media_file") assert.equal(result.content[0].type, "image");
    if (name === "list_allowed_directories") assert.equal(content(result), "Allowed directories:\n" + f.root);
  }
  assert.deepEqual(await fs.readFile(f.note), before); assert.equal((await fs.lstat(f.note)).mode, mode);
  await gateway.close(); assert.throws(() => process.kill(pid, 0), e => e.code === "ESRCH");
});
test("RG packaged recursive calls exclude credential and client directories", async t => {
  const f = await memoryFixture(t);
  for (const name of [".git/private.md", ".GIT/another.md", ".env", ".env.demo", "secrets/private.md", ".obsidian/private.md", "identity.PEM"]) await f.put(name, "fictitious sentinel");
  const gateway = await createMemoryGateway(f.manifestPath); t.after(() => gateway.close());
  const tree = content(await gateway.call("directory_tree", { path: f.root }));
  const search = content(await gateway.call("search_files", { path: f.root, pattern: "**/*" }));
  assert.match(tree, /state.md/); assert.match(search, /state.md/);
  assert.doesNotMatch(tree + search, /private.md|another.md|\.env|\.obsidian|\.git|\.GIT|identity.PEM|secrets/);
});
test("RG media embedded resource URI and decoded secrets are constrained", async t => {
  const f = await memoryFixture(t), file = await f.put("sample.txt", "Safe fixture binary text.");
  const gateway = await createMemoryGateway(f.manifestPath); t.after(() => gateway.close());
  const result = await gateway.call("read_media_file", { path: file });
  assert.equal(result.content[0].type, "resource"); assert.equal(result.content[0].resource.uri, pathToFileURL(file).href);
  await fs.writeFile(file, "password=fictional-secret-value");
  await assert.rejects(gateway.call("read_media_file", { path: file }), matches("RG_CONTENT_DENIED"));
});

for (const roots of [undefined, [], "foreign"])
  test("RG CLI host roots cannot change the vault " + JSON.stringify(roots), async t => {
    const f = await memoryFixture(t); let requests = 0;
    const client = new Client({ name: "fixture-host", version: "1.0.0" }, { capabilities: roots === undefined ? {} : { roots: { listChanged: true } } });
    if (roots !== undefined) client.setRequestHandler("roots/list", () => {
      requests++; return { roots: roots === "foreign" ? [{ uri: pathToFileURL(f.source).href }] : [] };
    });
    const transport = new StdioClientTransport({ command: process.execPath, args: [bin, "--manifest", f.manifestPath], cwd: f.source, stderr: "pipe" });
    let stderr = ""; transport.stderr.on("data", b => { stderr += b.toString(); });
    await client.connect(transport); const pid = transport.pid;
    t.after(() => client.close());
    assert.deepEqual((await client.listTools()).tools.map(t => t.name), MEMORY_READ_TOOLS);
    const read = async () => client.callTool({ name: "read_text_file", arguments: { path: f.note } });
    assert.equal(content(await read()), "Fixture note.\n");
    if (roots !== undefined) await client.notification({ method: "notifications/roots/list_changed" });
    assert.equal(content(await client.callTool({ name: "list_allowed_directories", arguments: {} })), "Allowed directories:\n" + f.root);
    assert.equal(content(await read()), "Fixture note.\n"); assert.equal(requests, 0);
    for (const [name, args] of [["write_file", { path: f.note, content: "DO NOT WRITE" }], ["append_file", { path: f.note, content: "DO NOT WRITE" }],
      ["copy_file", { source: f.note, destination: path.join(f.root, "copy.md") }]]) {
      const denied = await client.callTool({ name, arguments: args });
      assert.equal(denied.isError, true, name); assert.equal(content(denied), "RG_TOOL_DENIED", name);
    }
    await assert.rejects(client.request({ method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "repeat", version: "1" } } }), /RG_ALREADY_INITIALIZED/);
    assert.equal(await fs.readFile(f.note, "utf8"), "Fixture note.\n");
    await client.close(); assert.throws(() => process.kill(pid, 0), e => e.code === "ESRCH");
    assert.equal(stderr, process.platform === 'win32' && process.env.AGENT_TOOLKIT_QUIET_PLATFORM_WARNINGS !== '1'
      ? 'Windows: no se verifican propietario ni modos POSIX; se usan los permisos del usuario.\n' : '');
  });

test("RG packaged backend is the pinned version, read-only by itself and confined to the vault", async t => {
  assert.deepEqual(filesystemBackendArgs("/x/dist/index.js", "/vault"), ["/x/dist/index.js", "--read-only", "--confine-roots", "--", "/vault"]);
  const f = await memoryFixture(t), backend = createFilesystemBackend(f.root, () => {});
  t.after(() => backend.close().catch(() => {}));
  await backend.start();
  const tools = (await backend.listTools()).tools;
  assert.deepEqual(tools.filter(tool => tool.annotations?.readOnlyHint !== true).map(tool => tool.name), [], "no tool that writes is even listed");
  for (const name of ["write_file", "edit_file", "create_directory", "move_file", "append_file", "copy_file"])
    assert.equal(tools.some(tool => tool.name === name), false, name);
  for (const name of MEMORY_READ_TOOLS) assert.equal(tools.some(tool => tool.name === name), true, name);
  // The backend itself refuses a write, whatever the guard in front of it would do.
  const written = await backend.call("write_file", { path: f.note, content: "DO NOT WRITE" }).catch(error => ({ isError: true, error }));
  assert.equal(written.isError, true);
  assert.equal(await fs.readFile(f.note, "utf8"), "Fixture note.\n");
  const pkg = JSON.parse(await fs.readFile(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));
  assert.equal(pkg.dependencies["@modelcontextprotocol/server-filesystem"], FILESYSTEM_BACKEND_VERSION);
  assert.equal(pkg.dependencies["@modelcontextprotocol/sdk"], undefined, "one MCP SDK generation only");
});

test("RG transport boundary, fragmentation and valid batching", async () => {
  const input = new PassThrough(), output = new PassThrough(), transport = new MemoryMcpTransport(input, output);
  let received = 0; transport.onmessage = () => received++; await transport.start();
  const base = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: { pad: "" } });
  const line = base.replace('"pad":""', '"pad":"' + "a".repeat(LIMIT.requestBytes - Buffer.byteLength(base)) + '"');
  assert.equal(Buffer.byteLength(line), LIMIT.requestBytes);
  input.write(line.slice(0, 100)); input.write(line.slice(100) + "\n" + line + "\n");
  assert.equal(received, 2); assert.equal(transport.closed, false);
  input.write(line + "x\n"); assert.equal(transport.closed, true); assert.equal(received, 2);
});
for (const raw of ["not-json\n", '{"jsonrpc":"2.0","id":1,"id":2,"method":"ping"}\n',
  Buffer.from([0xff, 0x0a]), JSON.stringify({ jsonrpc: "2.0", id: "x".repeat(129), method: "ping" }) + "\n"])
  test("RG malformed envelopes close without echo", async () => {
    const input = new PassThrough(), output = new PassThrough(), transport = new MemoryMcpTransport(input, output);
    let received = 0, errors = 0; transport.onmessage = () => received++; transport.onerror = () => errors++;
    await transport.start(); input.write(raw);
    assert.equal(transport.closed, true); assert.equal(received, 0); assert.equal(errors, 1);
  });
test("RG errors drop raw data; response ceiling closes transport", async () => {
  const input = new PassThrough(), output = new PassThrough(), transport = new MemoryMcpTransport(input, output);
  let result = ""; output.on("data", b => { result += b.toString(); }); await transport.start();
  await transport.send({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "private-stack", data: "private-token" } });
  assert.deepEqual(JSON.parse(result).error, { code: -32602, message: "RG_PROTOCOL_ERROR" });
  await assert.rejects(transport.send({ jsonrpc: "2.0", id: 2, result: { huge: "x".repeat(LIMIT.responseBytes) } }));
  assert.equal(transport.closed, true);
});
test("RG response exactly at the byte ceiling is emitted intact", async () => {
  const input = new PassThrough(), output = new PassThrough(), transport = new MemoryMcpTransport(input, output);
  let bytes = 0; output.on("data", b => { bytes += b.length; }); await transport.start();
  const empty = { jsonrpc: "2.0", id: 1, result: { pad: "" } };
  const overhead = Buffer.byteLength(JSON.stringify(empty) + "\n");
  empty.result.pad = "x".repeat(LIMIT.responseBytes - overhead);
  await transport.send(empty); assert.equal(bytes, LIMIT.responseBytes); assert.equal(transport.closed, false); await transport.close();
});
test("RG incompatible host version is rejected without a fallback or second backend", async t => {
  const f = await memoryFixture(t), b = fakeMemoryBackend(f.root), input = new PassThrough(), output = new PassThrough();
  let resolveResponse; const response = new Promise(r => { resolveResponse = r; });
  output.on("data", bytes => resolveResponse(JSON.parse(bytes.toString())));
  const pending = runMemoryMcp(f.manifestPath, { stdin: input, stdout: output, backendFactory: () => b.backend });
  input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
    protocolVersion: "fictitious-unsupported", capabilities: {}, clientInfo: { name: "fixture-host", version: "1" }
  } }) + "\n");
  assert.equal((await response).error.message, "RG_PROTOCOL_UNSUPPORTED");
  input.end(); await pending; assert.equal(b.log.starts, 1); assert.equal(b.log.closes, 1);
});
test("RG the 2026 protocol era is refused: no discovery, and no tools without the handshake", async t => {
  const f = await memoryFixture(t), b = fakeMemoryBackend(f.root), input = new PassThrough(), output = new PassThrough();
  const replies = []; let wake;
  output.on("data", bytes => { for (const line of bytes.toString().split("\n").filter(Boolean)) replies.push(JSON.parse(line)); wake?.(); });
  const reply = async id => { for (;;) { const r = replies.find(x => x.id === id); if (r) return r; await new Promise(r => { wake = r; }); } };
  const pending = runMemoryMcp(f.manifestPath, { stdin: input, stdout: output, backendFactory: () => b.backend });
  const meta = { "io.modelcontextprotocol/protocolVersion": "2026-07-28" };
  input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: meta } }) + "\n");
  assert.ok((await reply(1)).error, "server/discover is not answered");
  input.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: { _meta: meta } }) + "\n");
  const listed = await reply(2);
  assert.ok(listed.error, "tools are not listed to a client that skipped initialize"); assert.equal(listed.result, undefined);
  input.write(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "initialize", params: {
    protocolVersion: "2026-07-28", capabilities: {}, clientInfo: { name: "fixture-host", version: "1" } } }) + "\n");
  assert.equal((await reply(3)).error.message, "RG_PROTOCOL_UNSUPPORTED");
  input.end(); await pending;
});
test("RG frontend EOF closes a ready backend", async t => {
  const f = await memoryFixture(t), b = fakeMemoryBackend(f.root), input = new PassThrough(), output = new PassThrough();
  output.resume();
  const pending = runMemoryMcp(f.manifestPath, { stdin: input, stdout: output, backendFactory: () => b.backend });
  // End is buffered by the stream before the transport starts, no timing assumption.
  input.end(); await pending; assert.equal(b.log.closes, 1); assert.equal(b.log.starts, 1);
});
test("RG cleanup failure is reported, never silently marked successful", async t => {
  const f = await memoryFixture(t), b = fakeMemoryBackend(f.root, { close: () => { throw Error("private-cleanup-detail"); } });
  const gateway = await createMemoryGateway(f.manifestPath, { backendFactory: () => b.backend });
  await assert.rejects(gateway.close(), matches("RG_CLOSE_FAILED"));
  await assert.rejects(gateway.close(), matches("RG_CLOSE_FAILED"));
  assert.equal(b.log.closes, 1); assert.equal(gateway.closed, true);
});
for (const args of [[], ["--manifest", "relative.json"], ["--manifest", "/fictitious", "--backend", "private-sentinel"], ["--manifest", "/fictitious"]])
  test("RG CLI rejects invalid startup " + JSON.stringify(args), () => {
    const r = spawnSync(process.execPath, [bin, ...args], { encoding: "utf8" });
    assert.equal(r.status, 2); assert.equal(r.stdout, ""); assert.match(r.stderr.replace(/^Windows: no se verifican propietario ni modos POSIX; se usan los permisos del usuario.\n/u, ''), /^project-memory-mcp: RG_[A-Z_]+\n$/);
    assert.doesNotMatch(r.stderr, /fictitious|private-sentinel|Error:/);
  });
