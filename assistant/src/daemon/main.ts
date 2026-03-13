#!/usr/bin/env bun

import * as Sentry from "@sentry/node";

import { buildCliProgram } from "../cli/program.js";
import { getLogger } from "../util/logger.js";
import { resolveInstanceDataDir } from "../util/platform.js";
import { runDaemon } from "./lifecycle.js";

// When invoked with CLI arguments (e.g. `vellum-daemon config get ...` or
// `vellum-daemon --help`), dispatch to the CLI program so that compiled
// binaries behave identically to the bun-installed `assistant` command.
// With no arguments, start the daemon as before.
const args = process.argv.slice(2);
if (args.length > 0) {
  if (!process.env.BASE_DATA_DIR) {
    const instanceDir = resolveInstanceDataDir();
    if (instanceDir) {
      process.env.BASE_DATA_DIR = instanceDir;
    }
  }

  buildCliProgram().parse();
} else {
  process.title = "vellum-daemon";

  runDaemon().catch(async (err) => {
    Sentry.captureException(err);
    await Sentry.flush(2000);
    try {
      const log = getLogger("daemon-main");
      log.fatal({ err }, "Failed to start daemon");
    } catch {
      // Logger may not be initialized yet
    }
    console.error("Failed to start assistant:", err);
    console.error(
      "Troubleshooting: check if another assistant is already running, verify ~/.vellum/ permissions, and review logs at ~/.vellum/workspace/data/logs/",
    );
    process.exit(1);
  });
}
