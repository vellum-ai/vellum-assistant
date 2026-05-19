/**
 * Centralized URL registry for app-internal navigation.
 *
 * All paths are relative to the router basename (`/assistant`). Use them
 * directly with `<Link to>`, `navigate()`, and `pushRoute()`.
 *
 * For full browser paths (e.g. `window.location.href` redirects), prepend
 * `BASENAME`: `BASENAME + routes.home` → `"/assistant/home"`.
 *
 * Captured paths (e.g. inputs to `sanitizeReturnTo`, query-string round-trips)
 * are values, not constants — do NOT rewrite those through this module.
 */

/** The React Router basename — the prefix stripped from/applied to all URLs. */
export const BASENAME = "/assistant";

const r = <const T extends string>(path: T): T => path;

const dyn = (parent: string, id: string): string => `${parent}/${id}`;

export const routes = {
  root: r("/"),
  inspect: r("/inspect"),
  logs: {
    root: r("/logs"),
    trace: r("/logs/trace"),
    usage: r("/logs/usage"),
    emails: r("/logs/emails"),
    systemEvents: r("/logs/system-events"),
  },
  uiGallery: r("/ui-gallery"),
  login: r("/account/login"),
  signup: r("/account/signup"),
  logout: r("/logout"),

  account: {
    root: r("/account"),
    login: r("/account/login"),
    signup: r("/account/signup"),
    providerSignup: r("/account/provider/signup"),
    providerCallback: r("/account/provider/callback"),
    oauth: {
      popupComplete: r("/account/oauth/popup-complete"),
    },
  },

  onboarding: {
    privacy: r("/onboarding/privacy"),
    prechat: r("/onboarding/prechat"),
    hatching: r("/onboarding/hatching"),
  },

  home: r("/home"),
  identity: r("/identity"),
  workspace: r("/workspace"),
  library: {
    root: r("/library"),
    app: (slug: string) => dyn(r("/library"), slug),
  },

  contacts: {
    root: r("/contacts"),
    detail: (id: string) => dyn(r("/contacts"), id),
  },

  settings: {
    root: r("/settings"),
    general: r("/settings/general"),
    ai: r("/settings/ai"),
    integrations: r("/settings/integrations"),
    schedules: r("/settings/schedules"),
    notifications: r("/settings/notifications"),
    sounds: r("/settings/sounds"),
    voice: r("/settings/voice"),
    devices: r("/settings/devices"),
    privacy: r("/settings/privacy"),
    archive: r("/settings/archive"),
    billing: r("/settings/billing"),
    community: r("/settings/community"),
    debug: r("/settings/debug"),
    developer: r("/settings/developer"),
    advanced: r("/settings/advanced"),
    dangerZone: r("/settings/danger-zone"),
    systemEvents: r("/settings/system-events"),
    upgradeCancel: r("/settings/billing/upgrade/cancel"),
    upgradeSuccess: r("/settings/billing/upgrade/success"),
  },

  admin: {
    root: r("/admin"),
    assistants: r("/admin/assistants"),
    assistant: (id: string) => dyn(r("/admin/assistants"), id),
    users: r("/admin/users"),
    user: (id: string) => dyn(r("/admin/users"), id),
    organizations: r("/admin/organizations"),
    organization: (id: string) => dyn(r("/admin/organizations"), id),
    feedback: r("/admin/feedback"),
    feedbackOne: (id: string) => dyn(r("/admin/feedback"), id),
    referralCodes: r("/admin/referral-codes"),
    analytics: r("/admin/analytics"),
    inference: r("/admin/inference"),
    onboarding: r("/admin/onboarding"),
    integrations: r("/admin/integrations"),
    infrastructure: r("/admin/infrastructure"),
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
