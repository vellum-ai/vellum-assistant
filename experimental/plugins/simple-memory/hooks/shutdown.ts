/**
 * shutdown hook — flushes the in-process store back to JSONL.
 *
 * The harness invokes this with no arguments per the Plugin contract, so
 * we read the logger and store path from module state (set by init).
 *
 * Convention: default export is the function the harness invokes.
 */

import { promises as fs } from "node:fs";

import { clearState, requireState } from "../src/state.js";

export default async function onShutdown(): Promise<void> {
  let snapshot: ReturnType<typeof requireState>;
  try {
    snapshot = requireState();
  } catch {
    // init() never ran or already torn down — nothing to flush.
    return;
  }
  const { storePath, entries, logger } = snapshot;
  const serialized =
    entries.length === 0
      ? ""
      : `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`;
  await fs.writeFile(storePath, serialized, "utf8");
  logger.info(
    { plugin: "simple-memory", storePath, flushedEntries: entries.length },
    "simple-memory shutdown",
  );
  clearState();
}
