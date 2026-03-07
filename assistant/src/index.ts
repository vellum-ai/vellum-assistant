#!/usr/bin/env bun

import { buildCliProgram } from "./cli/program.js";
import { resolveInstanceDataDir } from "./util/platform.js";

// Auto-resolve BASE_DATA_DIR from the lockfile when running as a standalone CLI.
// The daemon always has BASE_DATA_DIR set by the launcher (cli/src/lib/local.ts),
// but the CLI process doesn't — so credential commands and other path-dependent
// operations would read from ~/.vellum instead of the instance-scoped directory.
if (!process.env.BASE_DATA_DIR) {
  const instanceDir = resolveInstanceDataDir();
  if (instanceDir) {
    process.env.BASE_DATA_DIR = instanceDir;
  }
}

buildCliProgram().parse();
