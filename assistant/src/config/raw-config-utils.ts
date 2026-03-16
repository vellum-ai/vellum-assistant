/**
 * Safely set a nested field on a raw config object's `services` map.
 *
 * Ensures the `services` and service-level objects exist before writing,
 * so callers don't need to guard against undefined intermediate keys.
 *
 * Example: `setServiceField(raw, "inference", "model", "claude-sonnet-4-6")`
 * produces `raw.services.inference.model = "claude-sonnet-4-6"`.
 */
export function setServiceField(
  raw: Record<string, unknown>,
  service: string,
  field: string,
  value: unknown,
): void {
  const services =
    (raw.services as Record<string, Record<string, unknown>>) ?? {};
  const svc = services[service] ?? {};
  svc[field] = value;
  services[service] = svc;
  raw.services = services;
}
