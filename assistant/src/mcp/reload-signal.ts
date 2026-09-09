/**
 * Cross-process notification that the MCP server set has been reloaded.
 *
 * MCP connections and the tools they register are per-process, and so is the
 * reload that rebuilds them: `daemon/mcp-reload-service.ts` acts on the
 * daemon's own manager and registry. Every other process that holds
 * connections has to hear about it, or it keeps serving the server set as it
 * stood when that process started, including servers the config has since
 * disabled or removed.
 *
 * The channel is a file in the signals directory, written by the reloading
 * process and watched by the others. A file rather than an IPC call because
 * the listeners are the daemon's own children: a call would need the daemon to
 * track who is listening and to stay up while it delivers, and the reload has
 * no reason to wait for either.
 *
 * The file's content is a timestamp, and it is never deleted. Readers react to
 * the write, so there is nothing to consume and no race over who consumes it.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getLogger } from "../util/logger.js";
import { getSignalsDir } from "../util/platform.js";

const log = getLogger("mcp-reload-signal");

/** Name of the signal file within the signals directory. */
export const MCP_RELOAD_SIGNAL_FILE = "mcp-reloaded";

/**
 * Announce that this process reloaded its MCP servers.
 *
 * Best-effort: a signals directory that cannot be written leaves other
 * processes on their existing connections, which is where they already were,
 * so it is logged rather than raised into the reload's result.
 */
export function signalMcpReloaded(): void {
  const signalsDir = getSignalsDir();
  try {
    mkdirSync(signalsDir, { recursive: true });
    writeFileSync(join(signalsDir, MCP_RELOAD_SIGNAL_FILE), String(Date.now()));
  } catch (err) {
    log.warn(
      { err, signalsDir },
      "Failed to write the MCP reload signal; other processes keep their current servers",
    );
  }
}
