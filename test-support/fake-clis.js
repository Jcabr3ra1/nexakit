// Fake `claude`, `codex` and `agy` for tests: they keep their MCP configuration in a temporary HOME the way the real
// CLIs do (~/.claude.json, ~/.codex/config.toml, ~/.gemini/config/mcp_config.json), so connect, the memory locator
// and the setup flow can be exercised end to end without touching the real ones. `fail` makes one call fail:
// { 'agy add': true } fails `agy mcp add`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
};
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
};
const MOD_NAMES = ['niveles', 'nexakit-modelo', 'nexakit-ahorro', 'nexakit-lecciones', 'nexakit-sesion'];
const toolkitRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modVersion = (name) =>
  readJson(path.join(toolkitRoot, 'plugins', name, '.claude-plugin', 'plugin.json'), {}).version;
const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
const missing = () => ({ status: 1, stdout: '', stderr: 'No MCP server found' });

export function createFakeClis(
  home,
  { fail = {}, installed = ['claude', 'codex', 'agy'], reviewOutputs = {}, versions = {}, superpowers = {}, mods = {} } = {},
) {
  const calls = [];
  // Superpowers plugin per CLI: 'activo', 'desactivado' or 'falta' (the default). Kept on disk like the real
  // plugin managers, so a new fake over the same HOME sees what an earlier one installed.
  const pluginsFile = path.join(home, '.fake-plugins.json');
  const { mods: storedMods, ...storedPlugins } = readJson(pluginsFile, {});
  const plugins = { claude: 'falta', codex: 'falta', agy: 'falta', ...storedPlugins, ...superpowers };
  // nexakit's own Claude Code mods: name -> 'activo' | 'desactivado' | 'actualizable' | 'falta' (the default).
  const modStates = { ...Object.fromEntries(MOD_NAMES.map((name) => [name, 'falta'])), ...storedMods, ...mods };
  const savePlugins = () => writeJson(pluginsFile, { ...plugins, mods: modStates });
  const claudeFile = path.join(home, '.claude.json');
  const codexFile = path.join(home, '.codex', 'config.toml');
  const agyFile = path.join(home, '.gemini', 'config', 'mcp_config.json');

  const codexSection = (name) => {
    const text = fs.existsSync(codexFile) ? fs.readFileSync(codexFile, 'utf8') : '';
    const match = text.match(
      new RegExp(
        `^\\[mcp_servers\\.${name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\]\\s*$([\\s\\S]*?)(?=^\\[|(?![\\s\\S]))`,
        'mu',
      ),
    );
    return match ? match[1] : null;
  };

  function runCommand(command, args) {
    calls.push([command, ...args]);
    const cli = command === 'agy' ? 'agy' : command;
    if (!installed.includes(cli)) return { status: null, stdout: '', stderr: '', errorCode: 'ENOENT' };
    if (args.includes('--version')) return ok(versions[cli] ?? 'test-version');
    if (
      (args.includes('exec') || args.includes('-p') || args.includes('--print=')) &&
      Object.hasOwn(reviewOutputs, cli)
    )
      return { status: 0, stderr: '', ...reviewOutputs[cli] };
    const [, verb] = args;
    if (args[0] === 'plugin') return pluginCommand(cli, verb, args);
    if (fail[`${cli} ${verb}`]) return { status: 1, stdout: '', stderr: `${cli} ${verb} falló` };
    const dash = args.indexOf('--');

    if (cli === 'claude') {
      const config = readJson(claudeFile, {});
      if (verb === 'get') {
        const server = config.mcpServers?.[args[2]];
        return server
          ? ok(`${args[2]}:\n  Type: stdio\n  Command: ${server.command}\n  Args: ${server.args.join(' ')}\n`)
          : missing();
      }
      if (verb === 'add') {
        config.mcpServers = {
          ...config.mcpServers,
          [args[dash - 1]]: { type: 'stdio', command: args[dash + 1], args: args.slice(dash + 2), env: {} },
        };
        writeJson(claudeFile, config);
        return ok();
      }
      if (verb === 'remove') {
        delete config.mcpServers?.[args[2]];
        writeJson(claudeFile, config);
        return ok();
      }
    }
    if (cli === 'codex') {
      if (verb === 'get') {
        const section = codexSection(args[2]);
        if (section === null) return missing();
        const value = (key) => section.match(new RegExp(`^${key}\\s*=\\s*(.+)$`, 'mu'))?.[1];
        const list = (raw) => (raw ? JSON.parse(raw) : []);
        return ok(
          [
            args[2],
            `  command: ${JSON.parse(value('command'))}`,
            `  args: ${list(value('args')).join(' ')}`,
            `  enabled_tools: ${list(value('enabled_tools')).join(', ')}`,
          ].join('\n'),
        );
      }
      if (verb === 'add') {
        fs.mkdirSync(path.dirname(codexFile), { recursive: true });
        fs.appendFileSync(
          codexFile,
          `\n[mcp_servers.${args[2]}]\ncommand = ${JSON.stringify(args[dash + 1])}\nargs = ${JSON.stringify(args.slice(dash + 2))}\n`,
        );
        return ok();
      }
      if (verb === 'remove') return ok();
    }
    if (cli === 'agy') {
      if (verb === 'list') return ok('No MCP servers configured.\n');
      if (verb === 'add') {
        const config = readJson(agyFile, {});
        config.mcpServers = {
          ...config.mcpServers,
          [args[2]]: { command: args[dash + 1], args: args.slice(dash + 2), disabled: false },
        };
        writeJson(agyFile, config);
        return ok(`Added MCP server "${args[2]}" (stdio)\n`);
      }
    }
    throw new Error(`Orden inesperada: ${command} ${args.join(' ')}`);
  }

  function pluginCommand(cli, verb, args = []) {
    const modName = cli === 'claude' ? MOD_NAMES.find((name) => args[2] === `${name}@agent-toolkit`) : undefined;
    // A mod fails only with its own key ('claude plugin install niveles'), so the generic ones keep meaning Superpowers.
    if (modName && fail[`${cli} plugin ${verb} ${modName}`])
      return { status: 1, stdout: '', stderr: `${cli} plugin ${verb} ${modName} falló` };
    if (!modName && fail[`${cli} plugin ${verb}`]) return { status: 1, stdout: '', stderr: `${cli} plugin ${verb} falló` };
    const state = plugins[cli];
    if (cli === 'claude' && verb === 'marketplace') {
      if (fail[`${cli} plugin marketplace ${args[2]}`])
        return { status: 1, stdout: '', stderr: `${cli} plugin marketplace ${args[2]} falló` };
      return ok();
    }
    if (modName) {
      if (['install', 'enable', 'update'].includes(verb)) {
        modStates[modName] = 'activo';
        savePlugins();
        return ok();
      }
      throw new Error(`Orden inesperada: ${cli} plugin ${verb} ${args[2]}`);
    }
    if (verb === 'list') {
      if (cli === 'claude') {
        const entries = state === 'falta' ? [] : [{ id: 'superpowers@claude-plugins-official', enabled: state === 'activo' }];
        for (const name of MOD_NAMES) {
          const mod = modStates[name];
          if (mod === 'falta') continue;
          entries.push({
            id: `${name}@agent-toolkit`,
            enabled: mod !== 'desactivado',
            version: mod === 'actualizable' ? '0.0.0' : modVersion(name),
          });
        }
        return ok(JSON.stringify(entries));
      }
      if (cli === 'codex') {
        const status = { falta: 'not installed', activo: 'installed, enabled', desactivado: 'installed, disabled' }[state];
        return ok(`superpowers@openai-curated-remote   ${status}   7.0.1   id\n`);
      }
      return state === 'falta' ? ok('No plugins installed.\n') : ok(JSON.stringify([{ name: 'superpowers', enabled: state === 'activo' }]));
    }
    if (['install', 'add', 'enable'].includes(verb)) {
      plugins[cli] = 'activo';
      savePlugins();
      return ok();
    }
    throw new Error(`Orden inesperada: ${cli} plugin ${verb}`);
  }

  // Executables on the PATH so nexakit finds the agents installed; they are never run (runCommand is used).
  function installBin(bin) {
    fs.mkdirSync(bin, { recursive: true });
    for (const name of installed) {
      const file = path.join(bin, process.platform === 'win32' ? `${name}.cmd` : name);
      fs.writeFileSync(file, process.platform === 'win32' ? '@exit /b 0\r\n' : '#!/bin/sh\nexit 0\n', {
        mode: 0o755,
      });
    }
  }

  return { runCommand, calls, installBin, plugins, mods: modStates, files: { claudeFile, codexFile, agyFile } };
}

// A real child process for review integration tests; no model or user configuration is accessed.
export function writeReviewFixtureCli(directory) {
  const script = path.join(directory, 'review-fixture.cjs');
  fs.writeFileSync(
    script,
    `
const client = process.argv[2];
const args = process.argv.slice(3);
if (args.includes('models')) { console.log('gemini-fixture-low\\tFixture'); process.exit(0); }
if (args.includes('--version')) { console.log('fixture-v1'); process.exit(0); }
let input = '';
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  const prompt = client === 'antigravity' ? JSON.parse(input).message.content : input;
  const probe = prompt.startsWith('Prueba de aislamiento');
  if (client === 'codex') {
    const events = [{ type: 'thread.started', thread_id: 'fixture' }];
    if (probe) events.push({ type: 'item.completed', item: { type: 'command_execution', exit_code: 1, aggregated_output: 'operation not permitted' } });
    else events.push({ type: 'item.completed', item: { type: 'agent_message', text: 'Informe de prueba: no hay hallazgos.' } });
    events.push({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } });
    console.log(events.map(e => JSON.stringify(e)).join('\\n'));
  } else if (client === 'claude') {
    console.log(JSON.stringify(probe ? { permission_denials: [{ tool_name: prompt.includes('shell') ? 'Bash' : 'Write' }] } : { result: 'Informe de prueba: no hay hallazgos.', model: 'haiku', usage: { input_tokens: 10, output_tokens: 2 } }));
  } else {
    const action = prompt.includes('MCP') ? 'mcp' : prompt.includes('shell') ? 'command' : 'write_file';
    console.log(JSON.stringify({ event: 'result', result: probe ? { denied_actions: [{ action }] } : { status: 'SUCCESS', response: 'Informe de prueba: no hay hallazgos.', usage: { input_tokens: 10, output_tokens: 2 } } }));
  }
});
`,
  );
  return script;
}
