/** Pure helper functions for the chat composer.
 *
 *  Separated from the React component (`ChatComposer`) so they can be
 *  unit-tested without a DOM or component render cycle. */

// ---------------------------------------------------------------------------
// Keyboard policy
// ---------------------------------------------------------------------------

export interface ComposerKeyDownPolicy {
  input: string;
  canSendAttachments: boolean;
  hasStagedQuotes?: boolean;
  sendDisabled: boolean;
  attachmentsUploadingCount: number;
  cmdEnterMode: boolean;
}

/**
 * Pure-logic mirror of the textarea `onKeyDown` policy. Returns whether the
 * Enter keypress should submit the form. The production handler delegates to
 * this helper to keep behavior in lockstep.
 *
 * Returns:
 *   - `"ignore"`: the event is not Enter-without-shift, IME composition, or
 *     pointer is coarse — let the browser handle the keypress.
 *   - `"submit"`: caller should `preventDefault()` and invoke `onSubmit`.
 *   - `"prevent"`: caller should `preventDefault()` but NOT submit (sendDisabled,
 *     uploading attachments, or no content).
 */
export function shouldSubmitOnEnter(
  event: {
    key: string;
    shiftKey: boolean;
    metaKey: boolean;
    ctrlKey: boolean;
    isComposing: boolean;
    keyCode: number;
  },
  isPointerCoarse: boolean,
  policy: ComposerKeyDownPolicy,
): "ignore" | "submit" | "prevent" {
  if (event.key !== "Enter" || event.shiftKey) {
    return "ignore";
  }
  // Don't intercept IME composition (CJK input confirmation)
  if (event.isComposing || event.keyCode === 229) {
    return "ignore";
  }
  // Coarse primary pointer = phone/tablet; fine = mouse/trackpad.
  // Touch-screen laptops (Surface, etc.) report "fine" and keep desktop
  // Enter-to-send behavior.
  if (isPointerCoarse) {
    return "ignore";
  }
  // Cmd+Enter mode: only Cmd+Enter (Mac) or Ctrl+Enter (Win/Linux) submits;
  // bare Enter inserts a newline.
  if (policy.cmdEnterMode) {
    if (!event.metaKey && !event.ctrlKey) {
      return "ignore";
    }
  }
  const hasContent =
    !!policy.input.trim() ||
    policy.canSendAttachments ||
    policy.hasStagedQuotes === true;
  if (
    hasContent &&
    !policy.sendDisabled &&
    policy.attachmentsUploadingCount === 0
  ) {
    return "submit";
  }
  return "prevent";
}

// ---------------------------------------------------------------------------
// Ghost-suggestion overlay policy
// ---------------------------------------------------------------------------

interface GhostSuffixPolicy {
  pointerCoarse: boolean;
  suggestion: string | null;
  input: string;
  hasAttachments: boolean;
}

/**
 * Returns the visible suffix of an autocomplete suggestion to render as
 * ghost text behind the textarea, or `null` to render no ghost.
 *
 * Suppressed when the primary pointer is coarse (touch devices): the only
 * acceptance gesture is `Tab`, which is not present on iOS/Android soft
 * keyboards, so rendering the overlay there is purely visual noise — and
 * because the underlying textarea is `rows={1}`, multi-line ghost text
 * gets clipped on narrow viewports.
 */
export function computeGhostSuffix(policy: GhostSuffixPolicy): string | null {
  if (policy.pointerCoarse) return null;
  if (!policy.suggestion || policy.hasAttachments) return null;
  if (policy.suggestion.startsWith(policy.input)) {
    return policy.suggestion.slice(policy.input.length) || null;
  }
  if (!policy.input) return policy.suggestion;
  return null;
}
