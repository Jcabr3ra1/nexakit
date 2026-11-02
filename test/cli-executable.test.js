import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { resolveCliInvocation } from "../src/cli-executable.js";
import { createCodexCliRunner } from "../src/codex-cli-runner.js";
import { createClaudeCodeRunner } from "../src/claude-code-runner.js";

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

test("Windows Node runner previews exactly match executed argv even when npm paths contain spaces and metacharacters", windowsOnly, async t => {
  for (const name of ["codex", "claude"]) {
    const f = await fixture(t, name), calls = path.join(f.directory, "calls.jsonl");
    const projectRoot = path.join(f.directory, "project"), home = path.join(f.directory, "home");
    await fs.mkdir(projectRoot); await fs.mkdir(home);
    const plan = { summary: "Valid plan", claude: { model: "sonnet", effort: "medium" },
      files: [{ path: "file.js", action: "modify", reason: "Fixture" }], acceptance: ["Done"], checks: ["npm test"] };
    await fs.writeFile(f.script, `const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ executable: process.execPath, args: process.argv.slice(1) }) + '\\n');
if (args[0] === '--version') { console.log(${JSON.stringify(name === "codex" ? "codex-cli 0.163.0" : "2.1.300")}); process.exit(0); }
if (args[0] === 'login') { console.error('Logged in using ChatGPT'); process.exit(0); }
if (args[0] === 'auth') { console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' })); process.exit(0); }
fs.readFileSync(0);
if (args[0] === 'exec') fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], ${JSON.stringify(JSON.stringify(plan))});
else console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Valid proposal' }));
`);
    const create = name === "codex" ? createCodexCliRunner : createClaudeCodeRunner;
    const runner = create({ home, env: { ...process.env, PATH: f.directory }, [`${name}Path`]: f.shim });
    const preview = await runner.preview({ projectRoot, task: { title: "Fixture", project: "P", objective: "Test", mode: "tutor" },
      plan: "Valid plan", model: name === "codex" ? "gpt-6.1-sol" : "sonnet", effort: "medium" });
    assert.equal(preview.command.executable, process.execPath);
    assert.equal(preview.command.args[0], await fs.realpath(f.script));
    assert.equal(preview.command.shell, false);
    await runner.run(preview);
    const executed = (await fs.readFile(calls, "utf8")).trim().split("\n").map(line => JSON.parse(line)).at(-1);
    assert.deepEqual(executed, { executable: preview.command.executable, args: preview.command.args });
    await runner.cleanup(preview);
  }
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
