#!/usr/bin/env bun

import { createRequire } from 'node:module';

import { Command } from 'commander';

const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };

import { registerAmazonCommand } from './cli/amazon.js';
import {
  registerKeysCommand,
  registerMemoryCommand,
  registerTrustCommand,
} from './cli/config-commands.js';
import {
  registerAuditCommand,
  registerCompletionsCommand,
  registerDaemonCommand,
  registerDefaultAction,
  registerDevCommand,
  registerDoctorCommand,
  registerSessionsCommand,
} from './cli/core-commands.js';
import { registerDoordashCommand } from './cli/doordash.js';
import { registerEmailCommand } from './cli/email.js';
import { registerInfluencerCommand } from './cli/influencer.js';
import { registerMapCommand } from './cli/map.js';
import { registerSequenceCommand } from './cli/sequence.js';
import { registerTwitterCommand } from './cli/twitter.js';
import { registerHooksCommand } from './hooks/cli.js';

const program = new Command();

program
  .name('vellum')
  .description('Local AI assistant')
  .version(version);

registerDefaultAction(program);
registerDaemonCommand(program);
registerDevCommand(program);
registerSessionsCommand(program);
registerKeysCommand(program);
registerTrustCommand(program);
registerMemoryCommand(program);
registerAuditCommand(program);
registerDoctorCommand(program);
registerHooksCommand(program);
registerEmailCommand(program);
registerDoordashCommand(program);
registerAmazonCommand(program);
registerCompletionsCommand(program);

registerTwitterCommand(program);
registerMapCommand(program);
registerInfluencerCommand(program);
registerSequenceCommand(program);

program.parse();
