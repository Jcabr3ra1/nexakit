#!/usr/bin/env node
import { loadWithDependencyCheck } from "../src/missing-dependencies.js";

const cli = await loadWithDependencyCheck(() => import("../src/cli.js"));
if (cli) {
  process.exitCode = await cli.runCli(process.argv.slice(2));
}
