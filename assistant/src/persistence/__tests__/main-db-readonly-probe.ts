/**
 * Subprocess probe for the main DB's read-only connection mode — the
 * resource monitor process's posture. Spawned by `main-db-readonly.test.ts`
 * with VELLUM_WORKSPACE_DIR pointing at a fresh temp workspace, so the
 * process-global read-only flag and connection singletons never leak into
 * the test runner process.
 *
 * Exits 0 and prints READONLY_PROBE_OK when every assertion holds; any
 * failure throws and exits non-zero.
 */

import {
  getFlushCheckpoint,
  setFlushCheckpoint,
} from "../../telemetry/flush-checkpoints.js";
import {
  enableMainDbReadOnly,
  getDb,
  getTelemetryDb,
  resetDb,
} from "../db-connection.js";
import { initializeDb } from "../db-init.js";
import { queryUnreportedUsageEvents } from "../llm-usage-store.js";
import { configSettingEvents, memoryCheckpoints } from "../schema/index.js";

// Create the schema over the normal read-write connections, then reopen
// with the monitor's posture: main read-only, telemetry read-write.
await initializeDb();
resetDb();
enableMainDbReadOnly();

// Telemetry store queries work over the read-only main connection.
const rows = queryUnreportedUsageEvents(0, undefined, 10);
if (!Array.isArray(rows) || rows.length !== 0) {
  throw new Error(`expected empty usage query, got ${JSON.stringify(rows)}`);
}

// Writes to the main DB fail loudly.
let writeError: unknown;
try {
  getDb()
    .insert(memoryCheckpoints)
    .values({ key: "readonly-probe", value: "1", updatedAt: Date.now() })
    .run();
} catch (err) {
  writeError = err;
}
if (!writeError || !/readonly/i.test(String(writeError))) {
  throw new Error(
    `expected a readonly write failure, got: ${String(writeError)}`,
  );
}

// The telemetry DB stays writable: flush state and event rows.
setFlushCheckpoint("telemetry:readonly-probe:last_reported_at", "123");
if (getFlushCheckpoint("telemetry:readonly-probe:last_reported_at") !== "123") {
  throw new Error("flush checkpoint round-trip failed");
}
const telemetryDb = getTelemetryDb();
if (!telemetryDb) {
  throw new Error("telemetry DB unavailable");
}
telemetryDb
  .insert(configSettingEvents)
  .values({
    id: "readonly-probe-row",
    createdAt: Date.now(),
    configKey: "memory.enabled",
    configValue: "true",
  })
  .run();

console.log("READONLY_PROBE_OK");
