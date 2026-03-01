#!/usr/bin/env bun

import { createRequire } from 'node:module';

import { Command } from 'commander';

const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };

import { registerAmazonCommand } from './cli/amazon.js';
import {
  registerConfigCommand,
  registerKeysCommand,
  registerMemoryCommand,
  registerTrustCommand,
} from './cli/config-commands.js';
import {
  registerAuditCommand,
  registerDaemonCommand,
  registerDefaultAction,
  registerDevCommand,
  registerDoctorCommand,
  registerSessionsCommand,
} from './cli/core-commands.js';
import { registerEmailCommand } from './cli/email.js';
import { registerInfluencerCommand } from './cli/influencer.js';
import { registerMapCommand } from './cli/map.js';
import { registerMcpCommand } from './cli/mcp.js';
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
registerConfigCommand(program);
registerKeysCommand(program);
registerTrustCommand(program);
registerMemoryCommand(program);
registerAuditCommand(program);
registerDoctorCommand(program);
registerHooksCommand(program);
registerMcpCommand(program);
registerEmailCommand(program);
registerAmazonCommand(program);

registerTwitterCommand(program);
registerMapCommand(program);
registerInfluencerCommand(program);
registerSequenceCommand(program);

program.parse();
