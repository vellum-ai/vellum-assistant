#!/usr/bin/env bun
import '../instrument.js';
import * as Sentry from '@sentry/node';
import { runDaemon } from './lifecycle.js';
import { getLogger } from '../util/logger.js';

const log = getLogger('daemon');

runDaemon().catch(async (err) => {
  Sentry.captureException(err);
  await Sentry.flush(2000);
  log.error({ err }, 'Failed to start daemon');
  log.error('Troubleshooting: check if another daemon is already running, verify ~/.vellum/ permissions, and review logs at ~/.vellum/workspace/data/logs/');
  process.exit(1);
});
