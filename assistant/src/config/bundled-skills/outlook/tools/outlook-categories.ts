import {
  getMessage,
  listMasterCategories,
  updateMessageCategories,
} from "../../../../messaging/providers/outlook/client.js";
import { resolveOAuthConnection } from "../../../../oauth/connection-resolver.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { err, ok } from "./shared.js";

export async function run(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const account = input.account as string | undefined;
  const action = input.action as string;

  if (!action) {
    return err("action is required (add, remove, or list_available).");
  }

  try {
    const connection = await resolveOAuthConnection("outlook", {
      account,
    });

    switch (action) {
      case "add": {
        const messageId = input.message_id as string;
        if (!messageId) return err("message_id is required for add action.");

        const categories = input.categories as string[] | undefined;
        if (!categories || categories.length === 0) {
          return err("categories is required for add action.");
        }

        const message = await getMessage(connection, messageId, "categories");
        const existing = message.categories ?? [];
        const merged = [...new Set([...existing, ...categories])];
        await updateMessageCategories(connection, messageId, merged);
        return ok("Categories updated.");
      }

      case "remove": {
        const messageId = input.message_id as string;
        if (!messageId) return err("message_id is required for remove action.");

        const categories = input.categories as string[] | undefined;
        if (!categories || categories.length === 0) {
          return err("categories is required for remove action.");
        }

        const removeSet = new Set(categories);
        const message = await getMessage(connection, messageId, "categories");
        const existing = message.categories ?? [];
        const filtered = existing.filter((c) => !removeSet.has(c));
        await updateMessageCategories(connection, messageId, filtered);
        return ok("Categories updated.");
      }

      case "list_available": {
        const resp = await listMasterCategories(connection);
        const categories = resp.value ?? [];
        return ok(JSON.stringify(categories, null, 2));
      }

      default:
        return err(
          `Unknown action "${action}". Use add, remove, or list_available.`,
        );
    }
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
