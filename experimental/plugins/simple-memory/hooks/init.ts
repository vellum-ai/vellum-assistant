/**
 * init hook — hydrates the in-process store from `<pluginStorageDir>/entries.jsonl`.
 *
 * The harness supplies `pluginStorageDir` and a `logger`. We define the
 * minimum shape we need locally so this module has no imports outside
 * itself.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import { type MemoryEntry, setState } from "../src/state.js";

interface InitLogger {
  info(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}

interface InitContext {
  pluginStorageDir: string;
  logger: InitLogger;
}

export async function init(ctx: InitContext): Promise<void> {
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

  setState({ storePath, entries });
  ctx.logger.info(
    { plugin: "simple-memory", storePath, hydratedEntries: entries.length },
    "simple-memory initialized",
  );
}
