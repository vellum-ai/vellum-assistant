import { useEffect, useState } from "react";

/**
 * Manages a local draft that overrides a server-derived value.
 *
 * Returns `[effectiveValue, setDraft]` where `effectiveValue` is the
 * draft when set, otherwise the server value. The draft auto-clears
 * when the server value converges (e.g. after a save + cache refetch),
 * preventing the UI from briefly reverting to stale server state during
 * the refetch window.
 */
export function useDraftOverride<T>(serverValue: T): [T, (draft: T | null) => void] {
  const [draft, setDraft] = useState<T | null>(null);

  useEffect(() => {
    if (draft !== null && serverValue === draft) {
      setDraft(null);
    }
  }, [serverValue, draft]);

  const effective = draft ?? serverValue;
  return [effective, setDraft];
}
