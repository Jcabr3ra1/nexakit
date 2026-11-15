import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { resolveCliInvocation } from "../src/cli-executable.js";

const windowsOnly = { skip: process.platform !== "win32" ? "Windows npm shim resolution; POSIX executable behavior is covered by runner tests." : false };

async function fixture(t, name, extension = ".cjs") {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cli space & percent%-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const packageName = name === "codex" ? "@openai/codex" : "@anthropic-ai/claude-code";
  const packageRoot = path.join(directory, "node_modules", packageName);
  await fs.mkdir(packageRoot, { recursive: true });
  const manifest = path.join(packageRoot, "package.json"), script = path.join(packageRoot, `cli${extension}`);
  await fs.writeFile(manifest, JSON.stringify({ name: packageName, bin: { [name]: `cli${extension}` } }));
  await fs.writeFile(script, "");
  const shim = path.join(directory, `${name}.cmd`);
  await fs.writeFile(shim, "@echo THIS SHIM MUST NEVER RUN\r\n@exit /b 99\r\n");
  return { directory, packageRoot, manifest, script, shim };
}

test("Windows npm shims resolve only their installed package bin and never execute shim text", windowsOnly, async t => {
  const f = await fixture(t, "codex");
  const expected = { executable: process.execPath, argsPrefix: [await fs.realpath(f.script)] };
  assert.deepEqual(await resolveCliInvocation({ name: "codex", override: f.shim }), expected);
  assert.deepEqual(await resolveCliInvocation({ name: "codex", override: f.script }), expected);
  assert.deepEqual(await resolveCliInvocation({ name: "codex", environment: { PATH: f.directory } }), expected);
  await fs.writeFile(f.manifest, JSON.stringify({ name: "@openai/codex", bin: { codex: "cli.cmd" } }));
  await fs.writeFile(path.join(f.packageRoot, "cli.cmd"), "@exit /b 0");
  await assert.rejects(resolveCliInvocation({ name: "codex", override: f.shim }), { code: "EINVAL", message: /\.js, \.cjs o \.mjs/u });
});

test("Windows npm bin resolution rejects escaping, missing and unsupported executable scripts", windowsOnly, async t => {
  const f = await fixture(t, "claude");
  const outside = path.join(f.directory, "outside.cjs");
  await fs.writeFile(outside, "throw Error('untrusted');");
  for (const bin of [path.relative(f.packageRoot, outside), "absent.cjs", outside]) {
    await fs.writeFile(f.manifest, JSON.stringify({ name: "@anthropic-ai/claude-code", bin: { claude: bin } }));
    await assert.rejects(resolveCliInvocation({ name: "claude", override: f.shim }), { code: "ENOENT" });
  }
  const text = path.join(f.directory, "executable.txt");
  await fs.writeFile(text, "not a supported executable");
  await assert.rejects(resolveCliInvocation({ name: "claude", override: text }), { code: "ENOENT" });
});

test("agy (Antigravity) is resolved as a native executable on the PATH, never as an npm shim", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agy path-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const windows = process.platform === "win32";
  const native = path.join(directory, windows ? "agy.exe" : "agy");
  await fs.writeFile(native, "", { mode: 0o755 });
  assert.deepEqual(await resolveCliInvocation({ name: "agy", environment: { PATH: directory } }), { executable: await fs.realpath(native), argsPrefix: [] });
  if (windows) {
    await fs.rm(native);
    await fs.writeFile(path.join(directory, "agy.cmd"), "@echo NUNCA\r\n");
    await assert.rejects(resolveCliInvocation({ name: "agy", environment: { PATH: directory } }));
  }
  await assert.rejects(resolveCliInvocation({ name: "otra", environment: { PATH: directory } }));
});
