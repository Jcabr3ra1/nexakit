// Fake `claude`, `codex` and `agy` for tests: they keep their MCP configuration in a temporary HOME the way the real
// CLIs do (~/.claude.json, ~/.codex/config.toml, ~/.gemini/config/mcp_config.json), so connect, the memory locator
// and the setup flow can be exercised end to end without touching the real ones. `fail` makes one call fail:
// { 'agy add': true } fails `agy mcp add`.
import fs from 'node:fs';
import path from 'node:path';

const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
const writeJson = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2)); };
const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
const missing = () => ({ status: 1, stdout: '', stderr: 'No MCP server found' });

export function createFakeClis(home, { fail = {}, installed = ['claude', 'codex', 'agy'], reviewOutputs = {}, versions = {} } = {}) {
  const calls = [];
  const claudeFile = path.join(home, '.claude.json');
  const codexFile = path.join(home, '.codex', 'config.toml');
  const agyFile = path.join(home, '.gemini', 'config', 'mcp_config.json');

  const codexSection = name => {
    const text = fs.existsSync(codexFile) ? fs.readFileSync(codexFile, 'utf8') : '';
    const match = text.match(new RegExp(`^\\[mcp_servers\\.${name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\]\\s*$([\\s\\S]*?)(?=^\\[|(?![\\s\\S]))`, 'mu'));
    return match ? match[1] : null;
  };

  function runCommand(command, args) {
    calls.push([command, ...args]);
    const cli = command === 'agy' ? 'agy' : command;
    if (!installed.includes(cli)) return { status: null, stdout: '', stderr: '', errorCode: 'ENOENT' };
    if (args.includes('--version')) return ok(versions[cli] ?? 'test-version');
    if ((args.includes('exec') || args.includes('-p') || args.includes('--print=')) && Object.hasOwn(reviewOutputs, cli)) return { status: 0, stderr: '', ...reviewOutputs[cli] };
    const [, verb] = args;
    if (fail[`${cli} ${verb}`]) return { status: 1, stdout: '', stderr: `${cli} ${verb} falló` };
    const dash = args.indexOf('--');

    if (cli === 'claude') {
      const config = readJson(claudeFile, {});
      if (verb === 'get') {
        const server = config.mcpServers?.[args[2]];
        return server ? ok(`${args[2]}:\n  Type: stdio\n  Command: ${server.command}\n  Args: ${server.args.join(' ')}\n`) : missing();
      }
      if (verb === 'add') {
        config.mcpServers = { ...config.mcpServers, [args[dash - 1]]: { type: 'stdio', command: args[dash + 1], args: args.slice(dash + 2), env: {} } };
        writeJson(claudeFile, config);
        return ok();
      }
      if (verb === 'remove') { delete config.mcpServers?.[args[2]]; writeJson(claudeFile, config); return ok(); }
    }
    if (cli === 'codex') {
      if (verb === 'get') {
        const section = codexSection(args[2]);
        if (section === null) return missing();
        const value = key => section.match(new RegExp(`^${key}\\s*=\\s*(.+)$`, 'mu'))?.[1];
        const list = raw => (raw ? JSON.parse(raw) : []);
        return ok([args[2], `  command: ${JSON.parse(value('command'))}`, `  args: ${list(value('args')).join(' ')}`,
          `  enabled_tools: ${list(value('enabled_tools')).join(', ')}`].join('\n'));
      }
      if (verb === 'add') {
        fs.mkdirSync(path.dirname(codexFile), { recursive: true });
        fs.appendFileSync(codexFile, `\n[mcp_servers.${args[2]}]\ncommand = ${JSON.stringify(args[dash + 1])}\nargs = ${JSON.stringify(args.slice(dash + 2))}\n`);
        return ok();
      }
      if (verb === 'remove') return ok();
    }
    if (cli === 'agy') {
      if (verb === 'list') return ok('No MCP servers configured.\n');
      if (verb === 'add') {
        const config = readJson(agyFile, {});
        config.mcpServers = { ...config.mcpServers, [args[2]]: { command: args[dash + 1], args: args.slice(dash + 2), disabled: false } };
        writeJson(agyFile, config);
        return ok(`Added MCP server "${args[2]}" (stdio)\n`);
      }
    }
    throw new Error(`Orden inesperada: ${command} ${args.join(' ')}`);
  }

  // Executables on the PATH so nexakit finds the agents installed; they are never run (runCommand is used).
  function installBin(bin) {
    fs.mkdirSync(bin, { recursive: true });
    for (const name of installed) {
      const file = path.join(bin, process.platform === 'win32' ? `${name}.cmd` : name);
      fs.writeFileSync(file, process.platform === 'win32' ? '@exit /b 0\r\n' : '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    }
  }

  return { runCommand, calls, installBin, files: { claudeFile, codexFile, agyFile } };
}
