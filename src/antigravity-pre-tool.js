import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { motivoBash, motivoEscritura } from '../plugins/nexakit-guardarrailes/hooks/guardarrailes.js';
import {
  claveDeComando,
  claveDeError,
  esRegistroDeLeccion,
  esRutaDeMemoria,
  leerEventos,
  notaRepeticion,
  podarEventos,
  sinGuardar,
  textoSeguro,
} from '../plugins/nexakit-lecciones/hooks/lecciones.js';
import { mutateAntigravitySessionState, readAntigravitySessionState } from './antigravity-session.js';
import { buildOutputWrapperCommand } from './codex-pre-tool.js';

const REPETIR = /(^|\s)NEXAKIT_REPETIR=1(\s|$)/u;
const TOPE_MISMO_ERROR = 3;
const MAX_LEDGER_BYTES = 1024 * 1024;
const SHELL_TOOLS = new Set(['run_command', 'Bash']);
const WRITE_TOOLS = new Set(['write_file', 'write_to_file', 'Write']);
const EDIT_TOOLS = new Set(['edit_file', 'Edit', 'MultiEdit', 'replace_file_content', 'multi_replace_file_content']);

function isAntigravityMemoryNote(filePath) {
  if (typeof filePath !== 'string' || !filePath) return false;
  if (esRutaDeMemoria(filePath)) return true;
  const normalized = filePath.replaceAll('\\', '/');
  return /\/memory\/[^/]+\.md$/u.test(normalized) && !/\/MEMORY\.md$/u.test(normalized);
}

function unquotePosix(token) {
  if (!token.startsWith("'") || !token.endsWith("'")) return token;
  return token.slice(1, -1).replaceAll("'\"'\"'", "'").replaceAll("'\\''", "'");
}

/** Recover the original wrapped command if `CommandLine` invokes `nexakit antigravity ejecutar -- ...`. */
export function unwrapAntigravityCommand(command) {
  if (typeof command !== 'string') return '';
  const match = /^NEXAKIT_ANTIGRAVITY_TEMP_OUTPUT=1\s+.*?\s+'antigravity'\s+'ejecutar'\s+'--'\s+(.+)$/u.exec(command.trim());
  if (!match) return command;
  const tokens = match[1].match(/'(?:[^']|'"'"'|'\\'')*'/gu);
  return tokens?.length ? tokens.map(unquotePosix).join(' ') : command;
}

function extractToolAction(payload) {
  const call = payload?.toolCall;
  if (!call || typeof call !== 'object') return null;
  const name = call.name;
  const args = call.args && typeof call.args === 'object' && !Array.isArray(call.args) ? call.args : {};
  if (SHELL_TOOLS.has(name)) {
    const key = typeof args.CommandLine === 'string' ? 'CommandLine' : 'command';
    const command = typeof args[key] === 'string' ? args[key] : '';
    return { kind: 'shell', key, command, args };
  }
  const filePath = args.Path ?? args.TargetFile ?? args.file_path ?? args.path;
  if (WRITE_TOOLS.has(name)) {
    const content = args.Content ?? args.CodeContent ?? args.content;
    return { kind: 'write', filePath, texts: typeof content === 'string' ? [content] : [], args };
  }
  if (EDIT_TOOLS.has(name)) {
    const texts = [];
    if (typeof args.Replacement === 'string') texts.push(args.Replacement);
    if (typeof args.new_string === 'string') texts.push(args.new_string);
    if (Array.isArray(args.edits)) {
      for (const edit of args.edits) {
        if (typeof edit?.new_string === 'string') texts.push(edit.new_string);
      }
    }
    if (Array.isArray(args.ReplacementChunks)) {
      for (const chunk of args.ReplacementChunks) {
        if (typeof chunk?.ReplacementContent === 'string') texts.push(chunk.ReplacementContent);
      }
    }
    return { kind: 'edit', filePath, texts, args };
  }
  return null;
}

async function safeNexakitDir(options, create) {
  const home = path.resolve(options.homeDirectory ?? os.homedir());
  const dir = path.join(home, '.nexakit');
  if (create) await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(dir).catch(() => null);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) return null;
  if (create) await fs.chmod(dir, 0o700).catch(() => {});
  return dir;
}

/** Read `~/.nexakit/lecciones.jsonl` safely (no symlinks, bounded size). */
export async function readAntigravityLessons(options = {}) {
  try {
    const dir = await safeNexakitDir(options, false);
    if (!dir) return [];
    const target = path.join(dir, 'lecciones.jsonl');
    const stat = await fs.lstat(target).catch(() => null);
    if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_LEDGER_BYTES) return [];
    const fd = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      return leerEventos(await fd.readFile('utf8'));
    } finally {
      await fd.close().catch(() => {});
    }
  } catch {
    return [];
  }
}

/** Append an event atomically to `~/.nexakit/lecciones.jsonl`, pruning to 90d / 500 entries. */
export async function appendAntigravityLesson(event, options = {}) {
  try {
    const dir = await safeNexakitDir(options, true);
    if (!dir) return;
    const target = path.join(dir, 'lecciones.jsonl');
    const existing = await fs.lstat(target).catch(() => null);
    if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1)) return;
    const now = typeof options.now === 'number' && Number.isFinite(options.now) ? options.now : Date.now();
    const events = podarEventos([...(await readAntigravityLessons(options)), { fecha: now, ...event }], now);
    const body = `${events.map((item) => JSON.stringify(item)).join('\n')}\n`;
    const temp = path.join(dir, `.tmp-lec-${process.pid}-${randomUUID()}.jsonl`);
    try {
      await fs.writeFile(temp, body, { flag: 'wx', mode: 0o600 });
      await fs.rename(temp, target);
    } finally {
      await fs.rm(temp, { force: true }).catch(() => {});
    }
  } catch {
    // Lessons recording must never block execution.
  }
}

/** Handle Antigravity `PreToolUse`: guardarrailes, duplicate-failure block, and ahorro wrapper. */
export async function handleAntigravityPreToolUse(payload, options = {}) {
  try {
    const action = extractToolAction(payload);
    if (!action) return { decision: 'allow' };

    if (action.kind === 'write' || action.kind === 'edit') {
      const deny = motivoEscritura(action.filePath, action.texts);
      return deny ? { decision: 'deny', reason: deny } : { decision: 'allow' };
    }

    const rawCommand = unwrapAntigravityCommand(action.command);
    const guardDeny = motivoBash(rawCommand);
    if (guardDeny) return { decision: 'deny', reason: guardDeny };

    const cmdKey = claveDeComando(rawCommand);
    if (cmdKey && payload.conversationId && !REPETIR.test(rawCommand)) {
      const state = await readAntigravitySessionState(payload.conversationId, options);
      const prevFailure = state?.lecciones?.fallidos?.[cmdKey];
      if (prevFailure) {
        await appendAntigravityLesson({ tipo: 'freno' }, options);
        return {
          decision: 'deny',
          reason: `nexakit: este comando ya falló así y no ha cambiado nada desde entonces:\n${prevFailure}\nCambia de enfoque. Si de verdad corregiste la causa por otra vía, repítelo con NEXAKIT_REPETIR=1 delante.`,
        };
      }
    }

    const isDaemon = ['IsDaemon', 'Background', 'background', 'run_in_background'].some((k) => Boolean(action.args[k]));
    if (!isDaemon) {
      const wrapper = buildOutputWrapperCommand(rawCommand, {
        executable: options.executable,
        entrypoint: options.entrypoint,
        agent: 'antigravity',
        tempEnv: 'NEXAKIT_ANTIGRAVITY_TEMP_OUTPUT=1',
        platform: options.platform ?? process.platform,
        environment: options.environment ?? process.env,
      });
      if (wrapper) {
        return { decision: 'allow', overwrite: { [action.key]: wrapper } };
      }
    }
    return { decision: 'allow' };
  } catch {
    return { decision: 'allow' };
  }
}

/** Handle Antigravity `PostToolUse`: clear failures on progress, track errors & memory writes. */
export async function handleAntigravityPostToolUse(payload, options = {}) {
  try {
    const action = extractToolAction(payload);
    const failed = typeof payload?.error === 'string' && payload.error.trim() !== '';

    if (action && (action.kind === 'write' || action.kind === 'edit')) {
      if (!failed && payload.conversationId) {
        await mutateAntigravitySessionState(payload.conversationId, (state) => {
          state.lecciones.fallidos = {};
          return state;
        }, options);
      }
      if (!failed && isAntigravityMemoryNote(action.filePath)) {
        const events = await readAntigravityLessons(options);
        if (sinGuardar(events).length > 0) {
          await appendAntigravityLesson({ tipo: 'guardada' }, options);
        }
      }
      return {};
    }

    if (action?.kind === 'shell' && payload.conversationId) {
      const original = unwrapAntigravityCommand(action.command);
      const cmdKey = claveDeComando(original);
      if (!failed) {
        await mutateAntigravitySessionState(payload.conversationId, (state) => {
          state.lecciones.fallidos = {};
          return state;
        }, options);
        // Registrar la lección en el almacén común también guarda las correcciones pendientes.
        if (esRegistroDeLeccion(original) && sinGuardar(await readAntigravityLessons(options)).length > 0) {
          await appendAntigravityLesson({ tipo: 'guardada' }, options);
        }
        return {};
      }
      const errText = payload.error;
      const errType = claveDeError(errText);
      let triggeredRepetition = false;
      await mutateAntigravitySessionState(payload.conversationId, (state) => {
        if (cmdKey) state.lecciones.fallidos[cmdKey] = errText.split('\n').slice(0, 3).join('\n').slice(0, 400);
        if (errType) {
          const count = (state.lecciones.errores[errType] ?? 0) + 1;
          state.lecciones.errores[errType] = count;
          if (count === TOPE_MISMO_ERROR) {
            triggeredRepetition = true;
            state.lecciones.pendingRepetitionNotice =
              notaRepeticion(count, errType);
          }
        }
        return state;
      }, options);
      if (triggeredRepetition) await appendAntigravityLesson({ tipo: 'repeticion', clave: textoSeguro(errType) }, options);
    }
    return {};
  } catch {
    return {};
  }
}
