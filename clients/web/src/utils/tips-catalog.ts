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
  /** Client feature-flag store key (camelCase, e.g. "quickInput") that must be on. */
  requiresClientFlag?: string;
  /**
   * Assistant feature-flag store key (camelCase, e.g. "voiceMode") that must be
   * on — resolved via useAssistantFeatureFlagStore by the consuming hook.
   */
  requiresAssistantFlag?: string;
  /** Requires the plugins surface — a daemon-version gate resolved by the consuming hook. */
  requiresPluginsSurface?: boolean;
}

export interface Tip {
  id: string;
  kind: TipKind;
  source: TipSource;
  /** Tiny category label, stored capitalized-normal — the card uppercases it via CSS. */
  eyebrow: string;
  /** Short bold headline, 2-5 words. */
  title: string;
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
    eyebrow: "Skills",
    title: "Learn new skills",
    body: "Install skills from the catalog to teach me new abilities.",
    learnMore: { label: "Browse skills", to: routes.skills.root },
  },
  {
    id: "what-are-plugins",
    kind: "info",
    source: "curated",
    eyebrow: "Plugins",
    title: "Change how I behave",
    body: "From a personal-finance copilot to a mode that lives in your MacBook notch.",
    learnMore: { label: "Browse plugins", to: routes.plugins },
    gates: { requiresPluginsSurface: true },
  },
  {
    id: "app-builder",
    kind: "info",
    source: "curated",
    eyebrow: "Apps",
    title: "Build personal tools",
    body: "Ask me for a tracker, dashboard, or calculator — they live in your Library.",
  },
  {
    id: "document-editor",
    kind: "info",
    source: "curated",
    eyebrow: "Docs",
    title: "Draft real documents",
    body: "I write long-form docs in an editor you can comment on.",
  },
  {
    id: "image-studio",
    kind: "info",
    source: "curated",
    eyebrow: "Images",
    title: "Create and edit images",
    body: "Backgrounds, retouching, restyling — just describe the change.",
  },
  {
    id: "subagents-workflows",
    kind: "info",
    source: "curated",
    eyebrow: "Automation",
    title: "Split up big jobs",
    body: "I can fan work out across a fleet of parallel background agents.",
  },
  {
    id: "memory-aware",
    kind: "info",
    source: "curated",
    eyebrow: "Memory",
    title: "I remember you",
    body: "Our conversations stick — ask me what I know about you.",
  },
  {
    id: "voice-mode",
    kind: "info",
    source: "curated",
    eyebrow: "Voice",
    title: "Talk instead of type",
    body: "Voice mode is in the top right — just start speaking.",
    gates: { requiresAssistantFlag: "voiceMode" },
  },
  {
    id: "computer-use",
    kind: "info",
    source: "curated",
    eyebrow: "Desktop",
    title: "Let me use your Mac",
    body: "On this Mac I can control apps and the desktop for you.",
    gates: { requiresElectron: true },
  },
  {
    id: "quick-input",
    kind: "info",
    source: "curated",
    eyebrow: "Desktop",
    title: "Message me anywhere",
    body: "Press Cmd+Shift+/ to send me a quick message from any app.",
    gates: { requiresElectron: true, requiresClientFlag: "quickInput" },
  },
  {
    id: "personalize-me",
    kind: "info",
    source: "curated",
    eyebrow: "Personalize",
    title: "Make me yours",
    body: "Pick a custom avatar, sounds, and theme.",
    learnMore: { label: "Personalize", to: routes.identity },
  },
  {
    id: "import-chatgpt",
    kind: "info",
    source: "curated",
    eyebrow: "Memory",
    title: "Bring your history",
    body: "Coming from ChatGPT? I can import it so I know you from day one.",
  },
  {
    id: "daily-schedule",
    kind: "info",
    source: "curated",
    eyebrow: "Automation",
    title: "Put me on a schedule",
    body: "Try a daily briefing or a weekly summary — I'll run them on time.",
  },
  {
    id: "channels",
    kind: "info",
    source: "curated",
    eyebrow: "Channels",
    title: "Reach me anywhere",
    body: "I'm also on Telegram, Slack, WhatsApp, and the phone — not just this app.",
    learnMore: { label: "View channels", to: routes.channels },
  },
  {
    id: "email-calendar",
    kind: "info",
    source: "curated",
    eyebrow: "Integrations",
    title: "Hand me your inbox",
    body: "Once connected, I can read, draft, and triage email — and prep you for meetings.",
    learnMore: { label: "Connect", to: routes.settings.integrations },
  },
  {
    id: "meet-contacts",
    kind: "info",
    source: "curated",
    eyebrow: "Contacts",
    title: "Introduce your people",
    body: "Add the people you work with — I can manage channels and access per person.",
    learnMore: { label: "Add contacts", to: routes.contacts.root },
  },
  {
    id: "watchers",
    kind: "info",
    source: "curated",
    eyebrow: "Automation",
    title: "I can keep watch",
    body: "I'll monitor your inbox or a Slack channel and only ping you when it matters.",
  },
  {
    id: "coding-agents",
    kind: "info",
    source: "curated",
    eyebrow: "Coding",
    title: "Delegate your code",
    body: "I can run coding agents like Claude Code and Codex on your projects.",
  },
  {
    id: "mcp-servers",
    kind: "info",
    source: "curated",
    eyebrow: "Power tools",
    title: "Bring your own tools",
    body: "Plug your own MCP servers into me to extend what I can reach.",
    learnMore: { label: "MCP settings", to: routes.settings.mcp },
  },
  {
    id: "model-picker",
    kind: "info",
    source: "curated",
    eyebrow: "Models",
    title: "Change how I think",
    body: "Pick a different model or effort level from the composer settings menu.",
  },
];
