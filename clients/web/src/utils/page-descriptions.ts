/**
 * Authored metadata for the generated navigation manifest
 * (src/navigation-manifest.json, built by scripts/generate-navigation-manifest.ts).
 *
 * Every key in `routes` (src/utils/routes.ts) must appear either here or in
 * INTERNAL_ROUTE_KEYS — a test enforces this. The manifest is consumed by the
 * platform doctor agent to tell users where to find things, so `features`
 * should use end-user vocabulary ("backups", "dark mode"), not internal names.
 */

export interface PageDescription {
  /** One sentence on what a user finds/does on the page. */
  description: string;
  /** Display name; defaults to the settings sidebar label or the title-cased key. */
  label?: string;
  /** Nav grouping; defaults to Settings/Logs/App by key prefix. */
  section?: string;
  /** Keywords a user would search for ("where do I find X"). */
  features?: string[];
  /** Query-param sub-tabs, if the page has them. */
  tabs?: { id: string; query: string }[];
  /**
   * Placeholder names for dynamic segments, when the route builder's argument
   * names differ from the params mounted in routes.tsx (a test enforces the
   * manifest matches the mounted patterns).
   */
  params?: string[];
}

/**
 * Route keys deliberately left out of the manifest: auth/OAuth flows,
 * onboarding, Electron window internals, link builders, redirects, and
 * external/admin surfaces. Not pages the doctor should send users to.
 */
export const INTERNAL_ROUTE_KEYS: ReadonlySet<string> = new Set([
  // Electron window internals
  "about",
  "bundleConfirm",
  "remotePair",
  "quickInput",
  // Path prefix only — bare /assistant/conversations renders NotFound
  "conversations",
  // One-time invite handler — dead end without senderAssistantId/token params
  "connect",
  // Link builders, not pages
  "conversationAtMessage",
  "conversationWithPrompt",
  "logs.usageForSchedule",
  // Auth flows
  "account.root",
  "account.login",
  "account.signup",
  "account.providerSignup",
  "account.providerCallback",
  "account.oauth.popupComplete",
  "account.oauth.complete",
  "account.oauth.desktopComplete",
  // Onboarding
  "welcome",
  "selectAssistant",
  "reviewTerms",
  "onboarding.hosting",
  "onboarding.apiKey",
  "onboarding.privacy",
  "onboarding.prechat",
  "onboarding.hatching",
  "onboarding.research",
  // Redirects and gated/transient settings pages
  "settings.mcp",
  "settings.dangerZone",
  "settings.systemEvents",
  "settings.developer",
  "settings.upgradeCancel",
  "settings.upgradeSuccess",
  // External/admin surfaces
  "admin.root",
  "docs.hostingOptions",
  "docs.legal.privacyPolicy",
  "docs.legal.termsOfUse",
  "docs.legal.dataSharing",
  "docs.legal.prohibitedUse",
  "docs.legal.privacyAndData",
]);

export const PAGE_DESCRIPTIONS: Record<string, PageDescription> = {
  assistant: {
    label: "Chat",
    description:
      "The main chat surface (default/new conversation) where you type a message to your assistant.",
    features: ["chat", "new conversation", "ask assistant", "message", "compose"],
  },
  conversation: {
    label: "Conversation",
    description:
      "A single conversation's chat transcript and composer; supports ?message= to scroll to and highlight a message.",
    features: ["chat", "conversation", "messages", "transcript", "reply", "thread"],
    params: ["conversationId"],
  },
  inspect: {
    label: "Context Inspector",
    description:
      "The LLM context inspector for one conversation, showing the exact context sent to the model with a per-message scope selector and ZIP export.",
    features: ["llm context", "prompt", "context inspector", "tokens", "export zip", "debug"],
  },
  channels: {
    label: "Channels",
    section: "About Assistant",
    description:
      "Connect messaging channels (e.g. Slack, Telegram) and invite people to reach the assistant.",
    features: ["channels", "slack", "telegram", "connect channel", "invite", "messaging"],
  },
  "logs.root": {
    label: "Logs",
    description:
      "Entry point to Logs & Usage; the index renders the Usage view, with sibling tabs for Emails and System Events.",
    features: ["logs", "usage", "cost", "tokens", "analytics", "spend"],
  },
  "logs.usage": {
    label: "Usage",
    description:
      "Inference usage and cost analytics with totals and a breakdown chart, groupable by schedule and filterable by time range (?range=, ?groupBy=).",
    features: ["usage", "inference usage", "cost", "tokens", "breakdown", "spend"],
  },
  "logs.emails": {
    label: "Emails",
    description:
      "Log of emails your assistant sent, with totals and a list of recent emails (platform-hosted only).",
    features: ["emails", "sent emails", "email log", "email history"],
  },
  "logs.systemEvents": {
    label: "System Events",
    description:
      "Feed of system events for a platform-hosted assistant (lifecycle and activity audit trail).",
    features: ["system events", "events", "activity log", "audit", "history"],
  },
  home: {
    label: "Activity",
    description:
      "The Activity page opened on the Notifications tab — a feed of recaps and notifications from your assistant; the Schedules tab lives alongside it (path-based, not ?tab=).",
    features: ["activity", "notifications", "recap", "feed", "home", "updates"],
  },
  "schedules.root": {
    label: "Schedules",
    description:
      "The Activity page opened on the Schedules tab, listing the assistant's scheduled and recurring tasks.",
    features: ["schedules", "scheduled tasks", "recurring tasks", "automations", "reminders"],
  },
  "schedules.detail": {
    label: "Schedule",
    description:
      "The Schedules tab with a specific schedule's drawer focused, for viewing or editing that scheduled task.",
    features: ["schedule", "scheduled task", "edit schedule", "automation"],
  },
  identity: {
    label: "Identity",
    section: "About Assistant",
    description:
      "View and edit the assistant's name, avatar, personality and traits.",
    features: ["identity", "name", "avatar", "personality", "traits", "rename"],
  },
  plugins: {
    label: "Plugins",
    section: "About Assistant",
    description:
      "Catalog to browse and install plugins that extend the assistant (?plugin= deep-links a plugin's detail).",
    features: ["plugins", "install plugin", "plugin catalog", "extensions", "add-ons"],
  },
  skills: {
    label: "Skills",
    section: "About Assistant",
    description:
      "Catalog to add, install and remove skills for the assistant (?skill= opens a specific skill).",
    features: ["skills", "install skill", "add skill", "remove skill", "skill catalog"],
  },
  workspace: {
    label: "Workspace",
    section: "About Assistant",
    description:
      "File browser for the assistant's workspace files and folders.",
    features: ["workspace", "files", "folders", "file browser", "documents", "storage"],
  },
  "contacts.root": {
    label: "Contacts",
    section: "About Assistant",
    description:
      "Contacts and their connected channels (Slack, Telegram, email), plus invite links to connect people.",
    features: ["contacts", "connections", "invite", "address book"],
  },
  "library.root": {
    label: "Library",
    description:
      "The library of the assistant's apps and documents with search, an Import action, and Pinned and Recents sections.",
    features: ["library", "apps", "documents", "pinned", "recents", "import"],
  },
  "library.app": {
    label: "App",
    description: "Detail view for a single library app, with an Open action.",
    features: ["app", "open app", "library app", "launch app"],
    params: ["appId"],
  },
  document: {
    label: "Document",
    description:
      "Full-page viewer for a single document, with a comments panel, PDF rendering and an edit-in-chat path.",
    features: ["document", "view document", "comments", "pdf", "edit document"],
  },
  "settings.root": {
    label: "Settings",
    description:
      "Settings overview; the index renders the General panel directly inside the sidebar-based settings shell.",
    features: ["settings", "preferences", "configuration", "options"],
  },
  "settings.general": {
    description:
      "General settings for theme (dark mode), timezone, compute & resources, software updates, sleep policy and retiring the assistant.",
    features: ["theme", "dark mode", "timezone", "software updates", "sleep policy", "retire assistant", "compute"],
  },
  "settings.ai": {
    description:
      "Configure the language model and connected services — web search, web fetch, email, image generation, text-to-speech and speech-to-text (including provider API keys).",
    features: ["language model", "model", "web search", "image generation", "text-to-speech", "speech-to-text", "api key"],
  },
  "settings.integrations": {
    description:
      "Manage integrations across two tabs: OAuth app connections (default, with filters and search) and MCP servers (?tab=mcp).",
    features: ["integrations", "oauth", "connect app", "mcp", "mcp servers", "enable integration"],
    tabs: [{ id: "mcp", query: "?tab=mcp" }],
  },
  "settings.notifications": {
    description:
      "Notification preferences, including pausing alerts and snoozing with an optional reason.",
    features: ["notifications", "pause alerts", "snooze", "do not disturb", "mute notifications"],
  },
  "settings.keyboardShortcuts": {
    description: "Reference list of keyboard shortcuts for the app.",
    features: ["keyboard shortcuts", "hotkeys", "shortcuts", "key bindings"],
  },
  "settings.sounds": {
    description:
      "Sound settings to enable sound effects and adjust their volume.",
    features: ["sounds", "sound effects", "volume", "mute", "audio"],
  },
  "settings.voice": {
    description:
      "Voice settings for microphone selection, push-to-talk, and conversation timeout for voice mode.",
    features: ["voice", "microphone", "push to talk", "dictation", "speech"],
  },
  "settings.devices": {
    description:
      "Manage self-hosted assistants — the machines/devices running the assistant yourself.",
    features: ["self-hosted assistants", "devices", "self hosting", "local assistant"],
  },
  "settings.privacy": {
    description:
      "Privacy and permission controls including system permissions, trust rules, risk tolerance, biometrics, and Share Analytics / Share Diagnostics toggles.",
    features: ["permissions", "privacy", "trust rules", "risk tolerance", "biometrics", "share analytics", "share diagnostics"],
  },
  "settings.security": {
    description:
      "Account security settings, primarily two-factor authentication (2FA).",
    features: ["security", "two-factor authentication", "2fa", "password", "login"],
  },
  "settings.archive": {
    description:
      "List of archived conversations with the ability to unarchive them.",
    features: ["archive", "archived conversations", "unarchive", "restore conversation"],
  },
  "settings.bookmarks": {
    description:
      "Saved message bookmarks, with an Open link back to the message and a remove action.",
    features: ["bookmarks", "saved messages", "remove bookmark", "starred"],
  },
  "settings.billing": {
    description:
      "Billing and subscription management — plan, upgrade, payment methods, usage, and referrals.",
    features: ["billing", "plan", "upgrade", "payment methods", "referral", "subscription"],
  },
  "settings.community": {
    description:
      "Community links — Vellum is open source; join the community hub and follow on X and YouTube.",
    features: ["community", "open source", "community hub"],
  },
  "settings.debug": {
    description:
      "Debug tools across tabs: General (default) with Backups (view/create/restore), Restart Assistant and Recovery Mode; plus Terminal (?tab=terminal) and Doctor (?tab=doctor).",
    features: ["backups", "restore backup", "create backup", "restart assistant", "recovery mode", "terminal", "doctor"],
    tabs: [
      { id: "terminal", query: "?tab=terminal" },
      { id: "doctor", query: "?tab=doctor" },
    ],
  },
  "settings.advanced": {
    description:
      "Advanced settings for the automatic-update window and the assistant memory toggle (remembering information from past conversations).",
    features: ["advanced", "update window", "automatic updates", "memory", "remember conversations"],
  },
};
