/**
 * Curated catalog of proactive tips — short feature-discovery blurbs surfaced
 * one at a time in the sidebar. Pure data: the consuming hook evaluates
 * `gates` and the selection policy (`tips-selection.ts`) decides which tip
 * shows when.
 */

import { routes } from "@/utils/routes";

export type TipKind = "info"; // future: "action"
export type TipSource = "curated"; // future: "assistant"

export interface TipGates {
  /** Only show inside the Electron desktop shell. */
  requiresElectron?: boolean;
  /** Client feature-flag store key (camelCase, e.g. "voiceMode") that must be on. */
  requiresClientFlag?: string;
  /** Requires the plugins surface — a daemon-version gate resolved by the consuming hook. */
  requiresPluginsSurface?: boolean;
}

export interface Tip {
  id: string;
  kind: TipKind;
  source: TipSource;
  body: string;
  /** Route path only — navigation must never be state-changing. */
  learnMore?: { label: string; to: string };
  gates?: TipGates;
}

export const TIPS_CATALOG: readonly Tip[] = [
  {
    id: "what-are-skills",
    kind: "info",
    source: "curated",
    body: "Skills are how I learn new abilities — there's a catalog of skills you can install.",
    learnMore: { label: "Browse skills", to: routes.skills.root },
  },
  {
    id: "what-are-plugins",
    kind: "info",
    source: "curated",
    body: "Plugins change how I behave — from a personal-finance copilot to a mode that lives in your MacBook notch.",
    learnMore: { label: "Browse plugins", to: routes.plugins },
    gates: { requiresPluginsSurface: true },
  },
  {
    id: "app-builder",
    kind: "info",
    source: "curated",
    body: "Ask me to build you a tracker, dashboard, or calculator — I keep them in your Library.",
  },
  {
    id: "document-editor",
    kind: "info",
    source: "curated",
    body: "I can draft long-form docs in a real editor you can comment on.",
  },
  {
    id: "image-studio",
    kind: "info",
    source: "curated",
    body: "I can create and edit images — backgrounds, retouching, restyling.",
  },
  {
    id: "subagents-workflows",
    kind: "info",
    source: "curated",
    body: "Big job? I can split it across a fleet of parallel background agents.",
  },
  {
    id: "memory-aware",
    kind: "info",
    source: "curated",
    body: "I remember our conversations — ask me what I know about you.",
  },
  {
    id: "voice-mode",
    kind: "info",
    source: "curated",
    body: "You can talk to me — voice mode is in the top right.",
    gates: { requiresClientFlag: "voiceMode" },
  },
  {
    id: "computer-use",
    kind: "info",
    source: "curated",
    body: "On this Mac I can control apps and the desktop for you.",
    gates: { requiresElectron: true },
  },
  {
    id: "quick-input",
    kind: "info",
    source: "curated",
    body: "Press Cmd+Shift+/ anywhere to send me a quick message.",
    gates: { requiresElectron: true, requiresClientFlag: "quickInput" },
  },
  {
    id: "personalize-me",
    kind: "info",
    source: "curated",
    body: "You can give me a custom avatar, sounds, and theme.",
    learnMore: { label: "Personalize", to: routes.identity },
  },
  {
    id: "import-chatgpt",
    kind: "info",
    source: "curated",
    body: "Coming from ChatGPT? I can import your history so I know you from day one.",
  },
  {
    id: "daily-schedule",
    kind: "info",
    source: "curated",
    body: "I can run things on a schedule — try a daily briefing or a weekly summary.",
  },
];
