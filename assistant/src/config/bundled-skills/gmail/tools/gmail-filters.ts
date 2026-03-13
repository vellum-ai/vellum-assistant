import {
  createFilter,
  deleteFilter,
  listFilters,
} from "../../../../messaging/providers/gmail/client.js";
import type {
  GmailFilterAction,
  GmailFilterCriteria,
} from "../../../../messaging/providers/gmail/types.js";
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
    return err("action is required (list, create, or delete).");
  }

  try {
    const connection = resolveOAuthConnection("integration:gmail", account);
    switch (action) {
      case "list": {
        const filters = await listFilters(connection);
        if (filters.length === 0) {
          return ok("No filters configured.");
        }
        return ok(JSON.stringify(filters, null, 2));
      }

      case "create": {
        const criteria: GmailFilterCriteria = {};
        if (input.from) criteria.from = input.from as string;
        if (input.to) criteria.to = input.to as string;
        if (input.subject) criteria.subject = input.subject as string;
        if (input.query) criteria.query = input.query as string;
        if (input.has_attachment !== undefined)
          criteria.hasAttachment = input.has_attachment as boolean;

        const filterAction: GmailFilterAction = {};
        if (input.add_label_ids)
          filterAction.addLabelIds = input.add_label_ids as string[];
        if (input.remove_label_ids)
          filterAction.removeLabelIds = input.remove_label_ids as string[];
        if (input.forward) filterAction.forward = input.forward as string;

        if (Object.keys(criteria).length === 0) {
          return err(
            "At least one filter criteria is required (from, to, subject, query, or has_attachment).",
          );
        }

        const filter = await createFilter(connection, criteria, filterAction);
        return ok(`Filter created (ID: ${filter.id}).`);
      }

      case "delete": {
        const filterId = input.filter_id as string;
        if (!filterId) return err("filter_id is required for delete action.");

        await deleteFilter(connection, filterId);
        return ok("Filter deleted.");
      }

      default:
        return err(`Unknown action "${action}". Use list, create, or delete.`);
    }
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
