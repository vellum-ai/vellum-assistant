import type { Command } from "commander";

import { cliIpcCall, exitFromIpcResult } from "../../../../ipc/cli-client.js";
import { getCliLogger } from "../../../logger.js";
import { shouldOutputJson, writeOutput } from "../../../output.js";

const log = getCliLogger("use:slack:users");

interface UserEntry {
  id: string;
  displayName: string;
  email: string;
}

export function registerUsersCommand(slack: Command): void {
  const users = slack.command("users").description("Look up Slack users");

  users.addHelpText(
    "after",
    `
Resolve Slack users by email address or display name.

Examples:
  $ assistant use slack users get user@example.com
  $ assistant use slack users get "Jane Smith"`,
  );

  users
    .command("get <query>")
    .description("Resolve a Slack user by email or display name")
    .addHelpText(
      "after",
      `
Arguments:
  query   Email address or display name to search for

Resolves a user from the local Slack user cache. The query is matched
against email addresses and display names.

Examples:
  $ assistant use slack users get user@example.com
  Name:  Jane Smith
  ID:    U01234567
  Email: user@example.com

  $ assistant use slack users get "Jane Smith" --json
  {"id":"U01234567","displayName":"Jane Smith","email":"user@example.com"}`,
    )
    .action(
      async (query: string, _opts: Record<string, unknown>, cmd: Command) => {
        const r = await cliIpcCall<UserEntry>("slack_use_users_get", {
          pathParams: { query },
        });
        if (!r.ok) return exitFromIpcResult(r, cmd);

        if (shouldOutputJson(cmd)) {
          writeOutput(cmd, r.result);
        } else {
          const user = r.result!;
          log.info(`Name:  ${user.displayName}`);
          log.info(`ID:    ${user.id}`);
          log.info(`Email: ${user.email}`);
        }
      },
    );
}
