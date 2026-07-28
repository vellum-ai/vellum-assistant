import { z } from "zod";

import {
  getOverdueFollowUps,
  listFollowUps,
} from "../../followups/followup-store.js";
import type { FollowUp, FollowUpStatus } from "../../followups/types.js";
import {
  invalidToolInputResult,
  nullAsOmitted,
} from "../shared/zod-tool-schema.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";

const VALID_STATUSES = ["pending", "resolved", "overdue", "nudged"] as const;

/**
 * Model-input schema, `safeParse`d at the top of {@link executeFollowupList}.
 * Same in-tool pattern and TOOLS.json drift guard as the other bundled-skill
 * tools. `status` is deliberately UNDECLARED (loose passthrough): the bespoke
 * `VALID_STATUSES` check owns the "Invalid status" error (test-asserted).
 */
export const followupListInputSchema = z.looseObject({
  channel: nullAsOmitted(z.string()),
  contact_id: nullAsOmitted(z.string()),
  overdue_only: nullAsOmitted(z.boolean()),
});

function formatFollowUpSummary(f: FollowUp): string {
  const parts = [
    `- **${f.channel}** conversation:${f.conversationId} (ID: ${f.id})`,
  ];
  parts.push(
    `  Status: ${f.status} | Sent: ${new Date(f.sentAt).toISOString()}`,
  );
  if (f.contactId) {
    parts.push(`  Contact: ${f.contactId}`);
  }
  if (f.expectedResponseBy) {
    const deadline = new Date(f.expectedResponseBy);
    const isOverdue = f.status === "pending" && deadline.getTime() < Date.now();
    parts.push(
      `  Expected by: ${deadline.toISOString()}${isOverdue ? " (OVERDUE)" : ""}`,
    );
  }
  return parts.join("\n");
}

export async function executeFollowupList(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const parsedInput = followupListInputSchema.safeParse(input);
  if (!parsedInput.success) {
    return invalidToolInputResult("followup_list", parsedInput.error);
  }
  const status = input.status as FollowUpStatus | undefined;
  const channel = parsedInput.data.channel;
  const contactId = parsedInput.data.contact_id;
  const overdueOnly = parsedInput.data.overdue_only;

  if (
    status &&
    !VALID_STATUSES.includes(status as (typeof VALID_STATUSES)[number])
  ) {
    return {
      content: `Error: Invalid status "${status}". Must be one of: ${VALID_STATUSES.join(
        ", ",
      )}`,
      isError: true,
    };
  }

  try {
    let results: FollowUp[];

    if (overdueOnly || status === "overdue") {
      results = getOverdueFollowUps();
      if (channel) {
        results = results.filter((f) => f.channel === channel);
      }
      if (contactId) {
        results = results.filter((f) => f.contactId === contactId);
      }
    } else {
      results = listFollowUps({ status, channel, contactId });
    }

    if (results.length === 0) {
      return {
        content: "No follow-ups found matching the criteria.",
        isError: false,
      };
    }

    const lines = [`Found ${results.length} follow-up(s):\n`];
    for (const followUp of results) {
      lines.push(formatFollowUpSummary(followUp));
    }

    return { content: lines.join("\n"), isError: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: `Error: ${msg}`, isError: true };
  }
}
