/**
 * Credentials the Vellum platform provisions onto a managed assistant pod for
 * its own use: the API key the daemon authenticates to the managed LLM proxy
 * with, and the base URL that proxy lives at.
 *
 * The platform writes them over `POST /v1/secrets`, and the daemon, the
 * gateway, and CES read them straight out of the vault. The user never sets
 * them through the credentials API and can do nothing useful with them there,
 * so that API treats the pair as neither readable nor writable: omitted from
 * listings, and refused by inspect, reveal, set, and delete, whatever the
 * calling principal.
 *
 * The two fields travel together because they are one capability. The API key
 * spends inference on Vellum's account, and the base URL decides which host
 * receives it: the gateway resolves the platform host from
 * `vellum:platform_base_url` (see `gateway/src/platform-url.ts`) and then
 * sends `vellum:assistant_api_key` to it as the bearer. Leaving the URL
 * writable while hiding the key would hand back the same key by another
 * route, pointed at a host of the writer's choosing.
 */
const MANAGED_PROXY_CREDENTIALS = [
  { service: "vellum", field: "assistant_api_key" },
  { service: "vellum", field: "platform_base_url" },
] as const;

export function isPlatformManagedCredential(
  service: string,
  field: string,
): boolean {
  return MANAGED_PROXY_CREDENTIALS.some(
    (c) => c.service === service && c.field === field,
  );
}

/** What a caller was trying to do with a platform-managed credential. */
export type PlatformManagedCredentialAction = "read" | "change";

/** Message the credentials API refuses one of these with. */
export function platformManagedCredentialRefusal(
  service: string | undefined,
  field: string | undefined,
  action: PlatformManagedCredentialAction,
): string {
  const name = service && field ? `${service}:${field}` : "This credential";
  const verb =
    action === "read" ? "inspected or revealed" : "changed or deleted";
  return `${name} is provisioned and owned by the Vellum platform. It cannot be ${verb} through the credentials API.`;
}
