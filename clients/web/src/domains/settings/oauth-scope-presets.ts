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

export const OAUTH_CONNECT_PRESETS: Record<string, OAuthConnectPreset[]> = {
  google: [
    {
      id: "google-calendar",
      label: "Connect Google Calendar only",
      scopes: GOOGLE_CALENDAR_SCOPES,
    },
  ],
};

export function getConnectPresets(providerKey: string): OAuthConnectPreset[] {
  return OAUTH_CONNECT_PRESETS[providerKey] ?? [];
}
