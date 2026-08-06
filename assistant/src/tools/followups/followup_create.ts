import { z } from "zod";

import { getContact } from "../../contacts/contact-store.js";
import { createFollowUp } from "../../followups/followup-store.js";
import type { FollowUp } from "../../followups/types.js";
import {
  invalidToolInputResult,
  nullAsOmitted,
} from "../shared/zod-tool-schema.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";

/**
 * Model-input schema, `safeParse`d at the top of {@link executeFollowupCreate}.
 * Same in-tool pattern and TOOLS.json drift guard as the other bundled-skill
 * tools — see the schema block in `tools/document/document-tool.ts` for the
 * framework. The bespoke non-empty (trim) checks keep their current error
 * semantics; `expected_response_hours` is deliberately UNDECLARED (loose
 * passthrough) so its bespoke positive-number check owns the error message
 * for every malformed shape.
 */
export const followupCreateInputSchema = z.looseObject({
  channel: nullAsOmitted(z.string()),
  conversation_id: nullAsOmitted(z.string()),
  contact_id: nullAsOmitted(z.string()),
  reminder_schedule_id: nullAsOmitted(z.string()),
});

function formatFollowUp(f: FollowUp): string {
  const lines = [
    `Follow-up ${f.id}`,
    `  Channel: ${f.channel}`,
    `  Conversation: ${f.conversationId}`,
    `  Status: ${f.status}`,
    `  Sent at: ${new Date(f.sentAt).toISOString()}`,
  ];
  if (f.contactId) {
    lines.push(`  Contact ID: ${f.contactId}`);
  }
  if (f.expectedResponseBy) {
    lines.push(
      `  Expected response by: ${new Date(f.expectedResponseBy).toISOString()}`,
    );
  }
  if (f.reminderScheduleId) {
    lines.push(`  Reminder schedule: ${f.reminderScheduleId}`);
  }
  return lines.join("\n");
}

export async function executeFollowupCreate(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const parsedInput = followupCreateInputSchema.safeParse(input);
  if (!parsedInput.success) {
    return invalidToolInputResult("followup_create", parsedInput.error);
  }
  const parsed = parsedInput.data;

  const channel = parsed.channel;
  if (!channel || channel.trim().length === 0) {
    return {
      content: "Error: channel is required and must be a non-empty string",
      isError: true,
    };
  }

  const conversationId = parsed.conversation_id;
  if (!conversationId || conversationId.trim().length === 0) {
    return {
      content:
        "Error: conversation_id is required and must be a non-empty string",
      isError: true,
    };
  }

  const contactId = parsed.contact_id;
  // Loose passthrough (see schema doc comment) — the bespoke check below
  // owns every malformed shape.
  const expectedResponseHours = input.expected_response_hours as
    | number
    | undefined;
  const reminderScheduleId = parsed.reminder_schedule_id;

  // Validate contact exists if provided
  if (contactId) {
    const contact = getContact(contactId);
    if (!contact) {
      return {
        content: `Error: Contact "${contactId}" not found`,
        isError: true,
      };
    }
  }

  if (
    expectedResponseHours !== undefined &&
    (typeof expectedResponseHours !== "number" || expectedResponseHours <= 0)
  ) {
    return {
      content: "Error: expected_response_hours must be a positive number",
      isError: true,
    };
  }

  try {
    const now = Date.now();
    const expectedResponseBy = expectedResponseHours
      ? now + expectedResponseHours * 60 * 60 * 1000
      : null;

    const followUp = createFollowUp({
      channel: channel.trim(),
      conversationId: conversationId.trim(),
      contactId: contactId ?? null,
      sentAt: now,
      expectedResponseBy,
      reminderScheduleId: reminderScheduleId ?? null,
    });

    return {
      content: `Created follow-up:\n${formatFollowUp(followUp)}`,
      isError: false,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: `Error: ${msg}`, isError: true };
  }
}
