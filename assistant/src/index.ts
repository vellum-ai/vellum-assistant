#!/usr/bin/env bun

import { createRequire } from "node:module";

import { Command } from "commander";

import { registerAmazonCommand } from "./cli/amazon.js";
import { registerAuditCommand } from "./cli/audit.js";
import { registerAutonomyCommand } from "./cli/autonomy.js";
import { registerCompletionsCommand } from "./cli/completions.js";
import { registerConfigCommand } from "./cli/config.js";
import { registerContactsCommand } from "./cli/contacts.js";
import { registerDefaultAction } from "./cli/default-action.js";
import { registerDevCommand } from "./cli/dev.js";
import { registerDoctorCommand } from "./cli/doctor.js";
import { registerEmailCommand } from "./cli/email.js";
import { registerInfluencerCommand } from "./cli/influencer.js";
import {
  registerChannelsCommand,
  registerIntegrationsCommand,
} from "./cli/integrations.js";
import { registerKeysCommand } from "./cli/keys.js";
import { registerMapCommand } from "./cli/map.js";
import { registerMcpCommand } from "./cli/mcp.js";
import { registerMemoryCommand } from "./cli/memory.js";
import { registerSequenceCommand } from "./cli/sequence.js";
import { registerSessionsCommand } from "./cli/sessions.js";
import { registerTrustCommand } from "./cli/trust.js";
import { registerTwitterCommand } from "./cli/twitter.js";
import { registerHooksCommand } from "./hooks/cli.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

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
registerChannelsCommand(program);
registerAmazonCommand(program);
registerAutonomyCommand(program);
registerCompletionsCommand(program);

registerTwitterCommand(program);
registerMapCommand(program);
registerInfluencerCommand(program);
registerSequenceCommand(program);

program.parse();
