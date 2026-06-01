/**
 * Prior AI assistant catalog for the PreChat onboarding screen.
 *
 * Follows the same shape as `prechat-tools.ts`. The order here is
 * significant -- the screen renders assistants in this order.
 *
 * `logoSrc` points to SVG icons under `/images/prior-assistants/`.
 *
 * `logoSrcDark` is an optional alternate asset shown in dark mode.
 *
 * For the `stripOtherPrefix` helper (stripping `"other:"` from custom
 * entries, deduping, and sorting), reuse the identical implementation
 * exported from `prechat-tools.ts`.
 */

import { publicAsset } from "@/utils/public-asset";

export interface PreChatPriorAssistantItem {
  id: string;
  label: string;
  logoSrc: string | null;
  logoSrcDark?: string;
}

export const PRECHAT_PRIOR_ASSISTANTS: PreChatPriorAssistantItem[] = [
  { id: "chatgpt", label: "ChatGPT", logoSrc: publicAsset("/images/prior-assistants/chatgpt.svg") },
  { id: "claude", label: "Claude", logoSrc: publicAsset("/images/prior-assistants/claude.svg") },
  { id: "openclaw", label: "OpenClaw", logoSrc: publicAsset("/images/prior-assistants/openclaw.png") },
  { id: "hermes", label: "Hermes", logoSrc: publicAsset("/images/prior-assistants/hermes.png") },
  { id: "manus", label: "Manus", logoSrc: publicAsset("/images/prior-assistants/manus.svg") },
  { id: "gemini", label: "Gemini", logoSrc: publicAsset("/images/prior-assistants/gemini.svg") },
  { id: "copilot", label: "Copilot", logoSrc: publicAsset("/images/prior-assistants/copilot.svg") },
];
