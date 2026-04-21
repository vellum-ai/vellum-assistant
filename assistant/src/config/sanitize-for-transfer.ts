/**
 * Strips environment-specific fields from config JSON before transferring
 * between local and platform environments (teleport/restore).
 *
 * Fields removed or reset:
 * - `ingress.publicBaseUrl` → set to `""`
 * - `ingress.enabled` → deleted
 * - `daemon` → deleted entirely
 * - `skills.load.extraDirs` → set to `[]`
 * - `logFile.dir` → deleted (points to source host paths; schema defaults
 *   to a platform-appropriate data dir when absent)
 * - `hostBrowser.cdpInspect.desktopAuto` → deleted (macOS-host-only
 *   behavior; meaningless — and misleading — on a Linux managed pod)
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

  // Strip logFile.dir — a source-host filesystem path that would
  // otherwise persist inside a managed/docker runtime whose filesystem
  // layout has nothing to do with the source host. Leave retentionDays
  // intact since it is host-agnostic.
  if (config.logFile && typeof config.logFile === "object") {
    const logFile = config.logFile as Record<string, unknown>;
    delete logFile.dir;
  }

  // Strip hostBrowser.cdpInspect.desktopAuto — the auto-attach-to-Chrome
  // behavior is gated on a macOS-originated turn; preserving a
  // source-host-derived `enabled: true` inside a Linux managed pod's
  // config is misleading and brittle. Schema defaults reinstate the
  // correct values per platform.
  if (config.hostBrowser && typeof config.hostBrowser === "object") {
    const hostBrowser = config.hostBrowser as Record<string, unknown>;
    if (hostBrowser.cdpInspect && typeof hostBrowser.cdpInspect === "object") {
      const cdpInspect = hostBrowser.cdpInspect as Record<string, unknown>;
      delete cdpInspect.desktopAuto;
    }
  }

  return JSON.stringify(config, null, 2) + "\n";
}
