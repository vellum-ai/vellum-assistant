import { createRequire } from "node:module";

import { Command } from "commander";

import { registerHooksCommand } from "../hooks/cli.js";
import { registerAmazonCommand } from "./amazon.js";
import { registerAuditCommand } from "./audit.js";
import { registerAutonomyCommand } from "./autonomy.js";
import { registerChannelVerificationSessionsCommand } from "./channel-verification-sessions.js";
import { registerChannelsCommand } from "./channels.js";
import { registerCompletionsCommand } from "./completions.js";
import { registerConfigCommand } from "./config.js";
import { registerContactsCommand } from "./contacts.js";
import { registerCredentialsCommand } from "./credentials.js";
import { registerDefaultAction } from "./default-action.js";
import { registerDevCommand } from "./dev.js";
import { registerDoctorCommand } from "./doctor.js";
import { registerEmailCommand } from "./email.js";
import { registerInfluencerCommand } from "./influencer.js";
import { registerIntegrationsCommand } from "./integrations.js";
import { registerKeysCommand } from "./keys.js";
import { registerMapCommand } from "./map.js";
import { registerMcpCommand } from "./mcp.js";
import { registerMemoryCommand } from "./memory.js";
import { registerNotificationsCommand } from "./notifications.js";
import { registerOAuthCommand } from "./oauth.js";
import { registerSequenceCommand } from "./sequence.js";
import { registerSessionsCommand } from "./sessions.js";
import { registerSkillsCommand } from "./skills.js";
import { registerTrustCommand } from "./trust.js";
import { registerTwitterCommand } from "./twitter.js";

const require = createRequire(import.meta.url);
const { version } = require("../../package.json") as { version: string };

export function buildCliProgram(): Command {
  const program = new Command();

  program.name("assistant").description("Local AI assistant").version(version);

  registerDefaultAction(program);
  registerDevCommand(program);
  registerSessionsCommand(program);
  registerConfigCommand(program);
  registerKeysCommand(program);
  registerCredentialsCommand(program);
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
  registerChannelVerificationSessionsCommand(program);
  registerAmazonCommand(program);
  registerAutonomyCommand(program);
  registerCompletionsCommand(program);
  registerNotificationsCommand(program);
  registerOAuthCommand(program);
  registerSkillsCommand(program);

  registerTwitterCommand(program);
  registerMapCommand(program);
  registerInfluencerCommand(program);
  registerSequenceCommand(program);

  return program;
}
