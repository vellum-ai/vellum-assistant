#!/usr/bin/env bun
process.title = "vellum-daemon";

import * as Sentry from "@sentry/node";

import { getLogger } from "../util/logger.js";
import { runDaemon } from "./lifecycle.js";

runDaemon().catch(async (err) => {
  Sentry.captureException(err);
  await Sentry.flush(2000);
  // Try structured log first; fall back to console.error because
  // startDaemon() captures the child process's stderr to surface error
  // details to the parent process.
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
