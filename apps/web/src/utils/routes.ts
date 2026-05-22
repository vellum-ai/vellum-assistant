/**
 * Centralized URL registry for app-internal navigation.
 *
 * All paths are absolute browser paths — pass them directly to
 * `<Link to>`, `navigate()`, `window.location.href`, and pathname
 * comparisons. No React Router basename is in play; the router runs
 * at `/` and matches these paths as-is.
 *
 * Captured paths (e.g. inputs to `sanitizeReturnTo`, query-string round-trips)
 * are values, not constants — do NOT rewrite those through this module.
 */

const r = <const T extends string>(path: T): T => path;

const dyn = (parent: string, id: string): string => `${parent}/${id}`;
const LOCAL_ADMIN_ORIGIN = "http://localhost:3000";

export const routes = {
  assistant: r("/assistant"),
  conversation: (key: string) => dyn(r("/assistant/conversations"), key),
  inspect: r("/assistant/inspect"),
  logs: {
    root: r("/assistant/logs"),
    trace: r("/assistant/logs/trace"),
    usage: r("/assistant/logs/usage"),
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
      desktopComplete: r("/account/oauth/desktop-complete"),
    },
  },

  onboarding: {
    privacy: r("/assistant/onboarding/privacy"),
    prechat: r("/assistant/onboarding/prechat"),
    hatching: r("/assistant/onboarding/hatching"),
  },

  home: r("/assistant/home"),
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

  contacts: {
    root: r("/assistant/contacts"),
  },

  settings: {
    root: r("/assistant/settings"),
    general: r("/assistant/settings/general"),
    ai: r("/assistant/settings/ai"),
    integrations: r("/assistant/settings/integrations"),
    schedules: r("/assistant/settings/schedules"),
    notifications: r("/assistant/settings/notifications"),
    sounds: r("/assistant/settings/sounds"),
    voice: r("/assistant/settings/voice"),
    devices: r("/assistant/settings/devices"),
    privacy: r("/assistant/settings/privacy"),
    archive: r("/assistant/settings/archive"),
    billing: r("/assistant/settings/billing"),
    community: r("/assistant/settings/community"),
    debug: r("/assistant/settings/debug"),
    developer: r("/assistant/settings/developer"),
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
    legal: {
      privacyPolicy: r("/docs/privacy-policy"),
      termsOfUse: r("/docs/vellum-terms-of-use"),
      dataSharing: r("/docs/data-sharing"),
      prohibitedUse: r("/docs/prohibited-use"),
      privacyAndData: r("/docs/trust-security/privacy-and-data"),
    },
  },
} as const;

const WWW_DOMAIN = "vellum.ai";

/** Full external URL for a legal/docs page hosted on the marketing site. */
export function legalUrl(
  path: (typeof routes.docs.legal)[keyof typeof routes.docs.legal],
): string {
  return `https://${WWW_DOMAIN}${path}`;
}

/** URL for the platform-hosted admin UI. */
export function adminUrl(): string {
  return import.meta.env.DEV
    ? `${LOCAL_ADMIN_ORIGIN}${routes.admin.root}`
    : routes.admin.root;
}
