import type { Command } from "commander";

import {
  gatewayGet,
  gatewayPost,
  runRead,
  toQueryString,
} from "./integrations.js";

type IngressChannel = "telegram" | "voice" | "sms";

export function registerContactsCommand(program: Command): void {
  const contacts = program
    .command("contacts")
    .description("Manage and query the contact graph")
    .option("--json", "Machine-readable compact JSON output");

  contacts
    .command("list")
    .description("List contacts (calls /v1/contacts)")
    .option("--role <role>", "Filter by role (default: contact)", "contact")
    .option("--limit <limit>", "Maximum number of contacts to return")
    .option("--query <query>", "Search query to filter contacts")
    .action(
      async (
        opts: {
          role?: string;
          limit?: string;
          query?: string;
        },
        cmd: Command,
      ) => {
        const query = toQueryString({
          role: opts.role,
          limit: opts.limit,
          query: opts.query,
        });
        await runRead(cmd, async () => gatewayGet(`/v1/contacts${query}`));
      },
    );

  contacts
    .command("get <id>")
    .description("Get a contact by ID")
    .action(async (id: string, _opts: unknown, cmd: Command) => {
      await runRead(cmd, async () =>
        gatewayGet(`/v1/contacts/${encodeURIComponent(id)}`),
      );
    });

  contacts
    .command("merge <keepId> <mergeId>")
    .description("Merge two contacts")
    .action(
      async (keepId: string, mergeId: string, _opts: unknown, cmd: Command) => {
        await runRead(cmd, async () =>
          gatewayPost("/v1/contacts/merge", { keepId, mergeId }),
        );
      },
    );

  contacts
    .command("invites")
    .description("List contact invites")
    .option("--source-channel <sourceChannel>", "Filter by source channel")
    .option("--status <status>", "Filter by invite status")
    .action(
      async (
        opts: { sourceChannel?: IngressChannel; status?: string },
        cmd: Command,
      ) => {
        const query = toQueryString({
          sourceChannel: opts.sourceChannel,
          status: opts.status,
        });
        await runRead(cmd, async () =>
          gatewayGet(`/v1/contacts/invites${query}`),
        );
      },
    );
}
