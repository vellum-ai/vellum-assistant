/**
 * Normalized message-entity state for the chat session store.
 *
 * The in-flight conversation is held as a `byId` map keyed by a stable,
 * immutable `rowKey` plus an `order` list of those keys — so a streaming
 * token patches one entity (O(1)) instead of replacing the whole array.
 *
 * `rowKey` is assigned once at row creation (`deriveRowKey`) and **never
 * recomputed**: the server `id` is a mutable field (the optimistic→server
 * swap, alias folds), and recomputing the key from a mutated `id` would
 * change a row's React key and remount it at the swap — the exact bug this
 * normalization removes. The `serverIdToRowKey` index absorbs id changes so
 * a lookup by a server `messageId` (or a folded `mergedMessageIds` alias)
 * still resolves to the owning row.
 *
 * These are pure functions over an immutable `MessageEntityState`; the
 * Zustand store holds the state and the React layer never sees this module.
 */

import type { DisplayMessage } from "@/domains/chat/types/types";

export interface MessageEntityState {
  /** rowKey → message. */
  byId: Record<string, DisplayMessage>;
  /** rowKeys in transcript order. */
  order: string[];
  /** server `id` and every `mergedMessageIds` alias → owning rowKey. */
  serverIdToRowKey: Record<string, string>;
  /**
   * rowKey of the assistant row currently being streamed into, or `null`.
   * Set synchronously by the streaming producer (replacing the async
   * `currentAssistantMessageIdRef` mirror) so `subagent_spawned` can read its
   * parent before React commits; cleared at turn end.
   */
  liveAssistantRowKey: string | null;
}

export function emptyEntityState(): MessageEntityState {
  return { byId: {}, order: [], serverIdToRowKey: {}, liveAssistantRowKey: null };
}

/**
 * The rowKey for a freshly created row — assigned once, never recomputed.
 *
 * `clientMessageId` for user-originated rows (this client minted it at send
 * and the daemon echoes it on the user_message_echo and the history snapshot,
 * so it is identical at optimistic-create → echo → refetch); otherwise the
 * row's `id` (a stable server id for server-born rows, or a transient client
 * nonce for an optimistic assistant row born before its server id arrives —
 * which the index then re-points on the swap, leaving this key untouched).
 */
export function deriveRowKey(m: DisplayMessage): string {
  return m.clientMessageId ?? m.id;
}

/** The server ids a row answers to: its primary `id` plus folded aliases. */
function serverIdsOf(m: DisplayMessage): string[] {
  return m.mergedMessageIds ? [m.id, ...m.mergedMessageIds] : [m.id];
}

/** Index a row's server ids → its rowKey, mutating `index` in place. */
function indexRow(index: Record<string, string>, rowKey: string, m: DisplayMessage): void {
  for (const sid of serverIdsOf(m)) index[sid] = rowKey;
}

/**
 * Rebuild the whole entity state from a flat message array — the bulk path
 * for a history load / reconcile snapshot apply (Phase 1 keeps these going
 * through the store; Phase 2 moves history to the Query cache). Deterministic:
 * a re-applied snapshot of the same rows yields the same rowKeys, so a refetch
 * does not remount stable rows.
 */
export function rebuildFromArray(messages: DisplayMessage[]): MessageEntityState {
  const byId: Record<string, DisplayMessage> = {};
  const order: string[] = [];
  const serverIdToRowKey: Record<string, string> = {};
  for (const m of messages) {
    const rowKey = deriveRowKey(m);
    if (byId[rowKey] === undefined) order.push(rowKey);
    byId[rowKey] = m;
    indexRow(serverIdToRowKey, rowKey, m);
  }
  return { byId, order, serverIdToRowKey, liveAssistantRowKey: null };
}

/** Materialize the transcript array in order — the `selectTranscriptMessages` seam. */
export function toArray(state: MessageEntityState): DisplayMessage[] {
  const out: DisplayMessage[] = new Array(state.order.length);
  for (let i = 0; i < state.order.length; i++) out[i] = state.byId[state.order[i]!]!;
  return out;
}

/** Resolve the rowKey owning a server `messageId` (primary id or alias), or `undefined`. */
export function rowKeyForServerId(
  state: MessageEntityState,
  serverId: string,
): string | undefined {
  return state.serverIdToRowKey[serverId];
}

/** Append a new row at the tail. The rowKey is derived once here. */
export function appendRow(
  state: MessageEntityState,
  message: DisplayMessage,
): MessageEntityState {
  const rowKey = deriveRowKey(message);
  const byId = { ...state.byId, [rowKey]: message };
  const order = state.byId[rowKey] === undefined ? [...state.order, rowKey] : state.order;
  const serverIdToRowKey = { ...state.serverIdToRowKey };
  indexRow(serverIdToRowKey, rowKey, message);
  return { ...state, byId, order, serverIdToRowKey };
}

/**
 * The universal row patch: replace `byId[rowKey]` with `transform(row)`.
 *
 * Re-indexes the row **only when its identity actually changed** — i.e. the
 * primary `id` was swapped (optimistic→server) or an alias was folded
 * (`mergedMessageIds` got a new ref). A pure content delta (text/thinking
 * token, tool/surface patch) leaves identity untouched, so the hot path does
 * no index work and stays O(1). No-ops (`transform` returns the same ref) and
 * unknown rowKeys return the input state unchanged.
 */
export function patch(
  state: MessageEntityState,
  rowKey: string,
  transform: (row: DisplayMessage) => DisplayMessage,
): MessageEntityState {
  const prev = state.byId[rowKey];
  if (prev === undefined) return state;
  const next = transform(prev);
  if (next === prev) return state;

  const byId = { ...state.byId, [rowKey]: next };

  const identityChanged =
    next.id !== prev.id || next.mergedMessageIds !== prev.mergedMessageIds;
  if (!identityChanged) {
    return { ...state, byId };
  }

  // Drop this row's stale id entries, then re-index its current ids. Other
  // rows' entries are untouched (a row never indexes another row's ids).
  const serverIdToRowKey: Record<string, string> = {};
  for (const [sid, owner] of Object.entries(state.serverIdToRowKey)) {
    if (owner !== rowKey) serverIdToRowKey[sid] = owner;
  }
  indexRow(serverIdToRowKey, rowKey, next);
  return { ...state, byId, serverIdToRowKey };
}

/** Remove a row (e.g. a content-less assistant bubble dropped on error). */
export function removeRow(state: MessageEntityState, rowKey: string): MessageEntityState {
  if (state.byId[rowKey] === undefined) return state;
  const byId = { ...state.byId };
  delete byId[rowKey];
  const order = state.order.filter((k) => k !== rowKey);
  const serverIdToRowKey: Record<string, string> = {};
  for (const [sid, owner] of Object.entries(state.serverIdToRowKey)) {
    if (owner !== rowKey) serverIdToRowKey[sid] = owner;
  }
  const liveAssistantRowKey =
    state.liveAssistantRowKey === rowKey ? null : state.liveAssistantRowKey;
  return { byId, order, serverIdToRowKey, liveAssistantRowKey };
}

/** Set (or clear) the live-assistant pointer. */
export function setLiveAssistantRowKey(
  state: MessageEntityState,
  rowKey: string | null,
): MessageEntityState {
  if (state.liveAssistantRowKey === rowKey) return state;
  return { ...state, liveAssistantRowKey: rowKey };
}
