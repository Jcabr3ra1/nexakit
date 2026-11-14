import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const ENTRYPOINT = fileURLToPath(new URL('../bin/nexakit.js', import.meta.url));
const TASKS = new Set(['test', 'build', 'lint', 'check']);
const MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const NODE_SWITCHES = new Set(['--test-only', '--test-force-exit', '--test-coverage', '--experimental-test-coverage']);
const NODE_VALUES = new Map([
  ['--test-reporter', /^(?:tap|spec|dot)$/u],
  ['--test-concurrency', /^[1-9][0-9]*$/u],
  ['--test-timeout', /^[1-9][0-9]*$/u],
  ['--test-name-pattern', /^[A-Za-z0-9_./:@%+=,-]+$/u],
  ['--test-skip-pattern', /^[A-Za-z0-9_./:@%+=,-]+$/u],
]);
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const quoteShell = token => `'${token.replaceAll("'", "'\"'\"'")}'`;
const safeAbsolutePath = value => typeof value === 'string' && posix.isAbsolute(value) &&
  value.length <= 4096 && !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value);

function nodeTests(argv) {
  if (argv[1] !== '--test') return false;
  let filesOnly = false;
  for (let index = 2; index < argv.length; index++) {
    const token = argv[index];
    if (!filesOnly && token === '--') { filesOnly = true; continue; }
    if (!filesOnly && token.startsWith('-')) {
      if (NODE_SWITCHES.has(token)) continue;
      const equals = token.indexOf('=');
      const name = equals < 0 ? token : token.slice(0, equals);
      const pattern = NODE_VALUES.get(name);
      if (!pattern) return false;
      const value = equals < 0 ? argv[++index] : token.slice(equals + 1);
      if (typeof value !== 'string' || !pattern.test(value)) return false;
    } else if (token.startsWith('-') || !/\.(?:js|cjs|mjs)$/u.test(token)) return false;
  }
  return true;
}

function approvedOutputCommand(argv) {
  // Conservative bypass: preserve interactive and structured-output commands intact.
  if (argv.some(token => /watch|inspect|interactive|tty|background/iu.test(token) ||
      /^(?:-w|-i|-t|-it|-ti|--ui|--open|--debug)(?:=|$)/u.test(token) ||
      /(?:^|[-=,:])json(?:l)?(?:$|[-=,:])/iu.test(token))) return false;
  if (argv[0] === 'node') return nodeTests(argv);
  if (!MANAGERS.has(argv[0])) return false;
  return argv[1] === 'test' || (argv[1] === 'run' && TASKS.has(argv[2])) ||
    (argv[0] === 'yarn' && TASKS.has(argv[1]));
}

export function buildOutputWrapperCommand(command, {
  executable = process.execPath,
  entrypoint = ENTRYPOINT,
  agent = 'codex',
  tempEnv = 'NEXAKIT_CODEX_TEMP_OUTPUT=1',
  platform = process.platform,
  environment = process.env,
} = {}) {
  if (platform === 'win32' || environment.NEXAKIT_SALIDA === 'completa') return null;
  if (typeof command !== 'string' || command.length > 16 * 1024 ||
      !/^[A-Za-z0-9_./:@%+=, -]+$/u.test(command)) return null;
  const argv = command.trim().split(/ +/u);
  if (!approvedOutputCommand(argv)) return null;
  if (!safeAbsolutePath(executable) || !safeAbsolutePath(entrypoint)) return null;
  return `${tempEnv} ${[executable, entrypoint, agent, 'ejecutar', '--', ...argv].map(quoteShell).join(' ')}`;
}

/** Pure, synchronous PreToolUse rewrite. Unknown inputs always retain their original route. */
export function rewriteCodexToolInput(payload, options = {}) {
  if (!isRecord(payload) || payload.hook_event_name !== 'PreToolUse' || payload.tool_name !== 'Bash' ||
      !isRecord(payload.tool_input)) return {};
  const input = payload.tool_input;
  if (('sandbox_permissions' in input && input.sandbox_permissions !== 'use_default') ||
      ['tty', 'interactive', 'background', 'run_in_background'].some(key => input[key])) return {};
  const wrapper = buildOutputWrapperCommand(input.command, {
    executable: options.executable,
    entrypoint: options.entrypoint,
    agent: 'codex',
    tempEnv: 'NEXAKIT_CODEX_TEMP_OUTPUT=1',
    platform: options.platform ?? process.platform,
    environment: options.environment ?? process.env,
  });
  if (!wrapper) return {};
  return { hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'allow',
    updatedInput: { ...input, command: wrapper },
  } };
}
