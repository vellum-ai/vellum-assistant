/** Default base URL per credential service. Used by the connection when no per-request override is provided. */
export const PROVIDER_BASE_URLS: Record<string, string> = {
  "integration:gmail": "https://gmail.googleapis.com/gmail/v1/users/me",
  "integration:slack": "https://slack.com/api",
  "integration:twitter": "https://api.x.com",
  "integration:notion": "https://api.notion.com",
  "integration:linear": "https://api.linear.app",
  "integration:github": "https://api.github.com",
};

/**
 * Alternative base URLs for providers that span multiple API hosts
 * sharing one OAuth token. Callers pass these via `request({ baseUrl })`.
 */
export const GOOGLE_CALENDAR_BASE_URL =
  "https://www.googleapis.com/calendar/v3";
export const GOOGLE_PEOPLE_BASE_URL = "https://people.googleapis.com/v1";
export const GMAIL_BATCH_BASE_URL = "https://www.googleapis.com/batch/gmail/v1";

export function getProviderBaseUrl(providerKey: string): string | undefined {
  return PROVIDER_BASE_URLS[providerKey];
}
