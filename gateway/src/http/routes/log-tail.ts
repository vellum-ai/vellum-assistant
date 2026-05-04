import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { GatewayConfig } from "../../config.js";
import { getLogger } from "../../logger.js";

const log = getLogger("log-tail");

const LEVEL_NAMES = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
type LevelName = (typeof LEVEL_NAMES)[number];

const LEVEL_MAP: Record<LevelName, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

const LOG_FILE_PATTERN = /^gateway-\d{4}-\d{2}-\d{2}\.log$/;

export function createLogTailHandler(
  config: GatewayConfig,
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const searchParams = new URL(req.url).searchParams;

    // Parse and clamp `n`
    const nRaw = parseInt(searchParams.get("n") ?? "10", 10);
    const n = Math.max(1, Math.min(1000, Number.isNaN(nRaw) ? 10 : nRaw));

    // Parse and validate `level`
    const levelParam = searchParams.get("level") ?? "info";
    if (!(LEVEL_NAMES as readonly string[]).includes(levelParam)) {
      return Response.json({ error: "Invalid level" }, { status: 400 });
    }

    // Parse optional module filter
    const moduleFilter = searchParams.get("module") ?? undefined;

    const minLevel = LEVEL_MAP[levelParam as LevelName];

    try {
      if (!config.logFile.dir || !existsSync(config.logFile.dir)) {
        return Response.json({ lines: [], truncated: false });
      }

      const dir = config.logFile.dir;

      const files = readdirSync(dir)
        .filter((f) => LOG_FILE_PATTERN.test(f))
        .sort()
        .reverse();

      const collected: unknown[] = [];

      outer: for (const file of files) {
        const content = readFileSync(join(dir, file), "utf8");
        const fileLines = content.split("\n");
        for (let i = fileLines.length - 1; i >= 0; i--) {
          const raw = fileLines[i];
          if (!raw) continue;
          let entry: Record<string, unknown>;
          try {
            entry = JSON.parse(raw);
          } catch {
            continue;
          }
          if (typeof entry.level !== "number") continue;
          if (entry.level < minLevel) continue;
          if (moduleFilter !== undefined && entry.module !== moduleFilter) continue;
          collected.push(entry);
          if (collected.length >= n + 1) break outer;
        }
      }

      const truncated = collected.length > n;
      const lines = collected.slice(0, n).reverse();

      return Response.json({ lines, truncated });
    } catch (err) {
      log.warn({ err }, "log-tail handler failed");
      return Response.json({ lines: [], truncated: false });
    }
  };
}
