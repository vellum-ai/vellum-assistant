/**
 * init hook — hydrates the in-process store from `<pluginStorageDir>/entries.jsonl`.
 *
 * The harness supplies `pluginStorageDir` and a `logger` via
 * `PluginInitContext` from `@vellumai/plugin-api`. The logger is typed
 * as `unknown` in the public surface today (the public PluginLogger
 * type hasn't been finalised), so we narrow it to a local pino-shaped
 * interface for use inside the plugin. We stash the narrowed logger in
 * module state so the no-arg `onShutdown` hook can still log with full
 * attribution.
 *
 * Convention: default export is the function the harness invokes.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import type { PluginInitContext } from "@vellumai/plugin-api";

import {
  type MemoryEntry,
  type PluginLogger,
  setState,
} from "../src/state.js";

export default async function init(ctx: PluginInitContext): Promise<void> {
  // The public PluginInitContext types `logger` as `unknown` to avoid
  // committing to a pino-flavoured interface in the public package. The
  // assistant runtime always supplies a pino child here, so the local
  // narrowing is safe.
  const logger = ctx.logger as PluginLogger;
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
        logger.error(
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

  setState({ storePath, entries, logger });
  logger.info(
    { plugin: "simple-memory", storePath, hydratedEntries: entries.length },
    "simple-memory initialized",
  );
}
