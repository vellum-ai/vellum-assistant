/**
 * Conversation export formatters for markdown and JSON.
 */

import { truncate } from "../util/truncate.js";

interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: string;
  tool_use_id?: string;
  is_error?: boolean;
}

interface ExportMessage {
  role: string;
  content: ContentBlock[];
  createdAt: number;
}

interface ExportConversation {
  id: string;
  title: string | null;
  createdAt: number;
  updatedAt: number;
  messages: ExportMessage[];
}

function formatTimestamp(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
}

function extractText(blocks: ContentBlock[]): string {
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
    }
  }
  return parts.join("\n");
}

export function formatMarkdown(conversation: ExportConversation): string {
  const title = conversation.title ?? "Untitled";
  const lines: string[] = [];

  lines.push(`# ${title}`);
  lines.push("");
  lines.push(`*Session ID: ${conversation.id}*`);
  lines.push(`*Created: ${formatTimestamp(conversation.createdAt)}*`);
  lines.push("");
  lines.push("---");
  lines.push("");

  for (const msg of conversation.messages) {
    const role = msg.role === "user" ? "You" : "Assistant";
    const time = formatTimestamp(msg.createdAt);
    lines.push(`## ${role} (${time})`);
    lines.push("");
    lines.push(extractText(msg.content));
    lines.push("");
  }

  lines.push("---");
  lines.push(`*Exported at ${formatTimestamp(Date.now())}*`);
  lines.push("");

  return lines.join("\n");
}

export function formatJson(conversation: ExportConversation): string {
  return JSON.stringify(
    {
      id: conversation.id,
      title: conversation.title,
      createdAt: new Date(conversation.createdAt).toISOString(),
      updatedAt: new Date(conversation.updatedAt).toISOString(),
      exportedAt: new Date().toISOString(),
      messages: conversation.messages.map((msg) => ({
        role: msg.role,
        content: msg.content,
        timestamp: new Date(msg.createdAt).toISOString(),
      })),
    },
    null,
    2,
  );
}
