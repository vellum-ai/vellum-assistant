import { createRequire } from "node:module";

import { Command } from "commander";

import { registerHooksCommand } from "../hooks/cli.js";
import { registerAuditCommand } from "./commands/audit.js";
import { registerAutonomyCommand } from "./commands/autonomy.js";
import { registerBrowserRelayCommand } from "./commands/browser-relay.js";
import { registerChannelVerificationSessionsCommand } from "./commands/channel-verification-sessions.js";
import { registerCompletionsCommand } from "./commands/completions.js";
import { registerConfigCommand } from "./commands/config.js";
import { registerContactsCommand } from "./commands/contacts.js";
import { registerCredentialsCommand } from "./commands/credentials.js";
import { registerDefaultAction } from "./commands/default-action.js";
import { registerDevCommand } from "./commands/dev.js";
import { registerDoctorCommand } from "./commands/doctor.js";
import { registerEmailCommand } from "./commands/email.js";
import { registerKeysCommand } from "./commands/keys.js";
import { registerMapCommand } from "./commands/map.js";
import { registerMcpCommand } from "./commands/mcp.js";
import { registerMemoryCommand } from "./commands/memory.js";
import { registerNotificationsCommand } from "./commands/notifications.js";
import { registerOAuthCommand } from "./commands/oauth.js";
import { registerPlatformCommand } from "./commands/platform.js";
import { registerSequenceCommand } from "./commands/sequence.js";
import { registerSessionsCommand } from "./commands/sessions.js";
import { registerSkillsCommand } from "./commands/skills.js";
import { registerTrustCommand } from "./commands/trust.js";
import { registerTwitterCommand } from "./commands/twitter/index.js";

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
  registerContactsCommand(program);
  registerChannelVerificationSessionsCommand(program);
  registerAutonomyCommand(program);
  registerCompletionsCommand(program);
  registerNotificationsCommand(program);
  registerPlatformCommand(program);
  registerOAuthCommand(program);
  registerSkillsCommand(program);
  registerBrowserRelayCommand(program);

  registerTwitterCommand(program);
  registerMapCommand(program);
  registerSequenceCommand(program);

  return program;
}
