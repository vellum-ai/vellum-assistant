/**
 * useDraftInput — per-conversation draft persistence for the chat composer.
 *
 * Owns `input` state, saves/restores drafts on conversation switches, and
 * persists the drafts map to localStorage keyed by `{assistantId}`.
 *
 * Replaces the manual `draftsRef` that was previously threaded through
 * ChatPage → useConversationLoader → useConversationHistory.
 *
 * @see LUM-1737
 */

import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STORAGE_KEY_PREFIX = "vellum:chatDrafts:";

function storageKey(assistantId: string): string {
  return `${STORAGE_KEY_PREFIX}${assistantId}`;
}

// ---------------------------------------------------------------------------
// localStorage helpers
// ---------------------------------------------------------------------------

function loadDrafts(assistantId: string): Map<string, string> {
  if (typeof window === "undefined") return new Map();
  try {
    const raw = window.localStorage.getItem(storageKey(assistantId));
    if (!raw) return new Map();
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return new Map();
    }
    return new Map(
      Object.entries(parsed as Record<string, unknown>).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return new Map();
  }
}

function persistDrafts(
  assistantId: string,
  drafts: Map<string, string>,
): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      storageKey(assistantId),
      JSON.stringify(Object.fromEntries(drafts)),
    );
  } catch {
    // Storage can fail in private browsing / quota-exceeded.
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UseDraftInputParams {
  assistantId: string | null;
  activeConversationKey: string | null;
  /**
   * When true, the next key change is a draft-to-server key resolution (not a
   * real switch). The hook skips save/restore and only updates its internal
   * `previousKeyRef`. Owned by ChatPage, written by `useSendMessage` when a
   * draft conversation receives its server-assigned ID.
   */
  draftKeyResolutionRef: MutableRefObject<boolean>;
  /**
   * Fires after a non-empty saved draft is restored into the composer on a
   * genuine conversation switch. Used to render a transient "Draft restored"
   * notice (LUM-1516).
   */
  onDraftRestored?: (conversationKey: string) => void;
}

export interface UseDraftInputReturn {
  input: string;
  setInput: Dispatch<SetStateAction<string>>;
  /**
   * Save the current input as a draft for the given key. Call before
   * operations that wipe state but should preserve the user's text
   * (e.g. pull-to-refresh).
   */
  saveDraft: (key: string, text: string) => void;
  /**
   * Clear the draft for the given key (e.g. after a successful send).
   */
  clearDraft: (key: string) => void;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useDraftInput({
  assistantId,
  activeConversationKey,
  draftKeyResolutionRef,
  onDraftRestored,
}: UseDraftInputParams): UseDraftInputReturn {
  const [input, setInputState] = useState("");

  // Keep an in-memory ref to the latest input value so we can read it
  // synchronously inside the switch effect without a stale closure.
  const inputValueRef = useRef("");

  const draftsRef = useRef<Map<string, string>>(new Map());
  const previousKeyRef = useRef<string | null>(null);
  const assistantIdRef = useRef<string | null>(null);

  // Wrap setInput to keep the ref in sync.
  const setInput: Dispatch<SetStateAction<string>> = useCallback(
    (action: SetStateAction<string>) => {
      setInputState((prev) => {
        const next = typeof action === "function" ? action(prev) : action;
        inputValueRef.current = next;
        return next;
      });
    },
    [],
  );

  // -----------------------------------------------------------------------
  // Load drafts from localStorage when assistantId changes.
  // Flush the outgoing assistant's drafts first so they aren't lost when
  // both assistantId and activeConversationKey change in the same render
  // (effects run in declaration order — this must run before the switch
  // effect below).
  // -----------------------------------------------------------------------
  useEffect(() => {
    const prevId = assistantIdRef.current;
    if (prevId && prevId !== assistantId) {
      // Save any in-progress text before swapping assistants.
      const prevConvKey = previousKeyRef.current;
      if (prevConvKey) {
        const currentInput = inputValueRef.current;
        if (currentInput.trim()) {
          draftsRef.current.set(prevConvKey, currentInput);
        } else {
          draftsRef.current.delete(prevConvKey);
        }
      }
      persistDrafts(prevId, draftsRef.current);
    }

    if (!assistantId) {
      draftsRef.current = new Map();
      assistantIdRef.current = null;
      return;
    }
    draftsRef.current = loadDrafts(assistantId);
    assistantIdRef.current = assistantId;
  }, [assistantId]);

  // -----------------------------------------------------------------------
  // Conversation switch: save outgoing draft, restore incoming draft
  // -----------------------------------------------------------------------
  useEffect(() => {
    const prevKey = previousKeyRef.current;
    const isSwitch = prevKey !== null && prevKey !== activeConversationKey;

    // Draft-key resolution (draft-xxx → conv-yyy) is not a real conversation
    // switch — the user stays on the same conversation. Skip save/restore to
    // avoid clearing the composer.
    if (draftKeyResolutionRef.current) {
      previousKeyRef.current = activeConversationKey;
      return;
    }

    if (isSwitch && prevKey) {
      // Save outgoing conversation's draft.
      const currentInput = inputValueRef.current;
      if (currentInput.trim()) {
        draftsRef.current.set(prevKey, currentInput);
      } else {
        draftsRef.current.delete(prevKey);
      }

      // Restore incoming conversation's draft (or clear).
      const savedDraft =
        (activeConversationKey &&
          draftsRef.current.get(activeConversationKey)) ??
        "";
      setInput(savedDraft);

      // Notify the caller only for non-empty restorations on a genuine
      // switch. This is the fix for bug #5 (misfiring notice on same-key
      // effect re-runs): same-key re-runs are excluded by the
      // `isSwitch` gate above.
      if (savedDraft.length > 0 && activeConversationKey) {
        onDraftRestored?.(activeConversationKey);
      }

      // Persist after the save/restore cycle.
      if (assistantIdRef.current) {
        persistDrafts(assistantIdRef.current, draftsRef.current);
      }
    }

    previousKeyRef.current = activeConversationKey;
  }, [activeConversationKey, setInput, onDraftRestored]);

  // -----------------------------------------------------------------------
  // Public helpers for callers that manage drafts outside the switch cycle
  // -----------------------------------------------------------------------
  const saveDraft = useCallback(
    (key: string, text: string) => {
      if (text.trim()) {
        draftsRef.current.set(key, text);
      } else {
        draftsRef.current.delete(key);
      }
      if (assistantIdRef.current) {
        persistDrafts(assistantIdRef.current, draftsRef.current);
      }
    },
    [],
  );

  const clearDraft = useCallback(
    (key: string) => {
      draftsRef.current.delete(key);
      if (assistantIdRef.current) {
        persistDrafts(assistantIdRef.current, draftsRef.current);
      }
    },
    [],
  );

  return { input, setInput, saveDraft, clearDraft };
}
