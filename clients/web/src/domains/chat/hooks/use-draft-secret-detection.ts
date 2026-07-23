/**
 * Detects high-confidence secrets (API keys, tokens) in the chat draft and
 * owns the notice/dismissal + pre-send gate state for the composer secret
 * guard.
 *
 * Gated on the `composer-secret-guard` assistant flag: while the flag is off
 * (or the flag store has not hydrated yet) the hook is inert — no store
 * subscription, no scanning work, `matches` is always empty.
 *
 * Draft scanning subscribes to the composer store directly (debounced,
 * non-reactive) instead of taking the draft as a reactive prop: the
 * orchestrator that mounts this hook deliberately does not subscribe to
 * composer input, so typing must never re-render it. React state only
 * changes when the detected set changes.
 *
 * Conversation switches are the one non-debounced path: stale matches are
 * cleared in the switch commit and the incoming conversation's restored
 * draft is scanned as soon as the session store swaps it in, so a stale
 * notice never flashes over the new composer and a restored secret warns
 * without waiting out the debounce.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  detectSecretsInText,
  type DetectedSecret,
} from "@vellumai/service-contracts/secret-detection";

import { useComposerStore } from "@/domains/chat/composer-store";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";

// ---------------------------------------------------------------------------
// Pure scan policy (DOM-free, exported for tests)
// ---------------------------------------------------------------------------

/**
 * Drafts shorter than this are skipped without invoking the detector — no
 * detectable token pattern fits in fewer characters.
 */
export const SECRET_SCAN_MIN_DRAFT_LENGTH = 16;

/** Debounce between a draft keystroke and the scan it triggers. */
export const SECRET_SCAN_DEBOUNCE_MS = 250;

/**
 * Scan decision + prefilter: returns the secrets to surface for a draft, or
 * an empty list when scanning is disabled or the draft is too short to
 * contain a detectable token.
 */
export function scanDraftForSecrets(
  text: string,
  enabled: boolean,
): DetectedSecret[] {
  if (!enabled || text.length < SECRET_SCAN_MIN_DRAFT_LENGTH) {
    return [];
  }
  return detectSecretsInText(text);
}

function sameMatches(a: DetectedSecret[], b: DetectedSecret[]): boolean {
  return (
    a.length === b.length &&
    a.every((m, i) => {
      const other = b[i];
      return (
        other !== undefined &&
        m.label === other.label &&
        m.value === other.value &&
        m.start === other.start &&
        m.end === other.end
      );
    })
  );
}

const EMPTY_VALUE_SET: ReadonlySet<string> = new Set();

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface UseDraftSecretDetectionParams {
  /**
   * Routing-truth conversation id. Switching conversations swaps the draft,
   * so matches, dismissal, and send-block state reset when it changes and
   * the incoming draft is re-scanned immediately.
   */
  conversationId: string | null;
  /** Scan debounce override for tests. */
  debounceMs?: number;
}

export interface DraftSecretDetectionResult {
  /**
   * Secrets currently detected in the draft, ordered by position. Empty
   * while the flag is off or the flag store has not hydrated.
   */
  matches: DetectedSecret[];
  /** True when the user dismissed the notice for every flagged value. */
  dismissed: boolean;
  /**
   * Suppress the notice for the currently flagged values. Auto-resets when
   * the flagged values leave the draft, a new value is flagged, or the
   * conversation changes.
   */
  dismiss: () => void;
  /** True when the most recent {@link checkBeforeSend} blocked a send. */
  sendBlocked: boolean;
  /**
   * Pre-send gate: scans the outgoing text and returns whether the send may
   * proceed. Returns false (and sets {@link sendBlocked}) when secrets are
   * detected and no {@link allowOnce} bypass is armed.
   */
  checkBeforeSend: (text: string) => boolean;
  /** Arm a single-use bypass so the next {@link checkBeforeSend} passes. */
  allowOnce: () => void;
}

export function useDraftSecretDetection({
  conversationId,
  debounceMs = SECRET_SCAN_DEBOUNCE_MS,
}: UseDraftSecretDetectionParams): DraftSecretDetectionResult {
  const composerSecretGuard =
    useAssistantFeatureFlagStore.use.composerSecretGuard();
  const hasHydrated = useAssistantFeatureFlagStore.use.hasHydrated();
  const enabled = hasHydrated && composerSecretGuard;

  const [matches, setMatches] = useState<DetectedSecret[]>([]);
  const [dismissedValues, setDismissedValues] =
    useState<ReadonlySet<string>>(EMPTY_VALUE_SET);
  const [sendBlocked, setSendBlocked] = useState(false);
  const allowOnceRef = useRef(false);
  // Armed on a conversation switch: the next composer input change is the
  // incoming conversation's restored draft (applied by the session store's
  // post-render switch effect), not a keystroke, so it is scanned
  // immediately instead of debounced.
  const scanNextInputImmediatelyRef = useRef(false);
  const prevConversationIdRef = useRef(conversationId);

  // Dismissal and send-block state are scoped to one conversation's draft
  // under one flag state — any transition of either invalidates them.
  // Layout effect: the reset must land before the switched route paints.
  useLayoutEffect(() => {
    allowOnceRef.current = false;
    setSendBlocked(false);
    setDismissedValues(EMPTY_VALUE_SET);
  }, [enabled, conversationId]);

  // Conversation switches swap the draft in a parent post-render effect,
  // after this effect runs — the composer store still holds the outgoing
  // conversation's draft here, so scanning it would resurrect the old
  // matches. Instead: drop the stale matches before the new route paints
  // (layout effect — the previous conversation's notice must never be
  // visible over the new composer, even for one frame) and arm the
  // immediate scan of the incoming draft when the swap lands.
  useLayoutEffect(() => {
    if (prevConversationIdRef.current === conversationId) {
      return;
    }
    prevConversationIdRef.current = conversationId;
    setMatches((prev) => (prev.length === 0 ? prev : []));
    scanNextInputImmediatelyRef.current = true;
  }, [conversationId]);

  useEffect(() => {
    if (!enabled) {
      setMatches([]);
      return;
    }

    const applyScan = (text: string) => {
      const next = scanDraftForSecrets(text, true);
      setMatches((prev) => (sameMatches(prev, next) ? prev : next));
      if (next.length === 0) {
        // The flagged values left the draft: reset dismissal and any block.
        setDismissedValues((prev) =>
          prev.size === 0 ? prev : EMPTY_VALUE_SET,
        );
        setSendBlocked(false);
      }
    };

    // Scan the current draft immediately (restored drafts, prefills);
    // conversation switches re-enter here through the input subscription.
    scanNextInputImmediatelyRef.current = false;
    applyScan(useComposerStore.getState().input);

    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = useComposerStore.subscribe((state, prevState) => {
      if (state.input === prevState.input) {
        return;
      }
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (scanNextInputImmediatelyRef.current) {
        // Conversation-switch draft swap: surface the incoming draft's
        // secrets without waiting out the keystroke debounce.
        scanNextInputImmediatelyRef.current = false;
        applyScan(state.input);
        return;
      }
      timer = setTimeout(() => {
        timer = null;
        applyScan(useComposerStore.getState().input);
      }, debounceMs);
    });

    return () => {
      if (timer !== null) {
        clearTimeout(timer);
      }
      unsubscribe();
    };
  }, [enabled, debounceMs]);

  const dismiss = useCallback(() => {
    setDismissedValues(new Set(matches.map((m) => m.value)));
  }, [matches]);

  const allowOnce = useCallback(() => {
    allowOnceRef.current = true;
    setSendBlocked(false);
  }, []);

  const checkBeforeSend = useCallback(
    (text: string): boolean => {
      if (!enabled) {
        return true;
      }
      if (allowOnceRef.current) {
        allowOnceRef.current = false;
        setSendBlocked(false);
        return true;
      }
      const found = scanDraftForSecrets(text, true);
      if (found.length === 0) {
        setSendBlocked(false);
        return true;
      }
      setMatches((prev) => (sameMatches(prev, found) ? prev : found));
      setSendBlocked(true);
      return false;
    },
    [enabled],
  );

  const dismissed =
    matches.length > 0 && matches.every((m) => dismissedValues.has(m.value));

  return {
    matches,
    dismissed,
    dismiss,
    sendBlocked,
    checkBeforeSend,
    allowOnce,
  };
}
