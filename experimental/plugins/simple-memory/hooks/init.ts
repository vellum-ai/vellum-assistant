/**
 * init hook — hydrates the in-process store from `<pluginStorageDir>/entries.jsonl`.
 *
 * The harness hands us a `PluginInitContext` (from `@vellumai/plugin-api`)
 * carrying the per-plugin storage directory and a pino-compatible child
 * logger. We stash the logger in module state so the no-arg `onShutdown`
 * hook can still emit structured logs with full plugin attribution.
 *
 * Convention: default export is the function the harness invokes.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import type { PluginInitContext } from "@vellumai/plugin-api";

import { type MemoryEntry, setState } from "../src/state.js";

export default async function init(ctx: PluginInitContext): Promise<void> {
  const storePath = path.join(ctx.pluginStorageDir, "entries.jsonl");
  await fs.mkdir(ctx.pluginStorageDir, { recursive: true });

  let entries: MemoryEntry[] = [];

  try {
    const contents = await fs.readFile(storePath, "utf8");
    for (const line of contents.split("\n").filter(Boolean)) {
      try {
        entries.push(JSON.parse(line) as MemoryEntry);
      } catch (err) {
        ctx.logger.error(
          { plugin: "simple-memory", line, err: String(err) },
          "skipping malformed entries.jsonl line",
        );
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
    // First boot — no file yet. Leave entries empty.
  }

  setState({ storePath, entries, logger: ctx.logger });
  ctx.logger.info(
    { plugin: "simple-memory", storePath, hydratedEntries: entries.length },
    "simple-memory initialized",
  );
}
