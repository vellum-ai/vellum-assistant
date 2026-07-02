/**
 * App-level Zustand store for client-side conversation state.
 *
 * Lives at `src/stores/` (not inside `domains/conversations/`) because
 * the state here is consumed by every chat-adjacent domain — chat,
 * messaging, conversations, onboarding, page routes, sync. Per
 * `docs/CONVENTIONS.md` ("Top-level shared directories"), state used by
 * two or more domains belongs at the top level.
 *
 * Server-derived state (conversations, conversation groups) lives in
 * TanStack Query — see `@/hooks/conversation-queries.ts`.
 * This store owns only state that has no server counterpart:
 *
 * - `activeConversationId` — URL/navigation-local selection
 * - `editingConversationId` — UI mode (app-edit-chat target)
 * - `processingConversationIds` — in-flight assistant responses
 * - `processingSnapshots` — `latestAssistantMessageAt` snapshot taken when
 *   each conversation id was added to `processingConversationIds`; the
 *   attention-tracking graduation logic compares the current value against
 *   this snapshot to detect when the assistant has finished responding.
 *   Entries are added by `addProcessingConversationId` and cleared by every
 *   action that removes from `processingConversationIds`, so the two
 *   collections stay in sync.
 * - `attentionConversationIds` — conversations with pending interactions
 * - `pendingDraftProfiles` — model profiles picked in the composer for
 *   conversations whose row isn't loaded yet (drafts, or URL-opened
 *   conversations mid-load), keyed by conversation id (see field doc below)
 * - `pendingDraftPlugins` — plugins picked in the composer for the same
 *   not-yet-loaded conversations, keyed by conversation id → selected plugin
 *   ids (see field doc below)
 *
 * @see https://zustand.docs.pmnd.rs/guides/flux-inspired-practice
 * @see @/hooks/conversation-queries.ts for the server-state half
 */

import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors";

// ---------------------------------------------------------------------------
// Set / Map helpers — return the same reference when the mutation is a
// no-op so Zustand's shallow equality check can bail out of unnecessary
// re-renders.
// ---------------------------------------------------------------------------

function addToSet<T>(prev: Set<T>, key: T): Set<T> {
  if (prev.has(key)) return prev;
  const next = new Set(prev);
  next.add(key);
  return next;
}

function removeFromSet<T>(prev: Set<T>, key: T): Set<T> {
  if (!prev.has(key)) return prev;
  const next = new Set(prev);
  next.delete(key);
  return next;
}

function addOrRemoveFromSet<T>(prev: Set<T> | undefined, key: T): Set<T> {
  const next = new Set(prev);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

function removeMultipleFromSet<T>(prev: Set<T>, keys: T[]): Set<T> {
  const toRemove = keys.filter((k) => prev.has(k));
  if (toRemove.length === 0) return prev;
  const next = new Set(prev);
  for (const k of toRemove) next.delete(k);
  return next;
}

function deleteFromMap<K, V>(prev: Map<K, V>, key: K): Map<K, V> {
  if (!prev.has(key)) return prev;
  const next = new Map(prev);
  next.delete(key);
  return next;
}

// ---------------------------------------------------------------------------
// State & Actions
// ---------------------------------------------------------------------------

export interface ConversationListState {
  activeConversationId: string | null;
  editingConversationId: string | null;
  processingConversationIds: Set<string>;
  processingSnapshots: Map<string, number | undefined>;
  attentionConversationIds: Set<string>;
  /**
   * Model profiles picked in the composer for conversations that have no server
   * row loaded yet, keyed by conversation id → profile name. Two situations
   * land here, both because the composer's `conversationId` prop is undefined
   * until a row materializes:
   *
   * - A brand-new draft chat: the first message forwards the stash as the
   *   minted conversation's `inferenceProfile` (see `use-send-message`).
   * - An existing conversation opened by URL/deep link while its row is still
   *   loading: once the row resolves, `ComposerSettingsMenu` promotes the stash
   *   to a real per-conversation override.
   *
   * Stashing here — instead of writing `llm.activeProfile` — keeps an in-chat
   * model switch on a new chat from silently overwriting the global default
   * profile (the value the Settings "default profile" control owns). Keyed by
   * id (a Map, not a single slot) so juggling several unsent drafts preserves
   * each one's selection; entries are removed once applied and on reset.
   */
  pendingDraftProfiles: Map<string, string>;
  /**
   * Plugins picked in the composer for conversations that have no server row
   * loaded yet, keyed by conversation id → the set of selected plugin ids.
   * Mirrors `pendingDraftProfiles`: the composer's `conversationId` prop is
   * undefined until a row materializes, so an in-draft plugin selection is
   * stashed here (keyed by id, a Map of Sets, so several unsent drafts each
   * keep their own selection) and attached to the first message. Entries are
   * removed once applied and on reset.
   */
  pendingDraftPlugins: Map<string, Set<string>>;
}

export interface ConversationListActions {
  // --- Active / editing conversation id ---
  setActiveConversationId: (conversationId: string | null) => void;
  setEditingConversationId: (conversationId: string | null) => void;

  // --- Processing conversation ids (and their snapshots, kept atomic) ---
  addProcessingConversationId: (conversationId: string, snapshot?: number) => void;
  /**
   * Idempotent "this conversation is mid-turn" mark for SSE start events.
   * Like `addProcessingConversationId` but tolerant of repeat firings
   * (start events fire many times per turn).
   *
   * Snapshot semantics: if a snapshot is supplied AND none is recorded
   * yet, it's seeded. Subsequent calls don't overwrite — first writer
   * wins, so the send-side `addProcessingConversationId` always takes
   * precedence over later SSE marks. Without this seed, attention
   * tracking compares `latestAssistantMessageAt` against `undefined`
   * and graduates SSE-only (external-channel) turns prematurely.
   *
   * No-op when the id is already in the set and a snapshot is already
   * recorded.
   */
  markConversationProcessing: (conversationId: string, snapshot?: number) => void;
  removeProcessingConversationId: (conversationId: string) => void;
  removeMultipleProcessingConversationIds: (conversationIds: string[]) => void;
  transferProcessingConversationId: (
    oldConversationId: string,
    newConversationId: string,
  ) => void;

  // --- Attention conversation ids ---
  addAttentionConversationId: (conversationId: string) => void;
  removeAttentionConversationId: (conversationId: string) => void;

  // --- Pending draft profiles ---
  setPendingDraftProfile: (conversationId: string, profile: string) => void;
  /** Remove the stash for a single conversation id (no-op when absent). */
  clearPendingDraftProfile: (conversationId: string) => void;

  // --- Pending draft plugins ---
  setPendingDraftPlugins: (conversationId: string, plugins: Set<string>) => void;
  /** Add/remove a plugin id from the draft's set, creating it if absent. */
  togglePendingDraftPlugin: (conversationId: string, name: string) => void;
  /** Remove the stash for a single conversation id (no-op when absent). */
  clearPendingDraftPlugins: (conversationId: string) => void;

  // --- Compound ---
  graduateProcessingConversationId: (
    conversationId: string,
    hasPendingInteraction: boolean,
  ) => void;

  // --- Reset ---
  reset: () => void;
}

type ConversationListStore = ConversationListState & ConversationListActions;

const INITIAL_STATE: ConversationListState = {
  activeConversationId: null,
  editingConversationId: null,
  processingConversationIds: new Set(),
  processingSnapshots: new Map(),
  attentionConversationIds: new Set(),
  pendingDraftProfiles: new Map(),
  pendingDraftPlugins: new Map(),
};

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useConversationStore = createSelectors(
  create<ConversationListStore>((set, get) => ({
    ...INITIAL_STATE,

    // --- Active / editing conversation id ---

    setActiveConversationId: (conversationId) => {
      set({ activeConversationId: conversationId });
    },

    setEditingConversationId: (conversationId) => {
      set({ editingConversationId: conversationId });
    },

    // --- Processing conversation ids ---

    addProcessingConversationId: (conversationId, snapshot) => {
      const { processingConversationIds, processingSnapshots } = get();
      const nextSnapshots = new Map(processingSnapshots);
      nextSnapshots.set(conversationId, snapshot);
      set({
        processingConversationIds: addToSet(processingConversationIds, conversationId),
        processingSnapshots: nextSnapshots,
      });
    },

    markConversationProcessing: (conversationId, snapshot) => {
      const { processingConversationIds, processingSnapshots } = get();
      const alreadyInSet = processingConversationIds.has(conversationId);
      const alreadyHasSnapshot = processingSnapshots.has(conversationId);
      // Already fully tracked — no work.
      if (alreadyInSet && alreadyHasSnapshot) return;
      const nextSnapshots = alreadyHasSnapshot
        ? processingSnapshots
        : new Map(processingSnapshots).set(conversationId, snapshot);
      set({
        processingConversationIds: alreadyInSet
          ? processingConversationIds
          : addToSet(processingConversationIds, conversationId),
        processingSnapshots: nextSnapshots,
      });
    },

    removeProcessingConversationId: (conversationId) => {
      set({
        processingConversationIds: removeFromSet(get().processingConversationIds, conversationId),
        processingSnapshots: deleteFromMap(get().processingSnapshots, conversationId),
      });
    },

    removeMultipleProcessingConversationIds: (conversationIds) => {
      const { processingConversationIds, processingSnapshots } = get();
      let nextSnapshots = processingSnapshots;
      for (const id of conversationIds) {
        nextSnapshots = deleteFromMap(nextSnapshots, id);
      }
      set({
        processingConversationIds: removeMultipleFromSet(
          processingConversationIds,
          conversationIds,
        ),
        processingSnapshots: nextSnapshots,
      });
    },

    transferProcessingConversationId: (oldConversationId, newConversationId) => {
      const { processingConversationIds, processingSnapshots } = get();
      if (!processingConversationIds.has(oldConversationId)) return;
      const nextIds = new Set(processingConversationIds);
      nextIds.delete(oldConversationId);
      nextIds.add(newConversationId);
      const nextSnapshots = new Map(processingSnapshots);
      const snapshot = nextSnapshots.get(oldConversationId);
      nextSnapshots.delete(oldConversationId);
      nextSnapshots.set(newConversationId, snapshot);
      set({ processingConversationIds: nextIds, processingSnapshots: nextSnapshots });
    },

    // --- Attention conversation ids ---

    addAttentionConversationId: (conversationId) => {
      set({ attentionConversationIds: addToSet(get().attentionConversationIds, conversationId) });
    },

    removeAttentionConversationId: (conversationId) => {
      set({
        attentionConversationIds: removeFromSet(
          get().attentionConversationIds,
          conversationId,
        ),
      });
    },

    // --- Pending draft profiles ---

    setPendingDraftProfile: (conversationId, profile) => {
      const current = get().pendingDraftProfiles;
      if (current.get(conversationId) === profile) return;
      set({ pendingDraftProfiles: new Map(current).set(conversationId, profile) });
    },

    clearPendingDraftProfile: (conversationId) => {
      const current = get().pendingDraftProfiles;
      // No-op when absent so subscribers don't re-render needlessly. Scoped to
      // a single id so a send (or promotion) that resolves after the user moved
      // to another draft can't wipe the newer draft's selection.
      if (!current.has(conversationId)) return;
      const next = new Map(current);
      next.delete(conversationId);
      set({ pendingDraftProfiles: next });
    },

    // --- Pending draft plugins ---

    setPendingDraftPlugins: (conversationId, plugins) => {
      set({
        pendingDraftPlugins: new Map(get().pendingDraftPlugins).set(conversationId, plugins),
      });
    },

    togglePendingDraftPlugin: (conversationId, name) => {
      const current = get().pendingDraftPlugins;
      const next = new Map(current);
      next.set(conversationId, addOrRemoveFromSet(current.get(conversationId), name));
      set({ pendingDraftPlugins: next });
    },

    clearPendingDraftPlugins: (conversationId) => {
      const current = get().pendingDraftPlugins;
      // No-op when absent so subscribers don't re-render needlessly. Scoped to
      // a single id so a send that resolves after the user moved to another
      // draft can't wipe the newer draft's selection.
      if (!current.has(conversationId)) return;
      const next = new Map(current);
      next.delete(conversationId);
      set({ pendingDraftPlugins: next });
    },

    // --- Compound ---

    graduateProcessingConversationId: (conversationId, hasPendingInteraction) => {
      set((state) => ({
        processingConversationIds: removeFromSet(
          state.processingConversationIds,
          conversationId,
        ),
        processingSnapshots: deleteFromMap(state.processingSnapshots, conversationId),
        attentionConversationIds: hasPendingInteraction
          ? addToSet(state.attentionConversationIds, conversationId)
          : state.attentionConversationIds,
      }));
    },

    // --- Reset ---

    reset: () => {
      set({
        ...INITIAL_STATE,
        processingConversationIds: new Set(),
        processingSnapshots: new Map(),
        attentionConversationIds: new Set(),
        pendingDraftProfiles: new Map(),
        pendingDraftPlugins: new Map(),
      });
    },
  })),
);
