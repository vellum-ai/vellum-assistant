import { getContact } from "../../contacts/contact-store.js";
import { createFollowUp } from "../../followups/followup-store.js";
import type { FollowUp } from "../../followups/types.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";

function formatFollowUp(f: FollowUp): string {
  const lines = [
    `Follow-up ${f.id}`,
    `  Channel: ${f.channel}`,
    `  Conversation: ${f.conversationId}`,
    `  Status: ${f.status}`,
    `  Sent at: ${new Date(f.sentAt).toISOString()}`,
  ];
  if (f.contactId) lines.push(`  Contact ID: ${f.contactId}`);
  if (f.expectedResponseBy) {
    lines.push(
      `  Expected response by: ${new Date(f.expectedResponseBy).toISOString()}`,
    );
  }
  if (f.reminderScheduleId)
    lines.push(`  Reminder schedule: ${f.reminderScheduleId}`);
  return lines.join("\n");
}

export async function executeFollowupCreate(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const channel = input.channel as string | undefined;
  if (!channel || typeof channel !== "string" || channel.trim().length === 0) {
    return {
      content: "Error: channel is required and must be a non-empty string",
      isError: true,
    };
  }

  const conversationId = input.conversation_id as string | undefined;
  if (
    !conversationId ||
    typeof conversationId !== "string" ||
    conversationId.trim().length === 0
  ) {
    return {
      content:
        "Error: conversation_id is required and must be a non-empty string",
      isError: true,
    };
  }

  const contactId = input.contact_id as string | undefined;
  const expectedResponseHours = input.expected_response_hours as
    | number
    | undefined;
  const reminderScheduleId = input.reminder_schedule_id as string | undefined;

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
