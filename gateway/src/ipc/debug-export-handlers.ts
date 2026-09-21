/**
 * IPC route for the daemon's debug export.
 *
 * A debug bundle (a `.vbundle` a self-hosted owner sends to Vellum staff)
 * carries the gateway's database and recent logs alongside the daemon's
 * data. The daemon cannot read those itself: in local mode the database
 * lives in the protected directory next to the encryption keys, and in
 * Docker it is on a volume the daemon does not mount. So the gateway
 * produces one archive over the local socket. `VACUUM INTO` gives a
 * consistent copy, and the gateway's token tables hold hashes, not tokens.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GatewayDebugExportIpcParamsSchema } from "@vellumai/gateway-client/gateway-ipc-contracts";

import type { GatewayConfig } from "../config.js";
import { snapshotGatewayDb } from "../db/connection.js";
import { collectGatewayLogs } from "../http/routes/log-export.js";
import type { IpcRoute } from "./server.js";

/** The archive travels base64-encoded over a JSON socket; keep it bounded. */
export const DEBUG_EXPORT_MAX_BYTES = 64 * 1024 * 1024;

export async function buildDebugExportArchive(
  config: GatewayConfig,
): Promise<{ archive_base64: string; size_bytes: number }> {
  const stagingDir = mkdtempSync(join(tmpdir(), "gateway-debug-export-"));
  try {
    snapshotGatewayDb(join(stagingDir, "gateway.sqlite"));
    await collectGatewayLogs(config, stagingDir);

    // The absolute path keeps a PATH-injected tar out of the picture on
    // macOS and Linux. Windows 10+ ships bsdtar as tar.exe in System32 with
    // no fixed absolute path, so it resolves through PATH there.
    const tarBinary = process.platform === "win32" ? "tar" : "/usr/bin/tar";
    const archivePath = `${stagingDir}.tar.gz`;
    const tar = Bun.spawn(
      [tarBinary, "czf", archivePath, "-C", stagingDir, "."],
      {
        stdout: "ignore",
        stderr: "pipe",
        windowsHide: true,
      },
    );
    if ((await tar.exited) !== 0) {
      throw new Error(`tar failed: ${await new Response(tar.stderr).text()}`);
    }
    try {
      const bytes = readFileSync(archivePath);
      if (bytes.length > DEBUG_EXPORT_MAX_BYTES) {
        throw new Error(
          `debug export is ${bytes.length} bytes, over the ${DEBUG_EXPORT_MAX_BYTES} byte limit`,
        );
      }
      return {
        archive_base64: bytes.toString("base64"),
        size_bytes: bytes.length,
      };
    } finally {
      rmSync(archivePath, { force: true });
    }
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
}

export function createDebugExportRoutes(config: GatewayConfig): IpcRoute[] {
  return [
    {
      method: "gateway_debug_export",
      schema: GatewayDebugExportIpcParamsSchema,
      handler: async () => ({
        ok: true as const,
        ...(await buildDebugExportArchive(config)),
      }),
    },
  ];
}
