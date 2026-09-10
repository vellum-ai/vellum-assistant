/**
 * Credentials the Vellum platform provisions onto a managed assistant pod for
 * its own use: the API key the daemon authenticates to the managed LLM proxy
 * with, and the base URL that proxy lives at.
 *
 * The platform writes them over `POST /v1/secrets`, and the daemon, the
 * gateway, and CES read them straight out of the vault. The user never sets
 * them and can do nothing useful with them, while the API key spends inference
 * on Vellum's account. So the credentials API treats them as invisible: they
 * are omitted from listings and refused by inspect and reveal, whatever the
 * calling principal.
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

/** Message the credentials API refuses one of these with. */
export function platformManagedCredentialRefusal(
  service: string | undefined,
  field: string | undefined,
): string {
  const name = service && field ? `${service}:${field}` : "This credential";
  return `${name} is provisioned and owned by the Vellum platform. It cannot be inspected or revealed through the credentials API.`;
}
