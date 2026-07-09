import type {
  AddMessageOptions,
  ConversationRow,
  MessageRole,
  MessageRow,
} from "./conversation-crud.js";
import type { ArchiveStatusFilter } from "./conversation-queries.js";
import type { ConversationType } from "./conversation-types.js";

/**
 * Plugin-facing facade over the host conversation store: reads and writes on
 * conversations and their message history, plus the lexical message-search
 * surface. Every operation takes explicit parameters and resolves nothing
 * from config, so the wrappers are pure pass-throughs.
 *
 * The store modules are loaded via dynamic `import()` inside each wrapper —
 * they carry the DB/drizzle import graph and are among the most
 * partial-mocked modules in the test suite, so importing this module (which
 * every `@vellumai/plugin-api` consumer does transitively) must not force
 * their named exports to resolve at instantiation. All type imports above are
 * erased at compile time. Async for that reason, including the wrappers whose
 * underlying functions are synchronous.
 */

type MessageMetadata = ReturnType<
  typeof import("./conversation-crud.js").parseMessageMetadata
>;

type MessageLexicalSearchResult = Awaited<
  ReturnType<
    typeof import("./conversation-search-lexical.js").searchMessageIdsLexical
  >
>[number];

type AddMessageResult = Awaited<
  ReturnType<typeof import("./conversation-crud.js").addMessage>
>;

/** Look up a conversation row by id. */
export async function getConversation(
  id: string,
): Promise<ConversationRow | null> {
  const { getConversation: fn } = await import("./conversation-crud.js");
  return fn(id);
}

/** All messages of a conversation in insertion order. */
export async function getMessages(
  conversationId: string,
): Promise<MessageRow[]> {
  const { getMessages: fn } = await import("./conversation-crud.js");
  return fn(conversationId);
}

/** Whether the conversation currently has a turn in flight. */
export async function isConversationProcessing(id: string): Promise<boolean> {
  const { isConversationProcessing: fn } =
    await import("./conversation-crud.js");
  return fn(id);
}

/** Parse a stored message-metadata JSON string; undefined when absent/invalid. */
export async function parseMessageMetadata(
  metadataJson: string | null,
): Promise<MessageMetadata> {
  const { parseMessageMetadata: fn } = await import("./conversation-crud.js");
  return fn(metadataJson);
}

/** Merge the given keys into a message's metadata JSON. */
export async function updateMessageMetadata(
  messageId: string,
  updates: Record<string, unknown>,
): Promise<void> {
  const { updateMessageMetadata: fn } = await import("./conversation-crud.js");
  return fn(messageId, updates);
}

/**
 * Append a message to a conversation. This is the low-level insert: it
 * persists and indexes the row only — it does not project the message into
 * the conversation's disk view and does not notify connected clients, so
 * background/internal writes stay silent. A user-visible append pairs this
 * with `syncMessageToDisk` and a client notification, as the host's own
 * out-of-pipeline writers do.
 */
export async function addMessage(
  conversationId: string,
  role: MessageRole,
  content: string,
  options?: AddMessageOptions,
): Promise<AddMessageResult> {
  const { addMessage: fn } = await import("./conversation-crud.js");
  return fn(conversationId, role, content, options);
}

/**
 * Delete a conversation, yielding the event loop between row batches, and
 * enqueue vector-store cleanup for the memory segments and summaries the
 * delete cascaded away — the same vector-cleanup pairing the host's delete
 * route performs, so facade callers never leave semantic vectors behind. The lexical-index
 * purge runs inside the delete itself via the persistence hook.
 */
export async function deleteConversation(id: string): Promise<void> {
  const [{ deleteConversationGently: fn }, { enqueueMemoryJob }] =
    await Promise.all([
      import("./conversation-crud.js"),
      import("./jobs-store.js"),
    ]);
  const deleted = await fn(id);
  for (const segId of deleted.segmentIds) {
    enqueueMemoryJob("delete_qdrant_vectors", {
      targetType: "segment",
      targetId: segId,
    });
  }
  for (const summaryId of deleted.deletedSummaryIds) {
    enqueueMemoryJob("delete_qdrant_vectors", {
      targetType: "summary",
      targetId: summaryId,
    });
  }
}

/** List conversation rows, newest first. */
export async function listConversations(
  limit?: number,
  conversationType?: ConversationType,
  offset?: number,
  archiveStatus?: ArchiveStatusFilter,
  originChannel?: string,
): Promise<ConversationRow[]> {
  const { listConversations: fn } = await import("./conversation-queries.js");
  // Explicit `undefined` arguments fall through to the underlying defaults.
  return fn(limit, conversationType, offset, archiveStatus, originChannel);
}

/** Sparse lexical search over stored message text; ranked message-id hits. */
export async function searchMessageIdsLexical(
  query: string,
  limit: number,
  opts?: { conversationId?: string },
): Promise<MessageLexicalSearchResult[]> {
  const { searchMessageIdsLexical: fn } =
    await import("./conversation-search-lexical.js");
  return fn(query, limit, opts);
}

/** Whether the text tokenizes to at least one lexical search token. */
export async function hasLexicalTokens(text: string): Promise<boolean> {
  const { hasLexicalTokens: fn } = await import("./conversation-queries.js");
  return fn(text);
}

/**
 * Build a model-facing excerpt of stored message content around a query,
 * preserving external-content envelopes so third-party boundaries stay
 * visible.
 */
export async function buildMessageExcerpt(
  rawContent: string,
  query: string,
): Promise<string> {
  const { buildRecallEvidenceExcerpt: fn } =
    await import("./conversation-queries.js");
  return fn(rawContent, query);
}

/**
 * Absolute path of a conversation's disk-view directory under the workspace
 * naming scheme (timestamp-first, derived from id + creation time).
 */
export async function getConversationDirPath(
  id: string,
  createdAtMs: number,
): Promise<string> {
  const { getConversationDirPath: fn } =
    await import("./conversation-directories.js");
  return fn(id, createdAtMs);
}

/** Re-sync one persisted message into the conversation's disk view. */
export async function syncMessageToDisk(
  conversationId: string,
  messageId: string,
  createdAtMs: number,
): Promise<void> {
  const { syncMessageToDisk: fn } = await import("./conversation-disk-view.js");
  return fn(conversationId, messageId, createdAtMs);
}
