#!/usr/bin/env node
import { loadWithDependencyCheck } from '../src/missing-dependencies.js';
const args = process.argv.slice(2);
const io = {
  out: t => process.stdout.write(t),
  err: t => process.stderr.write(t),
  input: process.stdin,
  output: process.stdout
};
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

if (args[0] === 'antigravity' && ['barra', 'hook', 'ejecutar'].includes(args[1])) {
  const cli = await loadWithDependencyCheck(() => import('../src/antigravity-command.js'));
  if (cli) process.exitCode = await cli.runAntigravityCommand(args.slice(1), io);
} else {
  const cli = await loadWithDependencyCheck(() => import('../src/toolkit-cli.js'));
  if (cli) process.exitCode = await cli.runToolkitCli(args, io);
}
