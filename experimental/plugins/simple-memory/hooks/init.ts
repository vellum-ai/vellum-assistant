/**
 * init hook — hydrates the in-process store from `<pluginStorageDir>/entries.jsonl`.
 *
 * The harness supplies `pluginStorageDir` and a `logger`. We stash the
 * logger in module state so the no-arg `onShutdown` hook can still log
 * with full attribution.
 *
 * Convention: default export is the function the harness invokes.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import {
  type MemoryEntry,
  type PluginLogger,
  setState,
} from "../src/state.js";

interface InitContext {
  pluginStorageDir: string;
  logger: PluginLogger;
}

export default async function init(ctx: InitContext): Promise<void> {
  const storePath = path.join(ctx.pluginStorageDir, "entries.jsonl");
  await fs.mkdir(ctx.pluginStorageDir, { recursive: true });

  const entries: MemoryEntry[] = [];
  try {
    const raw = await fs.readFile(storePath, "utf8");
    for (const line of raw.split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        entries.push(JSON.parse(line) as MemoryEntry);
      } catch (err) {
        ctx.logger.error(
          { plugin: "simple-memory", line, err: String(err) },
          "skipping malformed entries.jsonl line",
        );
      }
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
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
