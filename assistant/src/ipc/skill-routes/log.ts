/**
 * Skill IPC route: `host.log`.
 *
 * Forwards structured log lines from an out-of-process skill to the daemon's
 * existing logger so skill logs land in the same sink as daemon logs. The
 * skill-side contract uses `(msg, meta?)`; the daemon's pino loggers use
 * `(meta, msg)` — this route normalizes the call shape at the boundary,
 * matching `DaemonSkillHost.logger.get()`.
 */

import { z } from "zod";

import { getLogger } from "../../util/logger.js";
import type { IpcRoute } from "../cli-server.js";

const LogParams = z.object({
  level: z.enum(["debug", "info", "warn", "error"]),
  msg: z.string(),
  // Skill-chosen logger scope (mirrors `host.logger.get(name)` on the client
  // side). Optional so callers that don't thread a scope still get a useful
  // default instead of failing validation.
  name: z.string().optional(),
  meta: z.unknown().optional(),
});

export const hostLogRoute: IpcRoute = {
  method: "host.log",
  handler: (params) => {
    const { level, msg, name, meta } = LogParams.parse(params);
    const log = getLogger(name ?? "skill");
    const metaObj =
      meta && typeof meta === "object" && !Array.isArray(meta)
        ? (meta as Record<string, unknown>)
        : {};
    log[level](metaObj, msg);
    return { ok: true };
  },
};

export const logRoutes: IpcRoute[] = [hostLogRoute];
