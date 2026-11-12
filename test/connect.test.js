import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runCli } from "../src/cli.js";
import { connectMemory, READ_TOOLS, WRITE_TOOLS } from "../src/connect.js";
import { initializeMemory } from "../src/init.js";

const directoryLinkType = process.platform === "win32" ? "junction" : "dir";

test("connect muestra una vista previa sin modificar el equipo", async (context) => {
  const fixture = createFixture(context);
  const calls = [];

  const report = await connectMemory(
    {
      targetPath: fixture.memory,
      agentId: "codex"
    },
    {
      homeDirectory: fixture.home,
      runCommand(command, args) {
        calls.push([command, ...args]);
        return missingServer();
      }
    }
  );

  assert.equal(report.status, "preview");
  assert.equal(report.summary.create, 3);
  assert.deepEqual(calls, [["codex", "mcp", "get", "demo-project-memory"]]);
  assert.equal(fs.existsSync(path.join(fixture.home, ".agents")), false);
  assert.equal(fs.existsSync(path.join(fixture.home, ".codex")), false);
});

test("connect aplica Codex con Skill y lista blanca de lectura", async (context) => {
  const fixture = createFixture(context);
  let serverExists = false;
  const configPath = path.join(fixture.home, ".codex/config.toml");

  const runner = (command, args) => {
    assert.equal(command, "codex");
    if (args[1] === "get") {
      return serverExists
        ? codexServerOutput(fs.realpathSync(fixture.memory), true)
        : missingServer();
    }
    if (args[1] === "add") {
      serverExists = true;
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(
        configPath,
        `[mcp_servers.demo-project-memory]\ncommand = "npx"\nargs = ["-y", "@modelcontextprotocol/server-filesystem", "${fixture.memory}"]\n`
      );
      return success();
    }
    throw new Error(`Comando inesperado: ${args.join(" ")}`);
  };

  const first = await connectMemory(
    { targetPath: fixture.memory, agentId: "codex", apply: true },
    { homeDirectory: fixture.home, runCommand: runner }
  );

  assert.equal(first.status, "connected");
  const skillTarget = path.join(
    fixture.home,
    ".agents/skills/demo-project"
  );
  assert.equal(fs.lstatSync(skillTarget).isSymbolicLink(), true);
  assert.equal(
    fs.realpathSync(skillTarget),
    fs.realpathSync(path.join(fixture.memory, "07-AGENTES/skills/demo-project"))
  );
  const codexConfig = fs.readFileSync(configPath, "utf8");
  assert.match(codexConfig, /enabled_tools = \[/);
  for (const tool of READ_TOOLS) {
    assert.match(codexConfig, new RegExp(`"${tool}"`));
  }
  for (const tool of WRITE_TOOLS) {
    assert.doesNotMatch(codexConfig, new RegExp(`"${tool}"`));
  }

  const second = await connectMemory(
    { targetPath: fixture.memory, agentId: "codex", apply: true },
    { homeDirectory: fixture.home, runCommand: runner }
  );
  assert.equal(second.status, "unchanged");
});

test("connect configura Claude con permisos explícitos", async (context) => {
  const fixture = createFixture(context);
  let serverExists = false;

  const runner = (_command, args) => {
    if (args[1] === "get") {
      return serverExists
        ? claudeServerOutput(fixture.memory)
        : missingServer();
    }
    if (args[1] === "add") {
      serverExists = true;
      return success();
    }
    throw new Error(`Comando inesperado: ${args.join(" ")}`);
  };

  const report = await connectMemory(
    { targetPath: fixture.memory, agentId: "claude", apply: true },
    { homeDirectory: fixture.home, runCommand: runner }
  );

  assert.equal(report.status, "connected");
  const settings = JSON.parse(
    fs.readFileSync(path.join(fixture.home, ".claude/settings.json"), "utf8")
  );
  for (const tool of READ_TOOLS) {
    assert.ok(
      settings.permissions.allow.includes(
        `mcp__demo-project-memory__${tool}`
      )
    );
  }
  for (const tool of WRITE_TOOLS) {
    assert.ok(
      settings.permissions.deny.includes(
        `mcp__demo-project-memory__${tool}`
      )
    );
  }
});

test("connect ejecuta el bin npm con Node sin ejecutar el shim CMD", {
  skip: process.platform !== "win32" ? "Windows npm shim resolution; POSIX uses native executable spawning." : false
}, async (context) => {
  const fixture = createFixture(context, "memory space & %PATH% (copy)");
  const bin = path.join(fixture.root, "node_modules", ".bin");
  const packageDirectory = path.join(fixture.root, "node_modules", "@anthropic-ai", "claude-code");
  const script = path.join(packageDirectory, "cli.cjs");
  const log = path.join(fixture.root, "arguments.json");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(packageDirectory, { recursive: true });
  fs.writeFileSync(path.join(packageDirectory, "package.json"), JSON.stringify({ name: "@anthropic-ai/claude-code", bin: { claude: "cli.cjs" } }));
  fs.writeFileSync(script, `if (process.argv[3] === 'get') process.exit(1); require('node:fs').writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)));`);
  fs.writeFileSync(path.join(bin, "claude.cmd"), '@echo The CMD shim must never execute 1>&2\r\n@exit /b 99\r\n');
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ""}`;
  try {
    const report = await connectMemory(
      { targetPath: fixture.memory, agentId: "claude", apply: true },
      { homeDirectory: fixture.home }
    );
    assert.equal(report.status, "connected");
    const args = JSON.parse(fs.readFileSync(log, "utf8"));
    assert.deepEqual(args.slice(0, 2), ["mcp", "add"]);
    assert.equal(args.at(-1), fs.realpathSync(fixture.memory));
    fs.writeFileSync(path.join(packageDirectory, "blocked.cmd"), '@exit /b 99\r\n');
    fs.writeFileSync(path.join(packageDirectory, "package.json"), JSON.stringify({ name: "@anthropic-ai/claude-code", bin: { claude: "blocked.cmd" } }));
    await assert.rejects(connectMemory(
      { targetPath: fixture.memory, agentId: "claude", apply: true },
      { homeDirectory: fixture.home }
    ), /\.js.*\.cjs.*\.mjs/u);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});

test("connect reconoce el enlace y MCP canónicos aunque cambie el caso en Windows", async (context) => {
  const fixture = createFixture(context);
  const source = fs.realpathSync(path.join(fixture.memory, "07-AGENTES/skills/demo-project"));
  const target = path.join(fixture.home, ".agents/skills/demo-project");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const linkSource = process.platform === "win32" ? source.toUpperCase() : path.relative(fs.realpathSync(path.dirname(target)), source);
  fs.symlinkSync(linkSource, target, directoryLinkType);
  const before = fs.readlinkSync(target);
  const vault = fs.realpathSync(fixture.memory);
  const report = await connectMemory(
    { targetPath: fixture.memory, agentId: "codex", apply: true },
    {
      homeDirectory: fixture.home,
      runCommand() { return codexServerOutput(process.platform === "win32" ? vault.toUpperCase() : vault, true); }
    }
  );
  assert.equal(report.status, "unchanged");
  assert.equal(fs.readlinkSync(target), before);
  assert.equal(fs.statSync(path.join(source, "SKILL.md")).isFile(), true);
});

test("connect rechaza agentes distintos de Codex y Claude", async (context) => {
  const fixture = createFixture(context);

  await assert.rejects(
    connectMemory(
      { targetPath: fixture.memory, agentId: "gemini" },
      { homeDirectory: fixture.home }
    ),
    (error) => error.details.includes("--agent debe ser codex, claude o antigravity.")
  );
});

test("un enlace de Skill diferente detiene toda la aplicación", async (context) => {
  const fixture = createFixture(context);
  const target = path.join(fixture.home, ".agents/skills/demo-project");
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, "keep.txt"), "keep");
  let addWasCalled = false;

  const report = await connectMemory(
    { targetPath: fixture.memory, agentId: "codex", apply: true },
    {
      homeDirectory: fixture.home,
      runCommand(_command, args) {
        if (args[1] === "add") {
          addWasCalled = true;
        }
        return missingServer();
      }
    }
  );

  assert.equal(report.status, "conflict");
  assert.equal(addWasCalled, false);
  assert.equal(fs.readFileSync(path.join(target, "keep.txt"), "utf8"), "keep");
});

test("un enlace de Skill roto se trata como conflicto", async (context) => {
  const fixture = createFixture(context);
  const target = path.join(fixture.home, ".agents/skills/demo-project");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.symlinkSync(path.join(fixture.root, "missing-skill"), target, directoryLinkType);

  const report = await connectMemory(
    { targetPath: fixture.memory, agentId: "codex" },
    {
      homeDirectory: fixture.home,
      runCommand() {
        return missingServer();
      }
    }
  );

  assert.equal(report.status, "conflict");
  assert.match(
    report.components.find((item) => item.id === "skill").message,
    /otra ubicación|enlace/i
  );
});

test("revierte la Skill y el MCP nuevo si falla la política", async (context) => {
  const fixture = createFixture(context);
  const calls = [];

  await assert.rejects(
    connectMemory(
      {
        targetPath: fixture.memory,
        agentId: "codex",
        apply: true
      },
      {
        homeDirectory: fixture.home,
        runCommand(command, args) {
          calls.push([command, ...args]);
          return args[1] === "get" ? missingServer() : success();
        }
      }
    ),
    /Codex no creó su configuración/
  );

  assert.ok(calls.some((call) => call[1] === "mcp" && call[2] === "remove"));
  assert.equal(
    fs.existsSync(path.join(fixture.home, ".agents/skills/demo-project")),
    false
  );
  assert.equal(fs.statSync(path.join(fixture.memory, "07-AGENTES/skills/demo-project/SKILL.md")).isFile(), true);
});

test("un MCP homónimo diferente es conflicto", async (context) => {
  const fixture = createFixture(context);

  const report = await connectMemory(
    { targetPath: fixture.memory, agentId: "codex" },
    {
      homeDirectory: fixture.home,
      runCommand() {
        return {
          status: 0,
          stdout:
            "command: otro-comando\nargs: --ruta /otra/boveda\nenabled_tools: read_text_file\n",
          stderr: ""
        };
      }
    }
  );

  assert.equal(report.status, "conflict");
  assert.equal(report.summary.conflicts, 1);
});

for (const [agentId, launch] of [
  ["claude", "-y @modelcontextprotocol/server-filesystem@2026.8.31"],
  ["claude", "-y @modelcontextprotocol/server-filesystem"],
  ["claude", "-y @modelcontextprotocol/server-filesystem@2.3.0"],
  ["codex", "-y @modelcontextprotocol/server-filesystem@2026.8.31"],
]) test(`una conexión anterior de ${agentId} (${launch.split("filesystem")[1] || "sin versión"}) se actualiza a solo lectura sin conflicto`, async (context) => {
  const fixture = createFixture(context);
  const vault = fs.realpathSync(fixture.memory);
  const calls = [];
  let current = launch;
  const output = () => agentId === "claude" ? claudeServerOutput(vault, current) : codexServerOutput(vault, true, current);
  const runner = (_command, args) => {
    calls.push(args.join(" "));
    if (args[1] === "get") return current === null ? missingServer() : output();
    if (args[1] === "remove") { current = null; return success(); }
    if (args[1] === "add") {
      current = args.slice(args.indexOf("--") + 2, -1).join(" ");
      if (agentId === "codex") fs.appendFileSync(path.join(fixture.home, ".codex/config.toml"), "\n[mcp_servers.demo-project-memory]\ncommand = \"npx\"\n");
      return success();
    }
    throw new Error(`Comando inesperado: ${args.join(" ")}`);
  };
  if (agentId === "codex") {
    fs.mkdirSync(path.join(fixture.home, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(fixture.home, ".codex/config.toml"), "");
  }
  const options = { targetPath: fixture.memory, agentId };
  const preview = await connectMemory(options, { homeDirectory: fixture.home, runCommand: runner });
  assert.equal(preview.status, "preview");
  assert.equal(preview.components.find((item) => item.id === "mcp").action, "update");

  const report = await connectMemory({ ...options, apply: true }, { homeDirectory: fixture.home, runCommand: runner });
  assert.equal(report.status, "connected");
  assert.equal(current, CURRENT_LAUNCH, "la orden nueva fija la versión y arranca en solo lectura");
  assert.ok(calls.some((call) => call.startsWith("mcp remove demo-project-memory")));
  assert.equal(calls.filter((call) => call.startsWith("mcp add")).at(-1).endsWith(` ${CURRENT_LAUNCH} ${vault}`), true);

  const again = await connectMemory(options, { homeDirectory: fixture.home, runCommand: runner });
  assert.equal(again.components.find((item) => item.id === "mcp").action, "unchanged");
});

test("las herramientas de escritura nuevas del servidor 2.x también se deniegan", () => {
  for (const tool of ["append_file", "copy_file", "write_file", "edit_file", "create_directory", "move_file"])
    assert.ok(WRITE_TOOLS.includes(tool), tool);
  assert.equal(READ_TOOLS.some((tool) => WRITE_TOOLS.includes(tool)), false);
});

test("la CLI exige seleccionar un agente compatible", async (context) => {
  const fixture = createFixture(context);
  const io = captureIo();

  const exitCode = await runCli(["connect", fixture.memory], io);

  assert.equal(exitCode, 1);
  assert.match(io.stderr.join("\n"), /--agent debe ser/);
});

const CURRENT_LAUNCH = "-y @modelcontextprotocol/server-filesystem@2.3.0 --read-only --confine-roots";

function createFixture(context, memoryName = "memory") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "project-memory-connect-"));
  const source = path.join(root, "source");
  const memory = path.join(root, memoryName);
  const home = path.join(root, "home");
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.mkdirSync(source, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(source, "README.md"), "# Demo\n");
  execFileSync("git", ["-C", source, "init", "-q"]);
  initializeMemory(
    {
      destination: memory,
      projectId: "demo-project",
      projectName: "Demo Project",
      sourcePath: source,
      apply: true
    },
    { now: new Date("2026-09-29T12:00:00Z") }
  );

  return { root, source, memory, home };
}

function codexServerOutput(vaultPath, withPolicy, launch = CURRENT_LAUNCH) {
  return {
    status: 0,
    stdout: [
      "demo-project-memory",
      "  command: npx",
      `  args: ${launch} ${vaultPath}`,
      withPolicy ? `  enabled_tools: ${READ_TOOLS.join(", ")}` : ""
    ].join("\n"),
    stderr: ""
  };
}

function claudeServerOutput(vaultPath, launch = CURRENT_LAUNCH) {
  return {
    status: 0,
    stdout: [
      "demo-project-memory:",
      "  Type: stdio",
      "  Command: npx",
      `  Args: ${launch} ${vaultPath}`
    ].join("\n"),
    stderr: ""
  };
}

function missingServer() {
  return { status: 1, stdout: "", stderr: "Server not found" };
}

function success() {
  return { status: 0, stdout: "", stderr: "" };
}

function captureIo() {
  const stdout = [];
  const stderr = [];
  return {
    stdout,
    stderr,
    out(value) {
      stdout.push(value);
    },
    err(value) {
      stderr.push(value);
    }
  };
}
