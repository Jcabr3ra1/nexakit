import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { compactarSalida } from '../plugins/nexakit-ahorro/hooks/compactar.js';

const FAILURE = /(error|fail|falla|✖|✗|not ok|exception|traceback|panic|assert|warn|denied|refused|cannot|no se pudo)/iu;
const emit = (sink, text) => typeof sink === 'function' ? sink(text) : sink.write(text);

// No full-output array: at most 12k exact characters and bounded line samples.
function sampler() {
  const decoder = new StringDecoder('utf8');
  let exact = '', chars = 0, newlines = 0, start = '', end = '', window = '', failure = '', long = false;
  const head = [], tail = [], failures = [];
  function line() {
    const value = long ? `${start.slice(0, 140)} … ${failure.slice(0, 140)} … ${end.slice(-100)}` : start;
    if (head.length < 20) head.push(value);
    else {
      tail.push(value);
      if (tail.length > 40) {
        const middle = tail.shift();
        if (FAILURE.test(middle) && failures.length < 40 && !failures.includes(middle)) failures.push(middle);
      }
    }
    start = ''; end = ''; window = ''; failure = ''; long = false;
  }
  function accept(text) {
    chars += text.length;
    if (exact !== null) exact = chars <= 12000 ? exact + text : null;
    let offset = 0;
    while (offset < text.length) {
      const newline = text.indexOf('\n', offset);
      const piece = text.slice(offset, newline < 0 ? text.length : newline);
      if (start.length + piece.length > 400) long = true;
      start = (start + piece).slice(0, 400);
      end = (end + piece).slice(-180);
      const search = window + piece;
      const match = FAILURE.exec(search);
      if (match && !failure) failure = search.slice(Math.max(0, match.index - 30), match.index + 200);
      window = search.slice(-40);
      if (newline < 0) break;
      newlines++; line(); offset = newline + 1;
    }
  }
  return {
    push(chunk) { accept(decoder.write(chunk)); },
    finish(ruta) {
      accept(decoder.end()); line();
      if (exact !== null) {
        const result = compactarSalida(exact, { ruta });
        return { text: result.texto, chars, lines: chars ? newlines + 1 : 0, trimmed: result.omitidas > 0 };
      }
      // Force the shared formatter to apply its bounded line policy. The filler
      // represents omitted middle lines, never the full output in memory.
      const selected = [...head, ...Array(121).fill(''), ...failures, ...tail];
      const result = compactarSalida(selected.join('\n'), { ruta });
      const kept = head.length + failures.length + tail.length;
      const text = result.texto.replace(/\d+ líneas omitidas de \d+/u, `${Math.max(0, newlines + 1 - kept)} líneas omitidas de ${newlines + 1}`);
      return { text, chars, lines: newlines + 1, trimmed: true };
    },
  };
}

// Reject symlinks in every existing component, including supplied home paths.
function directory(target, create = false) {
  const absolute = path.resolve(target);
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Directorio inseguro');
    } catch (error) {
      if (error.code !== 'ENOENT' || !create) throw error;
      try { fs.mkdirSync(current, { mode: 0o700 }); }
      catch (created) { if (created.code !== 'EEXIST') throw created; }
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Directorio inseguro');
    }
  }
  return absolute;
}
function privateDirectory(target) {
  directory(target, true);
  fs.chmodSync(target, 0o700);
  return target;
}
function writeAll(fd, chunk) {
  let offset = 0;
  while (offset < chunk.length) {
    const written = fs.writeSync(fd, chunk, offset, chunk.length - offset);
    if (!written) throw new Error('Escritura incompleta');
    offset += written;
  }
}
function record(home, row) {
  directory(home);
  const target = path.join(home, 'ahorro.jsonl');
  try {
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Registro inseguro');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('Registro inseguro');
    fs.fchmodSync(fd, 0o600);
    writeAll(fd, Buffer.from(JSON.stringify(row) + '\n'));
  } finally { fs.closeSync(fd); }
}

/** Execute literal argv once. If storage fails, replay the saved prefix (mixed
 * channels on stdout), then pass both streams through without compacting.
 * If replay also fails, show the bounded retained samples before live output.
 * Full mode streams immediately; the disk copy still remains private.
 * Windows .cmd/.bat files require an explicit interpreter in argv; for npm,
 * pass node and npm-cli.js, preserving shell:false and literal arguments.
 */
export async function runCodexOutput(argv, { out, err, input }, options = {}) {
  if (!Array.isArray(argv) || !argv.length || argv.some(arg => typeof arg !== 'string') || !argv[0]) {
    emit(err, 'nexakit: falta programa o argumentos inválidos\n');
    return 2;
  }
  const env = options.env ?? process.env;
  const bypass = env.NEXAKIT_SALIDA === 'completa';
  const samples = [sampler(), sampler()];
  const sinks = [out, err];
  const liveDecoders = [new StringDecoder('utf8'), new StringDecoder('utf8')];
  let fd, ruta, home, saved = 0, fallback = false;
  try {
    // Automatic wrapping runs inside the tool sandbox. Its private temporary
    // store requires no additional access to the real user home.
    const root = env.NEXAKIT_CODEX_TEMP_OUTPUT === '1'
      ? privateDirectory(path.join(directory(fs.realpathSync(options.tempDirectory ?? os.tmpdir())), `nexakit-codex-${process.getuid?.() ?? 'user'}`))
      : directory(options.homeDirectory ?? os.homedir());
    home = privateDirectory(path.join(root, '.nexakit'));
    const folder = privateDirectory(path.join(home, 'salidas'));
    ruta = path.join(folder, `${Date.now()}-${randomUUID()}.log`);
    fd = fs.openSync(ruta, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  } catch {
    fallback = true;
    emit(err, 'nexakit: no se pudo guardar la salida; se muestra completa.\n');
  }
  function capture(index, chunk) {
    if (!fallback) {
      try { writeAll(fd, chunk); saved += chunk.length; }
      catch {
        fallback = true;
        emit(err, 'nexakit: no se pudo guardar la salida; se reproduce el prefijo combinado y se muestra completa.\n');
        if (!bypass) {
          const buffer = Buffer.alloc(65536);
          const decoder = new StringDecoder('utf8');
          try {
            for (let offset = 0; offset < saved;) {
              const size = fs.readSync(fd, buffer, 0, Math.min(buffer.length, saved - offset), offset);
              if (!size) break;
              emit(out, decoder.write(buffer.subarray(0, size))); offset += size;
            }
            emit(out, decoder.end());
          } catch {
            emit(err, 'nexakit: no se pudo recuperar el prefijo guardado; se muestra la muestra retenida.\n');
            for (const [sampleIndex, sample] of samples.entries()) emit(sinks[sampleIndex], sample.finish(ruta).text);
          }
        }
      }
    }
    if (fallback || bypass) emit(sinks[index], liveDecoders[index].write(chunk));
    else samples[index].push(chunk);
  }
  let exitCode;
  try {
    exitCode = await new Promise(resolve => {
      let child;
      try {
        child = spawn(argv[0], argv.slice(1), {
          shell: false, cwd: options.projectRoot ?? process.cwd(), env,
          stdio: [input == null ? 'inherit' : 'pipe', 'pipe', 'pipe'],
        });
      } catch (error) {
        emit(err, `nexakit: ${error.code ?? 'spawn error'}\n`); resolve(error.code === 'ENOENT' ? 127 : 1); return;
      }
      let spawnError;
      child.stdout.on('data', chunk => capture(0, chunk));
      child.stderr.on('data', chunk => capture(1, chunk));
      child.on('error', error => {
        spawnError = error.code === 'ENOENT' ? 127 : 1;
        emit(err, `nexakit: ${error.code ?? 'spawn error'}\n`);
      });
      if (input != null) {
        child.stdin.on('error', error => { if (error.code !== 'EPIPE') emit(err, 'nexakit: fallo de stdin\n'); });
        if (typeof input.pipe === 'function') {
          input.pipe(child.stdin);
          child.once('close', () => input.unpipe(child.stdin));
        } else child.stdin.end(input);
      }
      child.on('close', (code, signal) => resolve(spawnError ?? code ?? (128 + (os.constants.signals[signal] ?? 0))));
    });
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); }
      catch { emit(err, 'nexakit: no se pudo cerrar la copia de salida.\n'); }
    }
  }
  if (fallback || bypass) {
    for (const [index, decoder] of liveDecoders.entries()) emit(sinks[index], decoder.end());
  }
  if (!fallback && !bypass) {
    const results = samples.map(sample => sample.finish(ruta));
    for (const [index, result] of results.entries()) emit(sinks[index], result.text);
    const before = results.reduce((sum, result) => sum + result.chars, 0);
    const after = results.reduce((sum, result) => sum + result.text.length, 0);
    const linesBefore = results.reduce((sum, result) => sum + result.lines, 0);
    const linesAfter = results.reduce((sum, result) => sum + (result.text ? result.text.split('\n').length : 0), 0);
    if (results.some(result => result.trimmed) && before > after && linesBefore >= linesAfter) {
      try {
        record(home, { fecha: Date.now(), antes: before, despues: after, lineasAntes: linesBefore, lineasDespues: linesAfter, agent: 'codex' });
      } catch { emit(err, 'nexakit: no se pudo guardar el registro de ahorro.\n'); }
    }
  }
  return exitCode;
}
