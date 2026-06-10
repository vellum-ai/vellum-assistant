import type {
  DoctorMessage,
  DoctorSessionStatusEnum,
} from "@/generated/api/types.gen";

// ---------------------------------------------------------------------------
// ChatEntry — discriminated union by `kind`
// ---------------------------------------------------------------------------

interface ChatEntryBase {
  id: string;
  content: string;
  timestamp: number;
}

export interface ToolCallMeta {
  toolName: string;
  input: Record<string, unknown>;
  toolCallId: string;
  status: "running" | "completed" | "error";
  result?: string;
  isError?: boolean;
}

export interface ApprovalMeta {
  toolName: string;
  input: Record<string, unknown>;
  toolCallId: string;
  description: string;
}

export interface BackupPromptMeta {
  toolName: string;
}

export type ChatEntry =
  | (ChatEntryBase & { kind: "user" })
  | (ChatEntryBase & { kind: "assistant" })
  | (ChatEntryBase & { kind: "tool_call"; meta: ToolCallMeta })
  | (ChatEntryBase & { kind: "approval"; meta: ApprovalMeta })
  | (ChatEntryBase & { kind: "backup_prompt"; meta: BackupPromptMeta })
  | (ChatEntryBase & { kind: "error" })
  | (ChatEntryBase & { kind: "status" });

/** Distributive omit that preserves the discriminated union structure. */
export type NewChatEntry =
  | { kind: "user"; content: string }
  | { kind: "assistant"; content: string }
  | { kind: "tool_call"; content: string; meta: ToolCallMeta }
  | { kind: "approval"; content: string; meta: ApprovalMeta }
  | { kind: "backup_prompt"; content: string; meta: BackupPromptMeta }
  | { kind: "error"; content: string }
  | { kind: "status"; content: string };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function metaRecord(metadata: unknown): Record<string, unknown> {
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    return metadata as Record<string, unknown>;
  }
  return {};
}

export function mapPersistedMessagesToEntries(
  messages: DoctorMessage[],
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
            input: (meta.input as Record<string, unknown>) ?? {},
            toolCallId: typeof meta.id === "string" ? meta.id : message.id,
            status: "running",
          },
        });
        break;
      }
      case "tool_result": {
        const toolCallId = meta.toolCallId;
        const isError = meta.isError === true;
        const idx = entries.findIndex(
          (e) =>
            e.kind === "tool_call" &&
            e.meta.toolCallId === toolCallId,
        );
        if (idx === -1) break;
        const existing = entries[idx]!;
        if (existing.kind !== "tool_call") break;
        entries[idx] = {
          ...existing,
          meta: {
            ...existing.meta,
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
            input: (meta.input as Record<string, unknown>) ?? {},
            toolCallId: typeof meta.id === "string" ? meta.id : message.id,
            description: typeof meta.description === "string" ? meta.description : "",
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
  status: DoctorSessionStatusEnum,
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
  return sessions[0] ?? null;
}
