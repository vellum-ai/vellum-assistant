import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

/**
 * Drops the `sendDiagnostics` config key (crash reporting is governed by the
 * platform `share_diagnostics` consent). An explicit local opt-out
 * (`sendDiagnostics: false`) is preserved as `legacyDiagnosticsOptOut: true` so
 * Sentry stays off regardless of platform consent, which defaults to opt-in and
 * cannot be written by the daemon. A `true`/non-false value carries no opt-out
 * intent, so the key is removed without setting the marker. The schema strips
 * unknown keys on the next save, so a stale value is otherwise harmless.
 */
export const dropSendDiagnosticsMigration: WorkspaceMigration = {
  id: "107-drop-send-diagnostics",
  description:
    "Drop sendDiagnostics; preserve an explicit opt-out as legacyDiagnosticsOptOut (crash reporting is gated by platform share_diagnostics consent)",
  run(workspaceDir: string): void {
    const configPath = join(workspaceDir, "config.json");
    if (!existsSync(configPath)) return;

    let config: Record<string, unknown>;
    try {
      const raw = JSON.parse(readFileSync(configPath, "utf-8"));
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
      config = raw as Record<string, unknown>;
    } catch {
      return; // Malformed config — skip
    }

    if (!("sendDiagnostics" in config)) return;

    // An explicit opt-out is preserved as a fail-closed marker; any non-false
    // value carries no opt-out intent.
    if (config.sendDiagnostics === false) {
      config.legacyDiagnosticsOptOut = true;
    }

    delete config.sendDiagnostics;
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  },
  down(_workspaceDir: string): void {
    // No-op: the forward migration only removes a key and sets a fail-closed
    // marker, so there is nothing to restore.
  },
};
