/**
 * Prior AI assistant catalog for the PreChat onboarding screen.
 *
 * Follows the same shape as `prechat-tools.ts`. The order here is
 * significant -- the screen renders assistants in this order.
 *
 * `logoSrc` is `null` for all entries initially -- the tile component
 * falls back to initials. Logo assets can be added as a follow-up.
 *
 * `logoSrcDark` is an optional alternate asset shown in dark mode.
 *
 * For the `stripOtherPrefix` helper (stripping `"other:"` from custom
 * entries, deduping, and sorting), reuse the identical implementation
 * exported from `prechat-tools.ts`.
 */

export interface PreChatPriorAssistantItem {
  id: string;
  label: string;
  logoSrc: string | null;
  logoSrcDark?: string;
}

export const PRECHAT_PRIOR_ASSISTANTS: PreChatPriorAssistantItem[] = [
  { id: "chatgpt", label: "ChatGPT", logoSrc: null },
  { id: "claude", label: "Claude", logoSrc: null },
  { id: "openclaw", label: "OpenClaw", logoSrc: null },
  { id: "hermes", label: "Hermes", logoSrc: null },
  { id: "manus", label: "Manus", logoSrc: null },
  { id: "gemini", label: "Gemini", logoSrc: null },
  { id: "copilot", label: "Copilot", logoSrc: null },
];
