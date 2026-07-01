/**
 * Transcript formatter for conversation analysis.
 *
 * Builds a markdown transcript of a conversation, including inline
 * subagent conversation sections when present in message metadata.
 */

import { formatLocalTimestamp } from "../daemon/date-context.js";
import {
  getConversation,
  getMessages,
  parseMessageMetadata,
} from "../persistence/conversation-crud.js";
import { truncate } from "../util/truncate.js";

interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: string;
  tool_use_id?: string;
  is_error?: boolean;
  source?: { media_type?: string; filename?: string };
}

function extractAnalysisText(blocks: ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case "text":
        if (block.text) {
          parts.push(block.text);
        }
        break;
      case "tool_use":
        parts.push(
          `[Tool: ${block.name}] ${JSON.stringify(block.input ?? {})}`,
        );
        break;
      case "tool_result":
        if (block.is_error) {
          parts.push(`[Error: ${block.content ?? ""}]`);
        } else {
          parts.push(`[Result: ${truncate(block.content ?? "", 500)}]`);
        }
        break;
      case "server_tool_use":
        parts.push(`[Web search: ${block.name ?? "web_search"}]`);
        break;
      case "web_search_tool_result":
        parts.push("[Web search results]");
        break;
      case "image":
        parts.push("[Image attachment]");
        break;
      case "file":
        parts.push(`[File: ${block.source?.filename ?? "unknown"}]`);
        break;
      case "thinking":
      case "redacted_thinking":
        // Skip internal model reasoning blocks
        break;
    }
  }
  return parts.join("\n");
}

export interface TranscriptFormatOptions {
  timeZone?: string;
  assistantName?: string | null;
  userName?: string | null;
}

function resolveName(
  name: string | null | undefined,
  fallback: string,
): string {
  return name && name.length > 0 ? name : fallback;
}

function formatRole(
  role: string,
  options: TranscriptFormatOptions = {},
): string {
  return role === "user"
    ? resolveName(options.userName, "User")
    : resolveName(options.assistantName, "Assistant");
}

function formatSubagentMessages(
  msgs: ReturnType<typeof getMessages>,
  options: TranscriptFormatOptions = {},
): string {
  const lines: string[] = [];
  for (const msg of msgs) {
    const role = formatRole(msg.role, options);
    const time = formatLocalTimestamp(msg.createdAt, options.timeZone);
    const content = parseContent(msg.content);
    const text = extractAnalysisText(content);
    if (text) {
      lines.push(`> **${role}** (${time})`);
      for (const line of text.split("\n")) {
        lines.push(`> ${line}`);
      }
      lines.push(">");
    }
  }
  return lines.join("\n");
}

function parseContent(raw: string): ContentBlock[] {
  try {
    return JSON.parse(raw) as ContentBlock[];
  } catch {
    return [{ type: "text", text: raw }];
  }
}

type TranscriptMessage = ReturnType<typeof getMessages>[number];

/**
 * Format a slice of messages as a transcript body (no top-of-conversation
 * header). Used by background jobs that process incremental slices — the
 * memory-retrospective job re-renders only the messages added since its
 * last successful run rather than the whole conversation. The per-message
 * structural shape matches `buildAnalysisTranscript` (header line, body,
 * optional subagent block) so downstream agents see consistent framing.
 * The participant *labels*, however, intentionally diverge: this function
 * honors `TranscriptFormatOptions` so the memory-retrospective prompt can
 * render the conversation under the assistant and user display names,
 * while `buildAnalysisTranscript` always uses generic "User"/"Assistant"
 * labels for the analyze-conversation flow.
 */
export function formatMessageSliceForTranscript(
  messages: TranscriptMessage[],
  options: TranscriptFormatOptions = {},
): string {
  const lines: string[] = [];
  for (const msg of messages) {
    appendMessageBlock(lines, msg, options);
  }
  return lines.join("\n");
}

function appendMessageBlock(
  lines: string[],
  msg: TranscriptMessage,
  options: TranscriptFormatOptions = {},
): void {
  const role = formatRole(msg.role, options);
  const time = formatLocalTimestamp(msg.createdAt, options.timeZone);
  const content = parseContent(msg.content);
  const text = extractAnalysisText(content);

  lines.push(`## ${role} (${time})`);
  lines.push(text);
  lines.push("");

  const notif = parseMessageMetadata(msg.metadata)?.subagentNotification;
  if (
    notif &&
    (notif.status === "completed" ||
      notif.status === "failed" ||
      notif.status === "aborted") &&
    notif.conversationId
  ) {
    const subMessages = getMessages(notif.conversationId);
    lines.push(`### Subagent: ${notif.label} (${notif.status})`);
    lines.push("");
    // Subagent conversations persist the parent assistant's objective
    // as a `user` message (see subagent/manager.ts), so reusing the
    // parent's display-name options would render the assistant's
    // tasking text under the human user's name. Keep child transcripts
    // on generic role labels — and only pass through the time zone.
    lines.push(
      formatSubagentMessages(subMessages, { timeZone: options.timeZone }),
    );
    lines.push("");
  }
}

export function buildAnalysisTranscript(conversationId: string): string {
  const conversation = getConversation(conversationId);
  if (!conversation) {
    return `# Conversation not found: ${conversationId}\n`;
  }

  const allMessages = getMessages(conversationId);
  const title = conversation.title ?? "Untitled";
  const lines: string[] = [];

  lines.push(`# Conversation: ${title}`);
  lines.push(`Created: ${formatLocalTimestamp(conversation.createdAt)}`);
  lines.push("");

  for (const msg of allMessages) {
    const role = formatRole(msg.role);
    const time = formatLocalTimestamp(msg.createdAt);
    const content = parseContent(msg.content);
    const text = extractAnalysisText(content);

    lines.push(`## ${role} (${time})`);
    lines.push(text);
    lines.push("");

    // Check for subagent notifications in metadata
    const notif = parseMessageMetadata(msg.metadata)?.subagentNotification;
    if (
      notif &&
      (notif.status === "completed" ||
        notif.status === "failed" ||
        notif.status === "aborted") &&
      notif.conversationId
    ) {
      const subMessages = getMessages(notif.conversationId);
      lines.push(`### Subagent: ${notif.label} (${notif.status})`);
      lines.push("");
      lines.push(formatSubagentMessages(subMessages));
      lines.push("");
    }
  }

  return lines.join("\n");
}
