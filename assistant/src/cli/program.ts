import { existsSync } from "node:fs";

import { Command } from "commander";

import { initFeatureFlagOverrides } from "../config/assistant-feature-flags.js";
import { getConfigReadOnly } from "../config/loader.js";
import { isEmailEnabled } from "../email/feature-gate.js";
import { registerHooksCommand } from "../hooks/cli.js";
import { getWorkspaceDir } from "../util/platform.js";
import { APP_VERSION } from "../version.js";
import { registerAuditCommand } from "./commands/audit.js";
import { registerAuthCommand } from "./commands/auth.js";
import { registerAutonomyCommand } from "./commands/autonomy.js";
import { registerAvatarCommand } from "./commands/avatar.js";
import { registerBackupCommand } from "./commands/backup.js";
import { registerBashCommand } from "./commands/bash.js";
import { registerBrowserCommand } from "./commands/browser.js";
import { registerCacheCommand } from "./commands/cache.js";
import { registerChannelVerificationSessionsCommand } from "./commands/channel-verification-sessions.js";
import { registerCompletionsCommand } from "./commands/completions.js";
import { registerConfigCommand } from "./commands/config.js";
import { registerContactsCommand } from "./commands/contacts.js";
import { registerConversationsCommand } from "./commands/conversations.js";
import { registerCredentialExecutionCommand } from "./commands/credential-execution.js";
import { registerCredentialsCommand } from "./commands/credentials.js";
import { registerDefaultAction } from "./commands/default-action.js";
import { registerDomainCommand } from "./commands/domain.js";
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
import { log } from "./logger.js";

/**
 * Build the CLI program tree. Pre-populates the feature flag cache from
 * the gateway so flag-gated commands are registered correctly.
 */
export async function buildCliProgram(): Promise<Command> {
  await initFeatureFlagOverrides();
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
  $ assistant keys list          List stored API keys`,
  );

  registerDefaultAction(program);
  registerBackupCommand(program);
  registerBashCommand(program);
  registerBrowserCommand(program);
  registerCacheCommand(program);
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
  registerHooksCommand(program);
  registerMcpCommand(program);
  if (isEmailEnabled(getConfigReadOnly())) {
    registerDomainCommand(program);
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
  registerUsageCommand(program);

  registerShotgunCommand(program);
  registerSequenceCommand(program);

  // Fail fast when no assistant workspace exists on disk. The workspace is
  // created by `vellum hatch` and must be present for any command to work.
  // Commander handles --help and --version before preAction fires, so those
  // remain available even without a workspace.
  // Workspace-independent commands are exempt:
  //   completions — pure shell-script generation, no workspace files needed
  const workspaceExemptCommands = new Set(["completions"]);
  program.hook("preAction", (_thisCommand, actionCommand) => {
    if (workspaceExemptCommands.has(actionCommand.name())) {
      return;
    }
    const workspaceDir = getWorkspaceDir();
    if (!existsSync(workspaceDir)) {
      log.error(
        `No assistant workspace found at ${workspaceDir}.\nRun 'vellum hatch' to create an assistant first.`,
      );
      process.exit(1);
    }
  });

  return program;
}
