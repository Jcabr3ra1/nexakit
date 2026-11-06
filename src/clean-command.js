import { spawn, execFile } from 'node:child_process';
import { resolveCliInvocation } from './cli-executable.js';

// No shell, bounded output, stdin closed. The abort signal ends the process tree.
export async function runCleanCommand(command, args, { cwd, signal, env = process.env } = {}) {
  if (process.platform === 'win32' && ['npm','npx'].includes(command)) {
    const invocation = await resolveCliInvocation({ name: command, environment: env });
    command = invocation.executable; args = [...invocation.argsPrefix, ...args];
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, shell:false, detached:process.platform !== 'win32', windowsHide:true, stdio:['ignore','pipe','pipe'] });
    let stdout = '', stderr = '', size = 0;
    const stop = () => {
      if (!child.pid) return;
      if (process.platform === 'win32') execFile('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], () => {});
      else { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
    };
    const collect = key => chunk => {
      size += chunk.length;
      if (size > 16 * 1024 * 1024) { stop(); return; }
      if (key === 'out') stdout += chunk; else stderr += chunk;
    };
    child.stdout.on('data', collect('out')); child.stderr.on('data', collect('err'));
    signal?.addEventListener('abort', stop, {once:true}); if (signal?.aborted) stop();
    child.once('error', error => { signal?.removeEventListener('abort', stop); reject(error); });
    child.once('close', status => { signal?.removeEventListener('abort', stop); resolve({status,stdout,stderr}); });
  });
}
