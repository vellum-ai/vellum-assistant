/**
 * Strips environment-specific fields from config JSON before transferring
 * between local and platform environments (teleport/restore).
 *
 * Fields removed or reset:
 * - `ingress.publicBaseUrl` → set to `""`
 * - `ingress.enabled` → deleted
 * - `daemon` → deleted entirely
 * - `skills.load.extraDirs` → set to `[]`
 */
export function sanitizeConfigForTransfer(configJson: string): string {
  let config: Record<string, unknown>;
  try {
    const parsed = JSON.parse(configJson);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return configJson;
    }
    config = parsed;
  } catch {
    return configJson;
  }

  // Strip ingress environment-specific fields
  if (config.ingress && typeof config.ingress === "object") {
    const ingress = config.ingress as Record<string, unknown>;
    ingress.publicBaseUrl = "";
    delete ingress.enabled;
  }

  // Strip daemon entirely
  delete config.daemon;

  // Strip skills.load.extraDirs
  if (config.skills && typeof config.skills === "object") {
    const skills = config.skills as Record<string, unknown>;
    if (skills.load && typeof skills.load === "object") {
      const load = skills.load as Record<string, unknown>;
      load.extraDirs = [];
    }
  }

  return JSON.stringify(config, null, 2) + "\n";
}
