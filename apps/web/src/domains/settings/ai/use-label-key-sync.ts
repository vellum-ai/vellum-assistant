import { useCallback, useRef } from "react";

import { toKebabCase } from "@/domains/settings/ai/slugify";

/**
 * Encapsulates the "auto-derive key from label" pattern shared by both the
 * profile editor and provider editor modals. When in create mode and the
 * user hasn't manually edited the key field, typing in the label auto-fills
 * the key with a kebab-cased slug. Once the user touches the key field
 * directly, auto-derivation stops.
 *
 * `resetDirty` is stable (empty deps) and safe in dependency arrays.
 * `handleLabelChange` and `handleKeyChange` update when `mode` or `setKey`
 * change, which is fine — they aren't used in effect dependency arrays.
 */
export function useLabelKeySync(
  mode: string,
  setKey: (value: string) => void,
) {
  const keyDirtyRef = useRef(false);

  const handleLabelChange = useCallback(
    (newLabel: string, setLabel: (value: string) => void) => {
      setLabel(newLabel);
      if (mode === "create" && !keyDirtyRef.current) {
        setKey(toKebabCase(newLabel));
      }
    },
    [mode, setKey],
  );

  const handleKeyChange = useCallback(
    (newKey: string) => {
      keyDirtyRef.current = true;
      setKey(newKey);
    },
    [setKey],
  );

  const resetDirty = useCallback(() => {
    keyDirtyRef.current = false;
  }, []);

  return { keyDirtyRef, handleLabelChange, handleKeyChange, resetDirty };
}
