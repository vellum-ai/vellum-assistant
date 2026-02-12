#!/usr/bin/env bun
import '../instrument.js';
import * as Sentry from '@sentry/node';
import { runDaemon } from './lifecycle.js';

runDaemon().catch((err) => {
  Sentry.captureException(err);
  console.error('Failed to start daemon:', err);
  console.error('Troubleshooting: check if another daemon is already running, verify ~/.vellum/ permissions, and review logs at ~/.vellum/data/logs/');
  process.exit(1);
});
