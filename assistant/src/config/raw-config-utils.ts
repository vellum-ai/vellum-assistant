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
  const services: Record<string, Record<string, unknown>> = raw.services !=
    null &&
  typeof raw.services === "object" &&
  !Array.isArray(raw.services)
    ? (raw.services as Record<string, Record<string, unknown>>)
    : {};
  const existing = services[service];
  const svc: Record<string, unknown> =
    existing != null && typeof existing === "object" && !Array.isArray(existing)
      ? existing
      : {};
  svc[field] = value;
  services[service] = svc;
  raw.services = services;
}

/**
 * Safely set a nested field on a raw config object's `memory.embeddings` map.
 *
 * Ensures the `memory` and `embeddings` objects exist before writing,
 * so callers don't need to guard against undefined intermediate keys.
 *
 * Example: `setMemoryEmbeddingField(raw, "provider", "openai")`
 * produces `raw.memory.embeddings.provider = "openai"`.
 */
export function setMemoryEmbeddingField(
  raw: Record<string, unknown>,
  field: string,
  value: unknown,
): void {
  const memory: Record<string, unknown> =
    raw.memory != null &&
    typeof raw.memory === "object" &&
    !Array.isArray(raw.memory)
      ? (raw.memory as Record<string, unknown>)
      : {};
  const existing = memory.embeddings;
  const embeddings: Record<string, unknown> =
    existing != null && typeof existing === "object" && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};
  embeddings[field] = value;
  memory.embeddings = embeddings;
  raw.memory = memory;
}

/**
 * Safely delete a nested field from a raw config object's `memory.embeddings`
 * map, allowing Zod schema defaults to take effect on the next config reload.
 */
export function deleteMemoryEmbeddingField(
  raw: Record<string, unknown>,
  field: string,
): void {
  if (
    raw.memory == null ||
    typeof raw.memory !== "object" ||
    Array.isArray(raw.memory)
  ) {
    return;
  }
  const memory = raw.memory as Record<string, unknown>;
  const existing = memory.embeddings;
  if (
    existing == null ||
    typeof existing !== "object" ||
    Array.isArray(existing)
  ) {
    return;
  }
  const embeddings = existing as Record<string, unknown>;
  delete embeddings[field];
}
