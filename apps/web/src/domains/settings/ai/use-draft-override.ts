import { useCallback, useEffect, useState } from "react";

/**
 * Manages a local draft that overrides a server-derived value.
 *
 * Returns `[effectiveValue, setDraft]` where `effectiveValue` is the
 * draft when set, otherwise the server value. The draft auto-clears
 * when the server value converges (e.g. after a save + cache refetch),
 * preventing the UI from briefly reverting to stale server state during
 * the refetch window.
 *
 * Pass `undefined` to clear the draft (revert to server value).
 * Any `T` value — including `null` — is stored as a valid draft.
 */
export function useDraftOverride<T>(serverValue: T): [T, (draft: T | undefined) => void] {
  const [draft, setDraft] = useState<{ value: T } | undefined>(undefined);

  useEffect(() => {
    if (draft !== undefined && serverValue === draft.value) {
      setDraft(undefined);
    }
  }, [serverValue, draft]);

  const effective = draft !== undefined ? draft.value : serverValue;
  const updateDraft = useCallback(
    (d: T | undefined) => setDraft(d === undefined ? undefined : { value: d }),
    [],
  );
  return [effective, updateDraft];
}
