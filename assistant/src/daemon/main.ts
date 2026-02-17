#!/usr/bin/env bun

// Bun does not ignore SIGPIPE by default (unlike Node.js). The parent CLI
// process pipes our stderr during startup for crash diagnostics, then destroys
// the read end once the IPC socket appears. Any later stderr write (Sentry,
// console.warn, debug hooks) would deliver SIGPIPE and silently kill the
// daemon. Ignoring the signal matches Node.js behaviour and lets the process
// survive a broken pipe on fd 2.
process.on('SIGPIPE', () => {});

import '../instrument.js';
import * as Sentry from '@sentry/node';
import { runDaemon } from './lifecycle.js';

runDaemon().catch(async (err) => {
  Sentry.captureException(err);
  await Sentry.flush(2000);
  console.error('Failed to start daemon:', err);
  console.error('Troubleshooting: check if another daemon is already running, verify ~/.vellum/ permissions, and review logs at ~/.vellum/workspace/data/logs/');
  process.exit(1);
});
