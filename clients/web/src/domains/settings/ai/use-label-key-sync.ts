import { useCallback, useRef } from "react";

import { toKebabCase } from "@/domains/settings/ai/slugify";

/**
 * Encapsulates the "derive key from label" pattern of the profile editor. A
 * profile's key is never shown or edited: in create mode it is the kebab-cased
 * slug of whatever the Name field holds, so typing a name keeps the key in
 * step. Editing an existing profile leaves its key alone, since renaming the
 * stored record is not something this form does.
 *
 * `getDirty()` reports whether the user has manually edited the Name. Callers
 * that pre-fill it from another source (the editor seeding Name from the
 * selected model) use it to avoid clobbering user edits.
 *
 * `resetDirty` and `getDirty` are stable (empty deps) and safe in effect
 * dependency arrays. `handleLabelChange` updates when `mode`, `setLabel`, or
 * `setKey` change; it is an event handler, not an effect dependency.
 */
export function useLabelKeySync(
  mode: string,
  setLabel: (value: string) => void,
  setKey: (value: string) => void,
) {
  const touchedRef = useRef(false);

  const handleLabelChange = useCallback(
    (newLabel: string) => {
      touchedRef.current = true;
      setLabel(newLabel);
      if (mode === "create") {
        setKey(toKebabCase(newLabel));
      }
    },
    [mode, setLabel, setKey],
  );

  const resetDirty = useCallback(() => {
    touchedRef.current = false;
  }, []);

  const getDirty = useCallback(() => touchedRef.current, []);

  return { handleLabelChange, resetDirty, getDirty };
}
