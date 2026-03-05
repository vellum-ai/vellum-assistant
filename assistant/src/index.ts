#!/usr/bin/env bun

import { createRequire } from "node:module";

import { Command } from "commander";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

import { registerAmazonCommand } from "./cli/amazon.js";
import { registerAutonomyCommand } from "./cli/autonomy.js";
import {
  registerConfigCommand,
  registerKeysCommand,
  registerMemoryCommand,
  registerTrustCommand,
} from "./cli/config-commands.js";
import {
  registerAuditCommand,
  registerCompletionsCommand,
  registerDefaultAction,
  registerDevCommand,
  registerDoctorCommand,
  registerSessionsCommand,
} from "./cli/core-commands.js";
import { registerEmailCommand } from "./cli/email.js";
import { registerInfluencerCommand } from "./cli/influencer.js";
import { registerContactsCommand } from "./cli/contacts.js";
import { registerIntegrationsCommand } from "./cli/integrations.js";
import { registerMapCommand } from "./cli/map.js";
import { registerMcpCommand } from "./cli/mcp.js";
import { registerSequenceCommand } from "./cli/sequence.js";
import { registerTwitterCommand } from "./cli/twitter.js";
import { registerHooksCommand } from "./hooks/cli.js";

const program = new Command();

program.name("vellum").description("Local AI assistant").version(version);

registerDefaultAction(program);
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
registerIntegrationsCommand(program);
registerContactsCommand(program);
registerAmazonCommand(program);
registerAutonomyCommand(program);
registerCompletionsCommand(program);

registerTwitterCommand(program);
registerMapCommand(program);
registerInfluencerCommand(program);
registerSequenceCommand(program);

program.parse();
