#!/usr/bin/env bun

import { Command } from 'commander';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };

import {
  registerDefaultAction,
  registerDaemonCommand,
  registerDevCommand,
  registerSessionsCommand,
  registerAuditCommand,
  registerDoctorCommand,
  registerCompletionsCommand,
} from './cli/core-commands.js';
import {
  registerConfigCommand,
  registerKeysCommand,
  registerTrustCommand,
  registerMemoryCommand,
} from './cli/config-commands.js';
import { registerHooksCommand } from './hooks/cli.js';
import { registerEmailCommand } from './cli/email.js';
import { registerContactsCommand } from './cli/contacts.js';
import { registerAutonomyCommand } from './cli/autonomy.js';
import { registerDoordashCommand } from './cli/doordash.js';
import { registerTwitterCommand } from './cli/twitter.js';
import { registerMapCommand } from './cli/map.js';

const program = new Command();

program
  .name('vellum')
  .description('Local AI assistant')
  .version(version);

registerDefaultAction(program);
registerDaemonCommand(program);
registerDevCommand(program);
registerSessionsCommand(program);
registerConfigCommand(program);
registerKeysCommand(program);
registerTrustCommand(program);
registerMemoryCommand(program);
registerAuditCommand(program);
registerDoctorCommand(program);
registerHooksCommand(program);
registerEmailCommand(program);
registerContactsCommand(program);
registerAutonomyCommand(program);
registerDoordashCommand(program);
registerCompletionsCommand(program);

registerTwitterCommand(program);
registerMapCommand(program);

program.parse();
