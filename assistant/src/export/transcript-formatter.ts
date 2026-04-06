/**
 * Transcript formatter for conversation analysis.
 *
 * Builds a markdown transcript of a conversation, including inline
 * subagent conversation sections when present in message metadata.
 */

import {
  getConversation,
  getMessages,
  messageMetadataSchema,
} from "../memory/conversation-crud.js";
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

function formatTimestamp(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
}

function extractAnalysisText(blocks: ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case "text":
        if (block.text) parts.push(block.text);
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

function formatRole(role: string): string {
  return role === "user" ? "User" : "Assistant";
}

function formatSubagentMessages(msgs: ReturnType<typeof getMessages>): string {
  const lines: string[] = [];
  for (const msg of msgs) {
    const role = formatRole(msg.role);
    const time = formatTimestamp(msg.createdAt);
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

export function buildAnalysisTranscript(conversationId: string): string {
  const conversation = getConversation(conversationId);
  if (!conversation) {
    return `# Conversation not found: ${conversationId}\n`;
  }

  const allMessages = getMessages(conversationId);
  const title = conversation.title ?? "Untitled";
  const lines: string[] = [];

  lines.push(`# Conversation: ${title}`);
  lines.push(`Created: ${formatTimestamp(conversation.createdAt)}`);
  lines.push("");

  for (const msg of allMessages) {
    const role = formatRole(msg.role);
    const time = formatTimestamp(msg.createdAt);
    const content = parseContent(msg.content);
    const text = extractAnalysisText(content);

    lines.push(`## ${role} (${time})`);
    lines.push(text);
    lines.push("");

    // Check for subagent notifications in metadata
    if (msg.metadata) {
      try {
        const parsed = messageMetadataSchema.safeParse(JSON.parse(msg.metadata));
        if (parsed.success && parsed.data.subagentNotification) {
          const notif = parsed.data.subagentNotification;
          if (
            (notif.status === "completed" || notif.status === "failed" || notif.status === "aborted") &&
            notif.conversationId
          ) {
            const subMessages = getMessages(notif.conversationId);
            lines.push(`### Subagent: ${notif.label} (${notif.status})`);
            lines.push("");
            lines.push(formatSubagentMessages(subMessages));
            lines.push("");
          }
        }
      } catch {
        // Skip unparseable metadata
      }
    }
  }

  return lines.join("\n");
}
