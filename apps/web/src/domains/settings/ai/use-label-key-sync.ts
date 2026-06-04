import { useCallback, useRef } from "react";

import { toKebabCase } from "@/domains/settings/ai/slugify";

/**
 * Encapsulates the "auto-derive key from label" pattern shared by both the
 * profile editor and provider editor modals. When in create mode and the
 * user hasn't manually edited the key field, typing in the label auto-fills
 * the key with a kebab-cased slug. Once the user touches the key field
 * directly, auto-derivation stops.
 *
 * `getDirty()` reports whether the user has manually edited EITHER the label
 * or the key. Callers that pre-fill both fields from another source (e.g. the
 * profile editor seeding Name/Key from the selected model) use it to avoid
 * clobbering user edits. It's separate from the internal key-follows-label
 * tracking so a label edit still drives the auto-derived key.
 *
 * `resetDirty` and `getDirty` are stable (empty deps) and safe in effect
 * dependency arrays. `handleLabelChange` and `handleKeyChange` update when
 * `mode`, `setLabel`, or `setKey` change — both are event handlers, not
 * effect dependencies.
 */
export function useLabelKeySync(
  mode: string,
  setLabel: (value: string) => void,
  setKey: (value: string) => void,
) {
  const keyDirtyRef = useRef(false);
  // True once the user manually edits Name (label) or Key. Distinct from
  // `keyDirtyRef`, which only tracks the key field so a label edit can keep
  // driving the auto-derived key.
  const touchedRef = useRef(false);

  const handleLabelChange = useCallback(
    (newLabel: string) => {
      touchedRef.current = true;
      setLabel(newLabel);
      if (mode === "create" && !keyDirtyRef.current) {
        setKey(toKebabCase(newLabel));
      }
    },
    [mode, setLabel, setKey],
  );

  const handleKeyChange = useCallback(
    (newKey: string) => {
      keyDirtyRef.current = true;
      touchedRef.current = true;
      setKey(newKey);
    },
    [setKey],
  );

  const resetDirty = useCallback(() => {
    keyDirtyRef.current = false;
    touchedRef.current = false;
  }, []);

  const getDirty = useCallback(() => touchedRef.current, []);

  return { handleLabelChange, handleKeyChange, resetDirty, getDirty };
}
