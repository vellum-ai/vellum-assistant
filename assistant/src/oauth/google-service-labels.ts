/**
 * Derives human-readable Google service labels (Gmail, Calendar, Drive) from
 * the OAuth scopes granted to a Google connection.
 *
 * A single Google OAuth app bundles several products behind one provider key,
 * and a connection may have been granted only a subset of them. When scope
 * data is missing or empty the grant is treated as the full default bundle —
 * unknown is "assume the standard services", never "no access". Callers that
 * need to gate on a real denial must inspect the scopes directly.
 */

export const GOOGLE_SERVICE_GMAIL = "Gmail";
export const GOOGLE_SERVICE_CALENDAR = "Calendar";
export const GOOGLE_SERVICE_DRIVE = "Drive";

/** Service set assumed when a Google connection reports no scope data. */
export const DEFAULT_GOOGLE_SERVICES: string[] = [
  GOOGLE_SERVICE_GMAIL,
  GOOGLE_SERVICE_CALENDAR,
  GOOGLE_SERVICE_DRIVE,
];

const SCOPE_SERVICE_MAP: Record<string, string> = {
  "gmail.readonly": GOOGLE_SERVICE_GMAIL,
  "gmail.modify": GOOGLE_SERVICE_GMAIL,
  "gmail.send": GOOGLE_SERVICE_GMAIL,
  "gmail.settings.basic": GOOGLE_SERVICE_GMAIL,
  "calendar.readonly": GOOGLE_SERVICE_CALENDAR,
  "calendar.events": GOOGLE_SERVICE_CALENDAR,
  drive: GOOGLE_SERVICE_DRIVE,
};

/**
 * Map a set of granted Google scopes to their display service labels. Returns
 * the default bundle when scopes are absent, empty, or map to nothing known.
 */
export function deriveGoogleServices(scopes?: string[]): string[] {
  if (!scopes?.length) {
    return [...DEFAULT_GOOGLE_SERVICES];
  }
  const services = new Set<string>();
  for (const scope of scopes) {
    const suffix = scope.replace("https://www.googleapis.com/auth/", "");
    const service = SCOPE_SERVICE_MAP[suffix];
    if (service) {
      services.add(service);
    }
  }
  return services.size > 0 ? [...services] : [...DEFAULT_GOOGLE_SERVICES];
}

/**
 * Whether a specific Google service is granted by the given scopes. Missing or
 * empty scope data resolves to `true` (unknown → assume granted), matching
 * {@link deriveGoogleServices}.
 */
export function isGoogleServiceGranted(
  service: string,
  scopes?: string[],
): boolean {
  return deriveGoogleServices(scopes).includes(service);
}
