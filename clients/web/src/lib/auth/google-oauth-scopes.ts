export const GOOGLE_MANAGED_FULL_CONNECT_SCOPES: readonly string[] = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.settings.basic",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/contacts.readonly",
];

export function resolveManagedOAuthRequestedScopes(
  providerKey: string,
  requestedScopes: readonly string[] = [],
): string[] {
  if (requestedScopes.length > 0) {
    return [...requestedScopes];
  }

  if (providerKey === "google") {
    return [...GOOGLE_MANAGED_FULL_CONNECT_SCOPES];
  }

  return [];
}
