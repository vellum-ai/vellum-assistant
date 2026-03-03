#!/usr/bin/env bun
process.title = 'vellum-daemon';
import * as Sentry from '@sentry/node';

import { getLogger } from '../util/logger.js';
import { guardDaemonStartup } from './daemon-control.js';
import { runDaemon } from './lifecycle.js';

// Lifecycle guard: exit early if another daemon is already running in this
// workspace.  Also cleans up stale PID/socket files so the new instance can
// bind cleanly.  Running the guard here (rather than only in the `daemon
// start` parent process) means every entry point — normal start, --watch,
// dev — is protected against split-brain daemon state.
await guardDaemonStartup();

runDaemon().catch(async (err) => {
  Sentry.captureException(err);
  await Sentry.flush(2000);
  // Try structured log first; fall back to console.error because
  // startDaemon() captures the child process's stderr to surface error
  // details to the parent process.
  try {
    const log = getLogger('daemon-main');
    log.fatal({ err }, 'Failed to start daemon');
  } catch {
    // Logger may not be initialized yet
  }
  console.error('Failed to start daemon:', err);
  console.error('Troubleshooting: check if another daemon is already running, verify ~/.vellum/ permissions, and review logs at ~/.vellum/workspace/data/logs/');
  process.exit(1);
});
