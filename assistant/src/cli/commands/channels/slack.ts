/**
 * `assistant channels slack` — Slack-specific repair commands.
 *
 * Wraps the existing slack-channel-config handlers
 * (`getSlackChannelConfig` / `setSlackChannelConfig` /
 * `clearSlackChannelConfig`) which already live behind the
 * `integrations_slack_channel_config_*` IPC operationIds.
 *
 * Token semantics:
 *   bot_token (xoxb-…) — required for posting and most reads
 *   app_token (xapp-…) — required for Socket Mode connect events
 *   user_token (xoxp-…) — optional; expands read scope to channels
 *                          the user belongs to but the bot does not
 */

import type { Command } from "commander";

import { cliIpcCall, exitFromIpcResult } from "../../../ipc/cli-client.js";
import { log } from "../../logger.js";
import { shouldOutputJson, writeOutput } from "../../output.js";

interface SlackConfigResult {
  success: boolean;
  hasBotToken: boolean;
  hasAppToken: boolean;
  hasUserToken: boolean;
  connected: boolean;
  teamId?: string;
  teamName?: string;
  teamUrl?: string;
  botUserId?: string;
  botUsername?: string;
  error?: string;
  warning?: string;
}

function renderSlackConfig(result: SlackConfigResult): void {
  const tokenLine = (label: string, has: boolean) =>
    `  ${has ? "✓" : "✗"} ${label}`;
  log.info(`Slack: ${result.connected ? "connected" : "not connected"}`);
  if (result.teamName) {
    log.info(
      `  Workspace: ${result.teamName}${result.teamId ? ` (${result.teamId})` : ""}`,
    );
  }
  if (result.botUsername) {
    log.info(
      `  Bot:       ${result.botUsername}${result.botUserId ? ` (${result.botUserId})` : ""}`,
    );
  }
  log.info("");
  log.info("Tokens stored:");
  log.info(tokenLine("bot_token (xoxb-…)", result.hasBotToken));
  log.info(tokenLine("app_token (xapp-…)", result.hasAppToken));
  log.info(tokenLine("user_token (xoxp-…)", result.hasUserToken));
  if (result.warning) {
    log.info("");
    log.info(`⚠️  ${result.warning}`);
  }
}

export function registerChannelsSlackCommand(parent: Command): void {
  const slack = parent
    .command("slack")
    .description("Slack-specific status and repair commands");

  slack.addHelpText(
    "after",
    `
Slack tokens live in the credential vault under \`slack_channel:{bot_token,
app_token,user_token}\`. Repairing a busted Slack connection usually means
either re-pasting fresh tokens (\`reconnect\`) or clearing stored state and
starting over (\`clear\`).

Each call to \`reconnect\` re-validates against Slack's \`auth.test\` and
caches the resolved workspace + bot identity into config.

Examples:
  $ assistant channels slack status
  $ assistant channels slack reconnect --bot-token xoxb-… --app-token xapp-…
  $ assistant channels slack reconnect --bot-token xoxb-… --app-token xapp-… --user-token xoxp-…
  $ assistant channels slack clear`,
  );

  // ---------------------------------------------------------------------------
  // status
  // ---------------------------------------------------------------------------

  slack
    .command("status")
    .description("Show stored Slack tokens and last-known workspace identity")
    .option("--json", "Machine-readable compact JSON output")
    .action(async (opts: { json?: boolean }, cmd: Command) => {
      const r = await cliIpcCall<SlackConfigResult>(
        "integrations_slack_channel_config_get",
        {},
      );
      if (!r.ok) {
        return exitFromIpcResult(
          { ok: false, error: r.error, statusCode: r.statusCode },
          cmd,
        );
      }
      const result = r.result!;
      if (shouldOutputJson(cmd)) {
        writeOutput(cmd, result);
      } else {
        renderSlackConfig(result);
      }
    });

  // ---------------------------------------------------------------------------
  // reconnect
  // ---------------------------------------------------------------------------

  slack
    .command("reconnect")
    .description(
      "Validate and store fresh Slack tokens (re-runs auth.test against Slack)",
    )
    .option("--bot-token <token>", "Slack bot token (xoxb-…)")
    .option("--app-token <token>", "Slack app-level token (xapp-…)")
    .option(
      "--user-token <token>",
      "Optional Slack user token (xoxp-…) for expanded read scope",
    )
    .option("--json", "Machine-readable compact JSON output")
    .action(
      async (
        opts: {
          json?: boolean;
          botToken?: string;
          appToken?: string;
          userToken?: string;
        },
        cmd: Command,
      ) => {
        if (!opts.botToken && !opts.appToken && !opts.userToken) {
          log.error(
            "Pass at least one of --bot-token, --app-token, --user-token. To wipe all tokens, use `assistant channels slack clear`.",
          );
          process.exitCode = 1;
          return;
        }
        const body: Record<string, string> = {};
        if (opts.botToken) body.botToken = opts.botToken;
        if (opts.appToken) body.appToken = opts.appToken;
        if (opts.userToken) body.userToken = opts.userToken;

        const r = await cliIpcCall<SlackConfigResult>(
          "integrations_slack_channel_config_post",
          { body },
        );
        if (!r.ok) {
          return exitFromIpcResult(
            { ok: false, error: r.error, statusCode: r.statusCode },
            cmd,
          );
        }
        const result = r.result!;
        if (shouldOutputJson(cmd)) {
          writeOutput(cmd, result);
        } else {
          if (result.success) {
            log.info("✅ Slack tokens stored and validated");
            log.info("");
          }
          renderSlackConfig(result);
        }
      },
    );

  // ---------------------------------------------------------------------------
  // clear
  // ---------------------------------------------------------------------------

  slack
    .command("clear")
    .description("Remove all stored Slack tokens and reset workspace metadata")
    .option("--json", "Machine-readable compact JSON output")
    .action(async (opts: { json?: boolean }, cmd: Command) => {
      const r = await cliIpcCall<SlackConfigResult>(
        "integrations_slack_channel_config_delete",
        {},
      );
      if (!r.ok) {
        return exitFromIpcResult(
          { ok: false, error: r.error, statusCode: r.statusCode },
          cmd,
        );
      }
      const result = r.result!;
      if (shouldOutputJson(cmd)) {
        writeOutput(cmd, result);
      } else {
        log.info("✅ Slack tokens cleared");
        log.info("");
        renderSlackConfig(result);
      }
    });
}
