#!/usr/bin/env node
import { loadWithDependencyCheck } from "../src/missing-dependencies.js";

const cli = await loadWithDependencyCheck(() => import("../src/gemini-cli.js"));
if (cli) {
  const write = (stream, text) => new Promise((resolve, reject) => stream.write(text, error => error ? reject(error) : resolve()));
  process.stdout.on("error", () => {});
  process.stderr.on("error", () => {});
  process.exitCode = await cli.runGeminiCli(process.argv.slice(2), {
    out: text => write(process.stdout, text),
    err: text => write(process.stderr, text)
  });
}
