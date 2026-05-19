// Pure helpers for converting persisted Doctor session/message rows into the
// in-panel ChatEntry shape used by DoctorPanel. Kept React-free and decoupled
// from the generated heyapi types so the helpers are easy to unit-test and
// remain stable across schema regenerations — DoctorPanel is responsible for
// narrowing generated query results into the structural shapes below.

// ---------------------------------------------------------------------------
// Shared ChatEntry shape (re-exported and consumed by DoctorPanel)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Persisted shapes (subset; structural so we don't depend on heyapi gen types)
// ---------------------------------------------------------------------------

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
  // The backend stores arbitrary JSON; null/undefined are tolerated for safety.
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function metaRecord(metadata: unknown): Record<string, unknown> {
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    return metadata as Record<string, unknown>;
  }
  return {};
}

/**
 * Convert persisted DoctorMessage rows into the ChatEntry shape rendered by
 * DoctorPanel. Mirrors the live SSE handler so reloaded sessions render
 * identically to active ones:
 *
 *   - `tool_result` rows are MERGED into the matching prior `tool_call` entry
 *     by `metadata.toolCallId == tool_call.meta.id`. Orphan results are
 *     dropped silently.
 *   - `status` rows with content `"active"` are filtered out (the live UI only
 *     surfaces terminal statuses). `"completed"` and `"error"` are translated
 *     to the same display strings the SSE handler uses.
 *
 * The input is expected to be ordered by `sequence` (which the API already
 * guarantees).
 */
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
        // Merge into the matching tool_call entry; drop silently if orphaned.
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
        // "active" and any unexpected values are intentionally skipped.
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
        // Unknown kinds are skipped defensively so a future backend addition
        // doesn't crash the panel before clients are updated.
        break;
      }
    }
  }

  return entries;
}

/**
 * Map the API session status to the panel's session-status state machine.
 *
 * Persisted `"active"` sessions are mapped to `"active"` so the panel can
 * resume the live session on page refresh: the caller is responsible for
 * binding `sessionId` to the persisted session's PK (which doubles as the
 * upstream Doctor session id) and reconnecting the SSE event stream. If the
 * upstream session has TTL-expired in Redis the SSE reconnect surfaces a 404
 * and the panel transitions itself back into a terminal state — presenting
 * an honest expiry message instead of silently dropping user input.
 */
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

/**
 * Determine whether a resumed timeline ends with an unresolved approval
 * request. The live UI tracks this via `pendingApproval` state, which is
 * flipped off as soon as the user responds via `handleApprovalResponse` (which
 * posts a user message to the Doctor). On page refresh that in-memory state
 * is lost, so we reconstruct it from the persisted ledger: an approval is
 * considered still pending iff the most recent non-status entry is itself an
 * approval. Any later user / assistant / tool_call entry means the user has
 * already replied to the approval request.
 */
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

/**
 * Pick the most recent session from a paginated list response.
 *
 * The backend already orders by `last_message_at DESC NULLS LAST, -created`,
 * so the first item is authoritative; this helper just trusts that ordering.
 */
export function selectLatestHistorySession<
  T extends { last_message_at: string | null; created: string },
>(sessions: T[]): T | null {
  return sessions.length > 0 ? sessions[0]! : null;
}
