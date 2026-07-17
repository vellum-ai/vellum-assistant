import { useCallback, useEffect, useState } from "react";

/**
 * Tracks whether the first-run "what is this graph" intro banner has been
 * dismissed, persisted per assistant in localStorage so it stays gone across
 * reloads. Keyed per-assistant (not globally) so a user's second assistant
 * still gets the explainer the first time its graph is opened.
 *
 * When storage is unavailable (private mode / blocked), reads resolve to
 * "dismissed" so we never nag on every load with a dismissal that can't stick.
 */
const KEY_PREFIX = "vellum:memoryGraph:introDismissed:";

function storageKey(assistantId: string): string {
  return `${KEY_PREFIX}${assistantId}`;
}

function readDismissed(assistantId: string): boolean {
  if (!assistantId) {
    return true;
  }
  try {
    return window.localStorage.getItem(storageKey(assistantId)) === "1";
  } catch {
    return true;
  }
}

export function useGraphIntroDismissed(
  assistantId: string,
): [boolean, () => void] {
  const [dismissed, setDismissed] = useState(() => readDismissed(assistantId));

  // Re-read when the active assistant changes — the identity pane reuses this
  // component instance across assistant switches.
  useEffect(() => {
    setDismissed(readDismissed(assistantId));
  }, [assistantId]);

  const dismiss = useCallback(() => {
    setDismissed(true);
    try {
      window.localStorage.setItem(storageKey(assistantId), "1");
    } catch {
      // Best-effort; the in-memory state above still hides it for this session.
    }
  }, [assistantId]);

  return [dismissed, dismiss];
}
