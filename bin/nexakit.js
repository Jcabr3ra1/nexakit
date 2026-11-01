#!/usr/bin/env node
import { loadWithDependencyCheck } from '../src/missing-dependencies.js';
const cli = await loadWithDependencyCheck(() => import('../src/toolkit-cli.js'));
if (cli) {
  process.stdout.on('error', () => {});
  process.stderr.on('error', () => {});
  process.exitCode = await cli.runToolkitCli(process.argv.slice(2), {
    out: t => process.stdout.write(t),
    err: t => process.stderr.write(t),
    input: process.stdin,
    output: process.stdout
  });
}
