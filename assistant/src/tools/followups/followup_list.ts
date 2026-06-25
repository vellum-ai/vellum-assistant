import {
  getOverdueFollowUps,
  listFollowUps,
} from "../../followups/followup-store.js";
import type { FollowUp, FollowUpStatus } from "../../followups/types.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";

const VALID_STATUSES = ["pending", "resolved", "overdue", "nudged"] as const;

function formatFollowUpSummary(f: FollowUp): string {
  const parts = [
    `- **${f.channel}** conversation:${f.conversationId} (ID: ${f.id})`,
  ];
  parts.push(
    `  Status: ${f.status} | Sent: ${new Date(f.sentAt).toISOString()}`,
  );
  if (f.contactId) parts.push(`  Contact: ${f.contactId}`);
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
  const status = input.status as FollowUpStatus | undefined;
  const channel = input.channel as string | undefined;
  const contactId = input.contact_id as string | undefined;
  const overdueOnly = input.overdue_only as boolean | undefined;

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
      if (channel) results = results.filter((f) => f.channel === channel);
      if (contactId) results = results.filter((f) => f.contactId === contactId);
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
