import { spawn as nativeSpawn, execFile } from 'node:child_process';
import path from 'node:path';

const aborted = () => Object.assign(new Error('Revisión cancelada.'), { code: 'ABORT_ERR' });
export async function runRevisionProcess(invocation, { prompt, timeoutMs = 900000, signal, spawn = nativeSpawn, maxOutputBytes = 16 * 1024 * 1024 } = {}) {
  if (signal?.aborted) throw aborted();
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 900000) throw new Error('Tiempo de revisión inválido.');
  const input = invocation.inputFormat === 'stream-json' ? JSON.stringify({ event: 'user', message: { role: 'user', content: prompt } }) + '\n' : prompt;
  return new Promise((resolve, reject) => {
    let child, failure, timedOut = false, total = 0, killTimer, timer;
    const stdout = [], stderr = [];
    const kill = force => {
      if (!child?.pid) return;
      if (process.platform === 'win32') {
        const systemRoot = process.env.SystemRoot || 'C:\\Windows';
        execFile(path.join(systemRoot, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
      } else {
        try { process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM'); } catch (e) { if (e.code !== 'ESRCH') child.kill(force ? 'SIGKILL' : 'SIGTERM'); }
      }
    };
    const stop = error => {
      if (failure || timedOut) return;
      if (error) failure = error; else timedOut = true;
      kill(false);
      killTimer = setTimeout(() => kill(true), 250);
    };
    const onAbort = () => stop(aborted());
    const clean = () => { clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', onAbort); };
    try {
      child = spawn(invocation.executable, invocation.args, {
        cwd: invocation.cwd, env: invocation.env, shell: false, detached: process.platform !== 'win32', windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (e) { reject(e); return; }
    const collect = target => chunk => {
      total += Buffer.byteLength(chunk);
      if (total > maxOutputBytes) { stop(new Error('La salida del revisor supera el límite.')); return; }
      target.push(Buffer.from(chunk));
    };
    child.stdout.on('data', collect(stdout)); child.stderr.on('data', collect(stderr));
    child.on('error', e => { failure = e; });
    child.stdin.on('error', e => { if (e.code !== 'EPIPE') stop(e); });
    child.on('close', status => {
      // A descendant can survive its parent; finish killing the group on cancellation.
      if (failure || timedOut) kill(true);
      clean();
      if (failure) reject(failure);
      else resolve({ status, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), timedOut });
    });
    timer = setTimeout(() => stop(), timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    child.stdin.end(input, 'utf8');
  });
}
