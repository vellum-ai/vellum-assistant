import { Command } from "commander";

import { getConfig } from "../config/loader.js";
import { isEmailEnabled } from "../email/feature-gate.js";
import { registerHooksCommand } from "../hooks/cli.js";
import { APP_VERSION } from "../version.js";
import { registerAuditCommand } from "./commands/audit.js";
import { registerAuthCommand } from "./commands/auth.js";
import { registerAutonomyCommand } from "./commands/autonomy.js";
import { registerAvatarCommand } from "./commands/avatar.js";
import { registerBashCommand } from "./commands/bash.js";
import { registerBrowserRelayCommand } from "./commands/browser-relay.js";
import { registerChannelVerificationSessionsCommand } from "./commands/channel-verification-sessions.js";
import { registerCompletionsCommand } from "./commands/completions.js";
import { registerConfigCommand } from "./commands/config.js";
import { registerContactsCommand } from "./commands/contacts.js";
import { registerConversationsCommand } from "./commands/conversations.js";
import { registerCredentialExecutionCommand } from "./commands/credential-execution.js";
import { registerCredentialsCommand } from "./commands/credentials.js";
import { registerDefaultAction } from "./commands/default-action.js";
import { registerDoctorCommand } from "./commands/doctor.js";
import { registerEmailCommand } from "./commands/email.js";
import { registerKeysCommand } from "./commands/keys.js";
import { registerMcpCommand } from "./commands/mcp.js";
import { registerMemoryCommand } from "./commands/memory.js";
import { registerNotificationsCommand } from "./commands/notifications.js";
import { registerOAuthCommand } from "./commands/oauth/index.js";
import { registerPlatformCommand } from "./commands/platform/index.js";
import { registerRoutesCommand } from "./commands/routes.js";
import { registerSequenceCommand } from "./commands/sequence.js";
import { registerShotgunCommand } from "./commands/shotgun.js";
import { registerSkillsCommand } from "./commands/skills.js";
import { registerTrustCommand } from "./commands/trust.js";
import { registerUsageCommand } from "./commands/usage.js";

export function buildCliProgram(): Command {
  const program = new Command();

  program
    .name("assistant")
    .description("Local AI assistant")
    .version(APP_VERSION)
    .allowExcessArguments(true);

  program.addHelpText(
    "after",
    `
Examples:
  $ assistant auth info          Show platform identity and auth status
  $ assistant config list        List all configuration values
  $ assistant keys list          List stored API keys
  $ assistant doctor             Run diagnostic checks`,
  );

  registerDefaultAction(program);
  registerBashCommand(program);
  registerConversationsCommand(program);
  registerConfigCommand(program);
  registerKeysCommand(program);
  registerCredentialsCommand(program);
  registerCredentialExecutionCommand(program);
  registerTrustCommand(program);
  registerMemoryCommand(program);
  registerAuditCommand(program);
  registerAuthCommand(program);
  registerAvatarCommand(program);
  registerDoctorCommand(program);
  registerHooksCommand(program);
  registerMcpCommand(program);
  if (isEmailEnabled(getConfig())) {
    registerEmailCommand(program);
  }
  registerContactsCommand(program);
  registerChannelVerificationSessionsCommand(program);
  registerAutonomyCommand(program);
  registerCompletionsCommand(program);
  registerNotificationsCommand(program);
  registerPlatformCommand(program);
  registerOAuthCommand(program);
  registerRoutesCommand(program);
  registerSkillsCommand(program);
  registerBrowserRelayCommand(program);
  registerUsageCommand(program);

  registerShotgunCommand(program);
  registerSequenceCommand(program);

  return program;
}
