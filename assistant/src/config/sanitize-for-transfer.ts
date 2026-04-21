/**
 * Strips environment-specific fields from config JSON before transferring
 * between local and platform environments (teleport/restore).
 *
 * Fields removed or reset:
 * - `ingress.publicBaseUrl` → set to `""`
 * - `ingress.enabled` → deleted
 * - `daemon` → deleted entirely
 * - `skills.load.extraDirs` → set to `[]`
 * - `hostBrowser.cdpInspect.desktopAuto` → deleted **only when the source
 *   either relies on the schema default or explicitly sets
 *   `enabled: true`**. An explicit `enabled: false` is preserved so a
 *   platform→local teleport doesn't silently re-enable auto-attach
 *   against the user's opt-out.
 *
 * `logFile.dir` is intentionally *not* stripped: the logger's container
 * fallback (`util/logger.ts#resolveLogDir`) already redirects to the
 * default log dir with a warning when the configured path can't be
 * created, and stripping `dir` would disable rotating file logging
 * entirely because `lifecycle.ts` gates `initLogger` on a truthy
 * `config.logFile.dir`.
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

  // Strip hostBrowser.cdpInspect.desktopAuto — the auto-attach-to-Chrome
  // behavior is gated on a macOS-originated turn; preserving a
  // source-host-derived `enabled: true` inside a Linux managed pod's
  // config is misleading and brittle. Preserve an explicit
  // `enabled: false` opt-out, though — the schema default is `true`,
  // so unconditionally stripping this subobject would re-enable
  // auto-attach after a platform→local teleport.
  if (config.hostBrowser && typeof config.hostBrowser === "object") {
    const hostBrowser = config.hostBrowser as Record<string, unknown>;
    if (hostBrowser.cdpInspect && typeof hostBrowser.cdpInspect === "object") {
      const cdpInspect = hostBrowser.cdpInspect as Record<string, unknown>;
      const desktopAuto = cdpInspect.desktopAuto;
      const isExplicitOptOut =
        desktopAuto !== null &&
        typeof desktopAuto === "object" &&
        !Array.isArray(desktopAuto) &&
        (desktopAuto as Record<string, unknown>).enabled === false;
      if (!isExplicitOptOut) {
        delete cdpInspect.desktopAuto;
      }
    }
  }

  return JSON.stringify(config, null, 2) + "\n";
}
