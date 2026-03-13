import {
  listContacts,
  searchContacts,
} from "../../../../messaging/providers/gmail/people-client.js";
import type { Person } from "../../../../messaging/providers/gmail/people-types.js";
import { resolveOAuthConnection } from "../../../../oauth/connection-resolver.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

function ok(text: string): ToolExecutionResult {
  return { content: text, isError: false };
}

function err(text: string): ToolExecutionResult {
  return { content: text, isError: true };
}

function formatContact(person: Person): Record<string, unknown> {
  const name = person.names?.[0];
  const email = person.emailAddresses?.[0];
  const phone = person.phoneNumbers?.[0];
  const org = person.organizations?.[0];

  return {
    name: name?.displayName ?? "Unknown",
    email: email?.value ?? null,
    phone: phone?.value ?? null,
    organization: org?.name ?? null,
    title: org?.title ?? null,
  };
}

export async function run(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const action = input.action as string;

  if (!action) {
    return err("action is required (list or search).");
  }

  try {
    const connection = await resolveOAuthConnection("integration:google");
    switch (action) {
      case "list": {
        const pageSize = (input.page_size as number) ?? 50;
        const pageToken = input.page_token as string | undefined;

        const resp = await listContacts(connection, pageSize, pageToken);
        const contacts = (resp.connections ?? []).map(formatContact);

        const result: Record<string, unknown> = {
          contacts,
          total: resp.totalPeople ?? contacts.length,
        };
        if (resp.nextPageToken) result.nextPageToken = resp.nextPageToken;

        return ok(JSON.stringify(result, null, 2));
      }

      case "search": {
        const query = input.query as string;
        if (!query) return err("query is required for search action.");

        const resp = await searchContacts(connection, query);
        const contacts = (resp.results ?? []).map((r) =>
          formatContact(r.person),
        );

        return ok(
          JSON.stringify({ contacts, total: contacts.length }, null, 2),
        );
      }

      default:
        return err(`Unknown action "${action}". Use list or search.`);
    }
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
