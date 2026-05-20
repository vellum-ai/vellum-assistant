export type ChatEntryKind =
  | "user"
  | "assistant"
  | "tool_call"
  | "tool_result"
  | "approval"
  | "backup_prompt"
  | "error"
  | "status";

export interface ChatEntry {
  id: string;
  kind: ChatEntryKind;
  content: string;
  timestamp: number;
  meta?: Record<string, unknown>;
}

export type PersistedMessageKind =
  | "user"
  | "assistant"
  | "tool_call"
  | "tool_result"
  | "approval"
  | "status"
  | "error";

export type PersistedSessionStatus = "active" | "completed" | "error";

export interface PersistedMessage {
  id: string;
  kind: PersistedMessageKind;
  content: string;
  metadata: unknown;
  sequence: number;
  occurred_at: string;
}

export interface PersistedSession {
  id: string;
  status: PersistedSessionStatus;
  last_message_at: string | null;
  ended_at: string | null;
  created: string;
  modified: string;
}

function metaRecord(metadata: unknown): Record<string, unknown> {
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    return metadata as Record<string, unknown>;
  }
  return {};
}

export function mapPersistedMessagesToEntries(
  messages: PersistedMessage[],
): ChatEntry[] {
  const entries: ChatEntry[] = [];

  for (const message of messages) {
    const timestamp = Date.parse(message.occurred_at);
    const meta = metaRecord(message.metadata);

    switch (message.kind) {
      case "user": {
        entries.push({
          id: message.id,
          kind: "user",
          content: message.content,
          timestamp,
        });
        break;
      }
      case "assistant": {
        entries.push({
          id: message.id,
          kind: "assistant",
          content: message.content,
          timestamp,
        });
        break;
      }
      case "tool_call": {
        const toolName =
          typeof meta.toolName === "string" ? meta.toolName : message.content;
        entries.push({
          id: message.id,
          kind: "tool_call",
          content: toolName,
          timestamp,
          meta: {
            toolName,
            input: meta.input,
            id: meta.id,
            status: "running",
          },
        });
        break;
      }
      case "tool_result": {
        const toolCallId = meta.toolCallId;
        const isError = meta.isError === true;
        const idx = entries.findIndex(
          (e) => e.kind === "tool_call" && e.meta?.id === toolCallId,
        );
        if (idx === -1) break;
        const existing = entries[idx]!;
        entries[idx] = {
          ...existing,
          meta: {
            ...(existing.meta ?? {}),
            result: message.content,
            isError,
            status: isError ? "error" : "completed",
          },
        };
        break;
      }
      case "approval": {
        const toolName =
          typeof meta.toolName === "string" ? meta.toolName : message.content;
        entries.push({
          id: message.id,
          kind: "approval",
          content: toolName,
          timestamp,
          meta: {
            toolName,
            input: meta.input,
            id: meta.id,
            description: meta.description,
          },
        });
        break;
      }
      case "status": {
        if (message.content === "completed") {
          entries.push({
            id: message.id,
            kind: "status",
            content: "Session completed",
            timestamp,
          });
        } else if (message.content === "error") {
          entries.push({
            id: message.id,
            kind: "status",
            content: "Session ended with error",
            timestamp,
          });
        }
        break;
      }
      case "error": {
        entries.push({
          id: message.id,
          kind: "error",
          content: message.content,
          timestamp,
        });
        break;
      }
      default: {
        break;
      }
    }
  }

  return entries;
}

export function mapPersistedStatusToPanelStatus(
  status: PersistedSessionStatus,
): "idle" | "active" | "completed" | "error" {
  switch (status) {
    case "active":
      return "active";
    case "completed":
      return "completed";
    case "error":
      return "error";
  }
}

export function hasPendingApproval(entries: ChatEntry[]): boolean {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (!entry) continue;
    if (entry.kind === "status") continue;
    return entry.kind === "approval";
  }
  return false;
}

export function hasPendingBackup(entries: ChatEntry[]): boolean {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (!entry) continue;
    if (entry.kind === "status") continue;
    return entry.kind === "backup_prompt";
  }
  return false;
}

export function selectLatestHistorySession<
  T extends { last_message_at: string | null; created: string },
>(sessions: T[]): T | null {
  return sessions.length > 0 ? sessions[0]! : null;
}
