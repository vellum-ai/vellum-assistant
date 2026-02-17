#!/usr/bin/env bun
import '../instrument.js';
import * as Sentry from '@sentry/node';
import { runDaemon } from './lifecycle.js';

// Use console.error instead of the structured logger here because
// startDaemon() captures the child process's stderr to surface error
// details to the parent process. The structured logger writes to a file
// by default, so these messages would be lost from stderr.
runDaemon().catch(async (err) => {
  Sentry.captureException(err);
  await Sentry.flush(2000);
  console.error('Failed to start daemon:', err);
  console.error('Troubleshooting: check if another daemon is already running, verify ~/.vellum/ permissions, and review logs at ~/.vellum/workspace/data/logs/');
  process.exit(1);
});
