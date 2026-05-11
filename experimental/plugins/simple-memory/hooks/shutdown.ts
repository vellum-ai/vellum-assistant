/**
 * shutdown hook — flushes the in-process store back to JSONL.
 */

import { promises as fs } from "node:fs";

import { clearState, requireState } from "../src/state.js";

interface ShutdownLogger {
  info(obj: Record<string, unknown>, msg?: string): void;
}

interface ShutdownContext {
  logger: ShutdownLogger;
}

export async function onShutdown(ctx: ShutdownContext): Promise<void> {
  let snapshot: ReturnType<typeof requireState>;
  try {
    snapshot = requireState();
  } catch {
    // init() never ran or already torn down — nothing to flush.
    return;
  }
  const { storePath, entries } = snapshot;
  const serialized =
    entries.length === 0 ? "" : `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`;
  await fs.writeFile(storePath, serialized, "utf8");
  ctx.logger.info(
    { plugin: "simple-memory", storePath, flushedEntries: entries.length },
    "simple-memory shutdown",
  );
  clearState();
}
