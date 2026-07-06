/**
 * Centralized URL registry for app-internal navigation.
 *
 * All paths are absolute app paths — pass them directly to `<Link to>`,
 * `navigate()`, `window.location.href`, and pathname comparisons. Normal app
 * modes run the router at `/`; remote-gateway mode may add a public ingress
 * prefix as the React Router basename while keeping these app paths unchanged.
 *
 * Captured paths (e.g. inputs to `sanitizeReturnTo`, query-string round-trips)
 * are values, not constants — do NOT rewrite those through this module.
 */

import { isElectron } from "@/runtime/is-electron";

const r = <const T extends string>(path: T): T => path;

const dyn = (parent: string, id: string): string => `${parent}/${id}`;
const LOCAL_ADMIN_ORIGIN = "http://localhost:3000";
const LOGS_USAGE_PATH = r("/assistant/logs/usage");

/**
 * Search param the chat transcript reads on load to scroll to and highlight a
 * specific message (e.g. the "Open" button on a saved bookmark). Shared by the
 * link producer (settings) and the consumer (chat).
 */
export const SCROLL_TO_MESSAGE_PARAM = "message";

export const routes = {
  assistant: r("/assistant"),
  /**
   * Standalone About page. Lives under `/assistant/*` so it falls inside
   * `clients/web/vite.config.ts`'s `base: "/assistant/"` and Vite's SPA
   * fallback serves it in dev. Declared as a sibling of `/assistant`
   * in `routes.tsx` rather than a child, so it bypasses the app's auth
   * middleware and `RootLayout` — it's metadata, not the app.
   *
   * Mounted from the Electron host (`clients/macos/src/main/about.ts`)
   * into a frameless BrowserWindow; the route is also reachable from
   * the web build, where the runtime wrapper degrades to a "—" fallback.
   */
  about: r("/assistant/about"),
  /**
   * Bundle confirmation page. Standalone like About — sits under
   * `/assistant/*` for Vite SPA fallback but outside the auth tree so
   * bundles can be confirmed before sign-in. Mounted by the Electron
   * host (`clients/macos/src/main/bundle-confirmation.ts`) into a
   * dedicated BrowserWindow.
   */
  bundleConfirm: r("/assistant/bundle/confirm"),
  remotePair: r("/assistant/pair"),
  quickInput: r("/assistant/quick-input"),
  conversations: r("/assistant/conversations"),
  conversation: (key: string) => dyn(r("/assistant/conversations"), key),
  /** Conversation URL that asks the transcript to scroll to + highlight a
   *  specific message on load. */
  conversationAtMessage: (conversationId: string, messageId: string) =>
    `${dyn(r("/assistant/conversations"), conversationId)}?${SCROLL_TO_MESSAGE_PARAM}=${encodeURIComponent(messageId)}`,
  /** Conversation URL that auto-sends `prompt` on load via the `?prompt=`
   *  pathway (see `use-auto-send-effects.ts`). Lets another surface (app
   *  viewer, document feedback) relay a message into a conversation. An
   *  optional `relayToken` makes the URL unique so identical prompts relayed
   *  back-to-back still re-fire the auto-send (the dedupe keys on the token). */
  conversationWithPrompt: (
    conversationId: string,
    prompt: string,
    relayToken?: string,
  ) => {
    const base = `${dyn(r("/assistant/conversations"), conversationId)}?prompt=${encodeURIComponent(prompt)}`;
    return relayToken ? `${base}&relay=${encodeURIComponent(relayToken)}` : base;
  },
  /**
   * LLM-context inspector for a single conversation. The conversation id
   * lives in the URL path so the link is sharable and the page can route
   * directly to its data without leaning on captured search params.
   */
  inspect: (conversationId: string) =>
    `${dyn(r("/assistant/conversations"), conversationId)}/inspect`,
  logs: {
    root: r("/assistant/logs"),
    trace: r("/assistant/logs/trace"),
    usage: LOGS_USAGE_PATH,
    usageForSchedule: (scheduleId: string) => {
      const params = new URLSearchParams({
        range: "7d",
        groupBy: "schedule",
        scheduleId,
      });
      return `${LOGS_USAGE_PATH}?${params.toString()}`;
    },
    emails: r("/assistant/logs/emails"),
    systemEvents: r("/assistant/logs/system-events"),
  },
  account: {
    root: r("/account"),
    login: r("/account/login"),
    signup: r("/account/signup"),
    providerSignup: r("/account/provider/signup"),
    providerCallback: r("/account/provider/callback"),
    oauth: {
      popupComplete: r("/account/oauth/popup-complete"),
      complete: r("/account/oauth/complete"),
      desktopComplete: r("/account/oauth/desktop-complete"),
    },
  },

  welcome: r("/assistant/welcome"),
  selectAssistant: r("/assistant/select-assistant"),
  reviewTerms: r("/assistant/review-terms"),

  onboarding: {
    hosting: r("/assistant/onboarding/hosting"),
    apiKey: r("/assistant/onboarding/api-key"),
    privacy: r("/assistant/onboarding/privacy"),
    prechat: r("/assistant/onboarding/prechat"),
    hatching: r("/assistant/onboarding/hatching"),
    // SPIKE — research-onboarding front door. Reachable on demand behind the
    // default-off research-onboarding flag (see routes.tsx).
    research: r("/assistant/onboarding/research"),
  },

  home: r("/assistant/home"),
  /**
   * Schedules surface — the same Activity page as `home`, opened with the
   * Schedules tab active. `detail` deep-links a single schedule's drawer.
   * Path-based (not `?tab=`) so the tab and the focused schedule are
   * bookmarkable and shareable. Both render `HomePageRoute`, which derives
   * the active tab + selected schedule from the URL.
   */
  schedules: {
    root: r("/assistant/schedules"),
    detail: (scheduleId: string) =>
      dyn(r("/assistant/schedules"), scheduleId),
  },
  identity: r("/assistant/identity"),
  plugins: r("/assistant/plugins"),
  skills: r("/assistant/skills"),
  workspace: r("/assistant/workspace"),
  library: {
    root: r("/assistant/library"),
    app: (slug: string) => dyn(r("/assistant/library"), slug),
  },

  document: (surfaceId: string) => dyn(r("/assistant/documents"), surfaceId),

  connect: r("/assistant/connect"),

  channels: r("/assistant/channels"),

  contacts: {
    root: r("/assistant/contacts"),
  },

  settings: {
    root: r("/assistant/settings"),
    general: r("/assistant/settings/general"),
    ai: r("/assistant/settings/ai"),
    integrations: r("/assistant/settings/integrations"),
    notifications: r("/assistant/settings/notifications"),
    keyboardShortcuts: r("/assistant/settings/keyboard-shortcuts"),
    sounds: r("/assistant/settings/sounds"),
    voice: r("/assistant/settings/voice"),
    devices: r("/assistant/settings/devices"),
    privacy: r("/assistant/settings/privacy"),
    archive: r("/assistant/settings/archive"),
    bookmarks: r("/assistant/settings/bookmarks"),
    billing: r("/assistant/settings/billing"),
    community: r("/assistant/settings/community"),
    debug: r("/assistant/settings/debug"),
    developer: r("/assistant/settings/developer"),
    mcp: r("/assistant/settings/mcp"),
    advanced: r("/assistant/settings/advanced"),
    dangerZone: r("/assistant/settings/danger-zone"),
    systemEvents: r("/assistant/settings/system-events"),
    upgradeCancel: r("/assistant/settings/billing/upgrade/cancel"),
    upgradeSuccess: r("/assistant/settings/billing/upgrade/success"),
  },

  admin: {
    root: r("/admin"),
  },

  docs: {
    hostingOptions: r("/docs/hosting-options"),
    legal: {
      privacyPolicy: r("/docs/privacy-policy"),
      termsOfUse: r("/docs/vellum-terms-of-use"),
      dataSharing: r("/docs/data-sharing"),
      prohibitedUse: r("/docs/prohibited-use"),
      privacyAndData: r("/docs/trust-security/privacy-and-data"),
    },
  },
} as const;

/**
 * Path prefixes of the "About Assistant" section — the routes mounted under
 * `IntelligenceLayout`'s tab bar. Sub-paths (e.g. `/assistant/plugins/:name`)
 * count as inside the section.
 */
const ABOUT_ASSISTANT_PATHS: readonly string[] = [
  routes.identity,
  routes.plugins,
  routes.skills,
  routes.workspace,
  routes.contacts.root,
  routes.channels,
];

/** Whether `pathname` falls inside the About Assistant section. */
export function isAboutAssistantPath(pathname: string): boolean {
  return ABOUT_ASSISTANT_PATHS.some(
    (path) => pathname === path || pathname.startsWith(`${path}/`),
  );
}

/**
 * Whether `pathname` falls inside the conversation *area* — the `/assistant`
 * index (draft conversation) or anything under `/assistant/conversations/`,
 * including subroutes like the inspector
 * (`/assistant/conversations/:id/inspect`). Use for "is the user working in
 * the context of a conversation" semantics (e.g. the sidebar's active-row
 * highlight). For "is the chat composer on screen" semantics use
 * {@link isConversationChatPath} — the inspector has no composer.
 */
export function isConversationPath(pathname: string): boolean {
  return (
    pathname === routes.assistant ||
    pathname === `${routes.assistant}/` ||
    pathname.startsWith(`${routes.conversations}/`)
  );
}

/**
 * Whether `pathname` mounts the conversation chat surface — the `/assistant`
 * index (draft conversation, via `ConversationRedirect`) or exactly
 * `/assistant/conversations/:id` — i.e. a route where `ChatPage` renders the
 * active conversation's composer. Stricter than {@link isConversationPath}:
 * conversation subroutes such as the inspector
 * (`/assistant/conversations/:id/inspect`) are excluded because `InspectPage`
 * replaces `ChatPage` and has no composer.
 */
export function isConversationChatPath(pathname: string): boolean {
  if (pathname === routes.assistant || pathname === `${routes.assistant}/`) {
    return true;
  }
  const prefix = `${routes.conversations}/`;
  if (!pathname.startsWith(prefix)) {
    return false;
  }
  // Exactly one path segment after the prefix (a bare conversation id,
  // tolerating a trailing slash) — deeper segments are other pages.
  const rest = pathname.slice(prefix.length).replace(/\/+$/, "");
  return rest.length > 0 && !rest.includes("/");
}

const WWW_DOMAIN = "vellum.ai";

/** Full external URL for a legal/docs page hosted on the marketing site. */
export function legalUrl(
  path: (typeof routes.docs.legal)[keyof typeof routes.docs.legal],
): string {
  return docsUrl(path);
}

/** Full external URL for a docs page hosted on the marketing site. */
export function docsUrl(path: string): string {
  return `https://${WWW_DOMAIN}${path}`;
}

/** URL for the platform-hosted admin UI. */
export function adminUrl(): string {
  if (isElectron()) {
    const config = (
      window as unknown as { __VELLUM_CONFIG__?: { webUrl?: string } }
    ).__VELLUM_CONFIG__;
    return `${config?.webUrl ?? window.location.origin}${routes.admin.root}`;
  }
  if (import.meta.env.DEV) {
    return `${LOCAL_ADMIN_ORIGIN}${routes.admin.root}`;
  }
  return routes.admin.root;
}
