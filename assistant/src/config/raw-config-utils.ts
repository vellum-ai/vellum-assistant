/**
 * Safely set a nested field on a raw config object's `llm.default` map.
 *
 * Ensures the `llm` and `llm.default` objects exist before writing, so
 * callers don't need to guard against undefined intermediate keys.
 *
 * Example: `setLlmDefaultField(raw, "model", "claude-sonnet-4-6")`
 * produces `raw.llm.default.model = "claude-sonnet-4-6"`.
 */
export function setLlmDefaultField(
  raw: Record<string, unknown>,
  field: string,
  value: unknown,
): void {
  const llm: Record<string, unknown> =
    raw.llm != null && typeof raw.llm === "object" && !Array.isArray(raw.llm)
      ? (raw.llm as Record<string, unknown>)
      : {};
  const existing = llm.default;
  const defaultBlock: Record<string, unknown> =
    existing != null && typeof existing === "object" && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};
  defaultBlock[field] = value;
  llm.default = defaultBlock;
  raw.llm = llm;
}

/**
 * Safely set a nested field on a raw config object's `llm.callSites.<site>`
 * map. Creates intermediate objects as needed.
 *
 * Example: `setLlmCallSiteField(raw, "mainAgent", "model", "claude-opus-4-7")`
 * produces `raw.llm.callSites.mainAgent.model = "claude-opus-4-7"`.
 */
export function setLlmCallSiteField(
  raw: Record<string, unknown>,
  site: string,
  field: string,
  value: unknown,
): void {
  const llm: Record<string, unknown> =
    raw.llm != null && typeof raw.llm === "object" && !Array.isArray(raw.llm)
      ? (raw.llm as Record<string, unknown>)
      : {};
  const callSitesRaw = llm.callSites;
  const callSites: Record<string, unknown> =
    callSitesRaw != null &&
    typeof callSitesRaw === "object" &&
    !Array.isArray(callSitesRaw)
      ? (callSitesRaw as Record<string, unknown>)
      : {};
  const siteRaw = callSites[site];
  const siteBlock: Record<string, unknown> =
    siteRaw != null && typeof siteRaw === "object" && !Array.isArray(siteRaw)
      ? (siteRaw as Record<string, unknown>)
      : {};
  siteBlock[field] = value;
  callSites[site] = siteBlock;
  llm.callSites = callSites;
  raw.llm = llm;
}

/**
 * Check whether a call-site override exists in a raw config object.
 */
export function hasLlmCallSiteOverride(
  raw: Record<string, unknown>,
  site: string,
): boolean {
  if (
    raw.llm == null ||
    typeof raw.llm !== "object" ||
    Array.isArray(raw.llm)
  ) {
    return false;
  }
  const llm = raw.llm as Record<string, unknown>;
  const callSitesRaw = llm.callSites;
  if (
    callSitesRaw == null ||
    typeof callSitesRaw !== "object" ||
    Array.isArray(callSitesRaw)
  ) {
    return false;
  }
  const callSites = callSitesRaw as Record<string, unknown>;
  const siteRaw = callSites[site];
  return (
    siteRaw != null && typeof siteRaw === "object" && !Array.isArray(siteRaw)
  );
}

/**
 * Safely set a nested field on a raw config object's `services` map.
 *
 * Ensures the `services` and service-level objects exist before writing,
 * so callers don't need to guard against undefined intermediate keys.
 *
 * Example: `setServiceField(raw, "inference", "mode", "managed")`
 * produces `raw.services.inference.mode = "managed"`.
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
