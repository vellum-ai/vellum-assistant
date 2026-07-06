/**
 * One-time migration (retired to a no-op): formerly dropped the gateway
 * `channel_verification_sessions` write-only mirror table.
 *
 * Combo 13 recreates that table as gateway-owned (see db/schema.ts), and
 * schema push runs at startup — before data migrations — so executing the
 * drop on an install that never recorded this key (e.g. a fresh install)
 * would delete the live table right after startup created it. Installs
 * that already ran the drop recorded the key and never re-enter. The old
 * mirror never held data, so skipping the drop loses nothing.
 */

import type { MigrationResult } from "./index.js";

export function up(): MigrationResult {
  return "done";
}

export function down(): MigrationResult {
  return "done";
}
