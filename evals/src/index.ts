#!/usr/bin/env bun

import pkg from "../package.json";
import { run } from "./commands/run";

const HELP = `
🚀 evals — Vellum Personal-Intelligence Benchmark harness

Usage:
  evals <command> [options]

Commands:
  run        Run profile × test combinations and emit a report card row

Options:
  --help, -h         Show help
  --version, -v      Show version
`.trim();

const command = process.argv[2];

if (!command || command === "--help" || command === "-h") {
  console.log(HELP);
  process.exit(0);
}

if (command === "--version" || command === "-v") {
  console.log(pkg.version);
  process.exit(0);
}

switch (command) {
  case "run":
    await run(process.argv.slice(3));
    break;
  default:
    console.error(`Unknown command: ${command}`);
    console.log(HELP);
    process.exit(1);
}
