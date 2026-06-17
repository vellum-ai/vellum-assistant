/**
 * Per-provider scoped-connect presets.
 *
 * Some providers (notably Google) bundle several products behind a single
 * OAuth app. By default we request the provider's full scope set, but a preset
 * lets the user grant access to just one product — e.g. connect Google Calendar
 * (read/write) without also granting Gmail or Drive.
 *
 * The `scopes` here are forwarded as `requested_scopes` to the platform OAuth
 * start endpoint, which uses them in place of the provider's default scopes.
 */
export interface OAuthConnectPreset {
  /** Stable id, used as a React key. */
  id: string;
  /** Button label, e.g. "Connect Google Calendar only". */
  label: string;
  /** Exact scopes to request. Empty/omitted means the provider default. */
  scopes: string[];
}

/** Google Calendar read + event read/write, plus identity for the account label. */
const GOOGLE_CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/userinfo.email",
];

/**
 * Google Calendar-only connect preset. Defined and ready, but intentionally
 * NOT surfaced in the UI yet (see `OAUTH_CONNECT_PRESETS` below).
 */
export const GOOGLE_CALENDAR_PRESET: OAuthConnectPreset = {
  id: "google-calendar",
  label: "Connect Google Calendar only",
  scopes: GOOGLE_CALENDAR_SCOPES,
};

/**
 * Active per-provider presets surfaced in the integrations UI.
 *
 * Intentionally empty for now. A scoped Google connection creates an active
 * `google` connection record with a narrow scope set, but managed connection
 * resolution (`resolvePlatformConnectionId`) and status reporting
 * (`isOAuthProviderConnected("google")` / `formatIntegrationSummary`) in the
 * daemon are not yet scope-aware — they treat any active `google` connection as
 * a full Gmail/Calendar/Drive connection. Surfacing the Calendar-only button
 * before that is fixed would let Gmail tools route to a token lacking Gmail
 * scopes (403) while the assistant reports Gmail as connected.
 *
 * Re-enable by adding `google: [GOOGLE_CALENDAR_PRESET]` once resolution/status
 * are scope-aware (or Calendar is modeled as its own provider).
 */
export const OAUTH_CONNECT_PRESETS: Record<string, OAuthConnectPreset[]> = {};

export function getConnectPresets(providerKey: string): OAuthConnectPreset[] {
  return OAUTH_CONNECT_PRESETS[providerKey] ?? [];
}
