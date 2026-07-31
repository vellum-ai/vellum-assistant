/**
 * Subprocess probe for the resource monitor's main-DB posture: telemetry
 * queries route through the dedicated read-only connection, writes through
 * it fail loudly, and the telemetry DB stays writable. Spawned by
 * `main-db-readonly.test.ts` with VELLUM_WORKSPACE_DIR pointing at a fresh
 * temp workspace, so the process-scoped posture and connection singletons
 * never leak into the test runner process.
 *
 * Exits 0 and prints READONLY_PROBE_OK when every assertion holds; any
 * failure throws and exits non-zero.
 */

import {
  getFlushCheckpoint,
  setFlushCheckpoint,
} from "../../telemetry/flush-checkpoints.js";
import { useReadOnlyMainDbForTelemetry } from "../../telemetry/telemetry-main-db.js";
import {
  getMainDbReadOnly,
  getTelemetryDb,
  resetDb,
} from "../db-connection.js";
import { initializeDb } from "../db-init.js";
import { queryUnreportedUsageEvents } from "../llm-usage-store.js";
import { memoryCheckpoints, telemetryEvents } from "../schema/index.js";

// Create the schema over the normal read-write connections, then reopen
// with the monitor's posture: telemetry main-DB reads go through the
// dedicated read-only connection; the telemetry DB stays read-write.
await initializeDb();
resetDb();
useReadOnlyMainDbForTelemetry();

// Telemetry store queries work over the read-only main connection.
const rows = queryUnreportedUsageEvents(0, undefined, 10);
if (!Array.isArray(rows) || rows.length !== 0) {
  throw new Error(`expected empty usage query, got ${JSON.stringify(rows)}`);
}

// Writes through the read-only connection fail loudly.
const readOnlyDb = getMainDbReadOnly();
if (!readOnlyDb) {
  throw new Error("read-only main DB connection unavailable");
}
let writeError: unknown;
try {
  readOnlyDb
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
  .insert(telemetryEvents)
  .values({
    id: "readonly-probe-row",
    name: "config_setting",
    createdAt: Date.now(),
    conversationId: null,
    payload: '{"type":"config_setting"}',
  })
  .run();

console.log("READONLY_PROBE_OK");
