import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  GATEWAY_LOG_LEVEL_NAMES,
  type GatewayLogLevelName,
} from "@vellumai/gateway-client/gateway-ipc-contracts";

import type { GatewayConfig } from "../../config.js";
import {
  getLogger,
  LOG_FILE_JSON_PATTERN,
  LOG_FILE_PATTERN,
} from "../../logger.js";

const log = getLogger("log-tail");

const LEVEL_MAP: Record<GatewayLogLevelName, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

// Server-side level/module filtering walks the JSONL sidecar produced by the
// logger. Legacy gateway-YYYY-MM-DD.log files (raw JSON from before the
// pretty/JSONL split) are also walked so upgrades don't blackhole recent
// history; current-format pretty .log files are multi-line and their lines
// silently fail `JSON.parse` below, which is the desired behavior.
const TAIL_PATTERNS = [LOG_FILE_JSON_PATTERN, LOG_FILE_PATTERN] as const;

export interface TailGatewayLogsParams {
  n?: number;
  level?: GatewayLogLevelName;
  module?: string;
}

export interface TailGatewayLogsResult {
  lines: unknown[];
  truncated: boolean;
}

function isLevelName(value: string): value is GatewayLogLevelName {
  return (GATEWAY_LOG_LEVEL_NAMES as readonly string[]).includes(value);
}

export function tailGatewayLogs(
  config: GatewayConfig,
  params: TailGatewayLogsParams = {},
): TailGatewayLogsResult {
  const nRaw = params.n ?? 10;
  const n = Math.max(1, Math.min(1000, Number.isNaN(nRaw) ? 10 : nRaw));
  const minLevel = LEVEL_MAP[params.level ?? "info"];
  const moduleFilter = params.module;

  try {
    if (!config.logFile.dir || !existsSync(config.logFile.dir)) {
      return { lines: [], truncated: false };
    }

    const dir = config.logFile.dir;

    const files = readdirSync(dir)
      .filter((f) => TAIL_PATTERNS.some((p) => p.test(f)))
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
        if (moduleFilter !== undefined && entry.module !== moduleFilter) {
          continue;
        }
        collected.push(entry);
        if (collected.length >= n + 1) break outer;
      }
    }

    const truncated = collected.length > n;
    const lines = collected.slice(0, n).reverse();

    return { lines, truncated };
  } catch (err) {
    log.warn({ err }, "log-tail handler failed");
    return { lines: [], truncated: false };
  }
}

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
    if (!isLevelName(levelParam)) {
      return Response.json({ error: "Invalid level" }, { status: 400 });
    }

    // Parse optional module filter
    const moduleFilter = searchParams.get("module") ?? undefined;
    return Response.json(
      tailGatewayLogs(config, { n, level: levelParam, module: moduleFilter }),
    );
  };
}
