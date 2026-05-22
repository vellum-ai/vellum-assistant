export interface TranscriptMessage {
  id?: string;
  role?: string;
  text?: string;
  content?: unknown;
  createdAt?: number;
  timestamp?: number;
  [key: string]: unknown;
}

export interface FormatTranscriptOptions {
  conversationId: string;
  title?: string | null;
  messages: TranscriptMessage[];
  exportedAt?: Date;
}

function blockText(block: unknown): string {
  if (typeof block === "string") return block;
  if (!block || typeof block !== "object") return "";

  const record = block as Record<string, unknown>;
  if (typeof record.text === "string") return record.text;
  if (typeof record.content === "string") return record.content;
  if (Array.isArray(record.content)) {
    return record.content.map(blockText).filter(Boolean).join("\n");
  }
  return "";
}

function contentText(content: unknown): string {
  if (typeof content === "string") {
    try {
      const parsed = JSON.parse(content) as unknown;
      const parsedText = contentText(parsed);
      return parsedText || content;
    } catch {
      return content;
    }
  }
  if (Array.isArray(content)) {
    return content.map(blockText).filter(Boolean).join("\n");
  }
  return blockText(content);
}

export function messageText(message: TranscriptMessage): string {
  if (typeof message.text === "string") return message.text;
  return contentText(message.content).trim();
}

export function lastAssistantResponseText(
  messages: readonly TranscriptMessage[],
): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    const text = messageText(message);
    if (text) return text;
  }
  return null;
}

function roleLabel(role: unknown): string {
  if (role === "assistant") return "Assistant";
  if (role === "user") return "User";
  if (role === "tool") return "Tool";
  if (typeof role === "string" && role.length > 0) return role;
  return "Message";
}

function messageTimestamp(message: TranscriptMessage): string | null {
  const value = message.createdAt ?? message.timestamp;
  if (typeof value !== "number") return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

export function formatConversationTranscript(
  options: FormatTranscriptOptions,
): string {
  const title = options.title?.trim() || "Untitled conversation";
  const exportedAt = options.exportedAt ?? new Date();
  const lines = [
    `# ${title}`,
    "",
    `Conversation ID: ${options.conversationId}`,
    `Exported: ${exportedAt.toISOString()}`,
    "",
    "## Transcript",
  ];

  if (options.messages.length === 0) {
    lines.push("", "_No messages yet._");
    return `${lines.join("\n")}\n`;
  }

  for (const message of options.messages) {
    const text = messageText(message);
    if (!text) continue;
    const timestamp = messageTimestamp(message);
    lines.push(
      "",
      `### ${roleLabel(message.role)}${timestamp ? ` - ${timestamp}` : ""}`,
      "",
      text,
    );
  }

  return `${lines.join("\n")}\n`;
}
