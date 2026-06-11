import { existsSync } from "node:fs";

import { Command } from "commander";

import { initFeatureFlagOverrides } from "../config/assistant-feature-flags.js";
import { getConfigReadOnly } from "../config/loader.js";
import { isExternalPluginsEnabled } from "../plugins/feature-gate.js";
import { getWorkspaceDir } from "../util/platform.js";
import { APP_VERSION } from "../version.js";
import { registerAttachmentCommand } from "./commands/attachment.js";
import { registerAuditCommand } from "./commands/audit.js";
import { registerAuthCommand } from "./commands/auth.js";
import { registerAvatarCommand } from "./commands/avatar.js";
import { registerBackupCommand } from "./commands/backup.js";
import { registerBashCommand } from "./commands/bash.js";
import { registerBrowserCommand } from "./commands/browser.js";
import { registerCacheCommand } from "./commands/cache.js";
import { registerChangelogCommand } from "./commands/changelog.js";
import { registerChannelVerificationSessionsCommand } from "./commands/channel-verification-sessions.js";
import { registerChannelsCommand } from "./commands/channels/index.js";
import { registerClientsCommand } from "./commands/clients.js";
import { registerCompletionsCommand } from "./commands/completions.js";
import { registerConfigCommand } from "./commands/config.js";
import { registerContactsCommand } from "./commands/contacts.js";
import { registerConversationsCommand } from "./commands/conversations.js";
import { registerCredentialExecutionCommand } from "./commands/credential-execution.js";
import { registerCredentialsCommand } from "./commands/credentials.js";
import { registerDbCommand } from "./commands/db/index.js";
import { registerDefaultAction } from "./commands/default-action.js";
import { registerDomainCommand } from "./commands/domain.js";
import { registerEmailCommand } from "./commands/email.js";
import { registerGatewayCommand } from "./commands/gateway.js";
import { registerImageGenerationCommand } from "./commands/image-generation.js";
import { registerInferenceCommand } from "./commands/inference.js";
import { registerKeysCommand } from "./commands/keys.js";
import { registerMcpCommand } from "./commands/mcp.js";
import { registerMemoryV2Command } from "./commands/memory-v2.js";
import { registerMemoryV3Command } from "./commands/memory-v3.js";
import { registerNotificationsCommand } from "./commands/notifications.js";
import { registerOAuthCommand } from "./commands/oauth/index.js";
import { registerPendingCommand } from "./commands/pending.js";
import { registerPlatformCommand } from "./commands/platform/index.js";
import { registerPluginsCommand } from "./commands/plugins.js";
import { registerRoutesCommand } from "./commands/routes.js";
import { registerSchedulesCommand } from "./commands/schedules.js";
import { registerSequenceCommand } from "./commands/sequence.js";
import { registerSkillsCommand } from "./commands/skills.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerSttCommand } from "./commands/stt.js";
import { registerTaskCommand } from "./commands/task.js";
import { registerTelemetryCommand } from "./commands/telemetry.js";
import { registerToolsCommand } from "./commands/tools.js";
import { registerTrustCommand } from "./commands/trust.js";
import { registerTtsCommand } from "./commands/tts.js";
import { registerUiCommand } from "./commands/ui.js";
import { registerUsageCommand } from "./commands/usage.js";
import { registerWatchersCommand } from "./commands/watchers.js";
import { registerWebhooksCommand } from "./commands/webhooks.js";
import { red } from "./lib/cli-colors.js";
import { log } from "./logger.js";

/**
 * Build the CLI program tree. Pre-populates the feature flag cache from
 * the gateway so flag-gated commands are registered correctly.
 */
export async function buildCliProgram(): Promise<Command> {
  await initFeatureFlagOverrides({ retryBackoffsMs: [], callTimeoutMs: 200 });
  return buildCliProgramTree();
}

/**
 * Synchronously build the CLI program tree without pre-populating the
 * feature-flag cache. Use this from inside the daemon, where flags are
 * already initialized — calling `buildCliProgram` from there would round-trip
 * to the gateway unnecessarily.
 *
 * Same shape as `buildCliProgram` minus the async feature-flag init: registers
 * the full subcommand set (conditionally gated on email / external-plugins
 * flags via `getConfigReadOnly()`) and installs the workspace-preAction hook.
 */
export function buildCliProgramTree(): Command {
  const program = new Command();

  program
    .name("assistant")
    .description("Local AI assistant")
    .version(APP_VERSION)
    .allowExcessArguments(true);

  // Color Commander-emitted error output red (unknown options, missing args,
  // cmd.error() calls). Plain success output and --help text are untouched.
  // The `red` helper is a no-op when stderr isn't a TTY or NO_COLOR is set.
  program.configureOutput({
    outputError: (str, write) => write(red(str)),
  });

  program.addHelpText(
    "after",
    `
Examples:
  $ assistant auth info          Show platform identity and auth status
  $ assistant config list        List all configuration values
  $ assistant keys list          List stored API keys`,
  );

  registerDefaultAction(program);

  registerAttachmentCommand(program);
  registerAuditCommand(program);
  registerAuthCommand(program);
  registerAvatarCommand(program);
  registerBackupCommand(program);
  registerBashCommand(program);
  registerBrowserCommand(program);
  registerCacheCommand(program);
  registerChangelogCommand(program);
  registerChannelVerificationSessionsCommand(program);
  registerChannelsCommand(program);
  registerClientsCommand(program);
  registerCompletionsCommand(program);
  registerConfigCommand(program);
  registerContactsCommand(program);
  registerConversationsCommand(program);
  registerCredentialExecutionCommand(program);
  registerCredentialsCommand(program);
  registerDbCommand(program);
  registerDomainCommand(program);
  registerEmailCommand(program);
  registerGatewayCommand(program);
  registerImageGenerationCommand(program);
  registerInferenceCommand(program);
  registerKeysCommand(program);
  registerMcpCommand(program);
  registerMemoryV2Command(program);
  registerMemoryV3Command(program);
  registerNotificationsCommand(program);
  registerOAuthCommand(program);
  registerPendingCommand(program);
  registerPlatformCommand(program);
  if (isExternalPluginsEnabled(getConfigReadOnly())) {
    registerPluginsCommand(program);
  }
  registerRoutesCommand(program);
  registerSchedulesCommand(program);
  registerSequenceCommand(program);
  registerStatusCommand(program);
  registerSkillsCommand(program);
  registerSttCommand(program);
  registerTaskCommand(program);
  registerTelemetryCommand(program);
  registerToolsCommand(program);
  registerTrustCommand(program);
  registerTtsCommand(program);
  registerUiCommand(program);
  registerUsageCommand(program);
  registerWatchersCommand(program);
  registerWebhooksCommand(program);

  // Fail fast when no assistant workspace exists on disk. The workspace is
  // created by `vellum hatch` and must be present for any command to work.
  // Commander handles --help and --version before preAction fires, so those
  // remain available even without a workspace.
  // Workspace-independent commands are exempt:
  //   completions — pure shell-script generation, no workspace files needed
  //   status     — diagnostic; should run even when the workspace is broken
  //   changelog  — pure read-only network surface backed by GitHub Releases;
  //                its on-disk cache is best-effort and tolerates a missing
  //                workspace dir (see changelog.ts:writeCache)
  const workspaceExemptCommands = new Set([
    "completions",
    "status",
    "changelog",
  ]);
  // An action command's `.name()` returns the leaf (e.g. "show" for
  // `changelog show <ver>`), so we walk up the parent chain to see whether
  // any ancestor — typically the top-level subcommand — is exempt.
  const isExemptFromWorkspaceCheck = (command: Command): boolean => {
    let current: Command | null | undefined = command;
    while (current && current !== program) {
      if (workspaceExemptCommands.has(current.name())) return true;
      current = current.parent;
    }
    return false;
  };
  program.hook("preAction", (_thisCommand, actionCommand) => {
    if (isExemptFromWorkspaceCheck(actionCommand)) {
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
