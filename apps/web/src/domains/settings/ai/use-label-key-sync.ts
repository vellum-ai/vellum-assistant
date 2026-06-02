import { useRef } from "react";

import { toKebabCase } from "@/domains/settings/ai/slugify";

/**
 * Encapsulates the "auto-derive key from label" pattern shared by both the
 * profile editor and provider editor modals. When in create mode and the
 * user hasn't manually edited the key field, typing in the label auto-fills
 * the key with a kebab-cased slug. Once the user touches the key field
 * directly, auto-derivation stops.
 *
 * Returns `handleLabelChange` and `handleKeyChange` wrappers that
 * coordinate the dirty-tracking ref with the caller's state setters.
 */
export function useLabelKeySync(
  mode: string,
  setKey: (value: string) => void,
) {
  const keyDirty = useRef(false);

  function handleLabelChange(
    newLabel: string,
    setLabel: (value: string) => void,
  ) {
    setLabel(newLabel);
    if (mode === "create" && !keyDirty.current) {
      setKey(toKebabCase(newLabel));
    }
  }

  function handleKeyChange(newKey: string) {
    keyDirty.current = true;
    setKey(newKey);
  }

  function resetDirty() {
    keyDirty.current = false;
  }

  return { keyDirty, handleLabelChange, handleKeyChange, resetDirty };
}
