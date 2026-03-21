/**
 * Convert flat dot-notation key=value pairs into a nested config object.
 *
 * e.g. {"services.inference.provider": "anthropic", "services.inference.model": "claude-opus-4-6"}
 *   → {services: {inference: {provider: "anthropic", model: "claude-opus-4-6"}}}
 */
export function buildNestedConfig(
  configValues: Record<string, string>,
): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  for (const [dotKey, value] of Object.entries(configValues)) {
    const parts = dotKey.split(".");
    let target: Record<string, unknown> = config;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      const existing = target[part];
      if (
        existing == null ||
        typeof existing !== "object" ||
        Array.isArray(existing)
      ) {
        target[part] = {};
      }
      target = target[part] as Record<string, unknown>;
    }
    target[parts[parts.length - 1]] = value;
  }
  return config;
}
