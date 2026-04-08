/**
 * Gateway log export route.
 *
 * Orchestrates parallel collection from three sources:
 * 1. Gateway's own log files (filtered by date range)
 * 2. Daemon's POST /v1/export (forwarded with service token)
 * 3. CES GET /v1/logs/export (when CES_CREDENTIAL_URL is set)
 *
 * All three collections run via Promise.allSettled so individual failures
 * don't block the others. The result is a tar.gz archive containing the
 * collected files plus an export-manifest.json documenting what succeeded.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

import { mintServiceToken } from "../../auth/token-exchange.js";
import type { GatewayConfig } from "../../config.js";
import { fetchImpl } from "../../fetch.js";
import { getLogger, LOG_FILE_PATTERN } from "../../logger.js";

const log = getLogger("log-export");

/** Maximum total bytes to copy from gateway log files. */
const GATEWAY_LOG_CAP_BYTES = 10 * 1024 * 1024; // 10 MB

/** Timeout for daemon and CES export requests. */
const EXPORT_TIMEOUT_MS = 120_000;

type ServiceStatus = "ok" | "error" | "skipped";

interface ExportManifest {
  type: "multi-service-export";
  exportedAt: string;
  startTime?: number;
  endTime?: number;
  services: {
    gateway: ServiceStatus;
    daemon: ServiceStatus;
    ces: ServiceStatus;
  };
}

interface ExportRequestBody {
  startTime?: number;
  endTime?: number;
  auditLimit?: number;
  conversationId?: string;
}

export function createLogExportHandler(config: GatewayConfig) {
  return async (
    req: Request,
    _params: string[],
    _getClientIp: () => string,
  ): Promise<Response> => {
    const start = performance.now();

    // Parse optional JSON body
    let body: ExportRequestBody = {};
    try {
      const text = await req.text();
      if (text.trim()) {
        const parsed = JSON.parse(text);
        if (
          typeof parsed !== "object" ||
          parsed === null ||
          Array.isArray(parsed)
        ) {
          return Response.json(
            { error: "Body must be a JSON object" },
            { status: 400 },
          );
        }
        body = parsed;
      }
    } catch {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const { startTime, endTime } = body;

    // Create a temporary staging directory
    const stagingDir = join(
      tmpdir(),
      `vellum-log-export-${randomBytes(8).toString("hex")}`,
    );
    mkdirSync(stagingDir, { recursive: true });

    try {
      // Run all three collections in parallel
      const [gatewayResult, daemonResult, cesResult] = await Promise.allSettled(
        [
          collectGatewayLogs(config, stagingDir, startTime, endTime),
          collectDaemonExport(config, stagingDir, body),
          collectCesExport(stagingDir, startTime, endTime),
        ],
      );

      // Process results and write error files for failures
      const gatewayStatus = processResult(gatewayResult, "gateway", stagingDir);
      const daemonStatus = processResult(
        daemonResult,
        "daemon-export",
        stagingDir,
      );
      const cesStatus = processResult(cesResult, "ces-export", stagingDir);

      // Write export manifest
      const manifest: ExportManifest = {
        type: "multi-service-export",
        exportedAt: new Date().toISOString(),
        ...(startTime !== undefined ? { startTime } : {}),
        ...(endTime !== undefined ? { endTime } : {}),
        services: {
          gateway: gatewayStatus,
          daemon: daemonStatus,
          ces: cesStatus,
        },
      };

      await Bun.write(
        join(stagingDir, "export-manifest.json"),
        JSON.stringify(manifest, null, 2),
      );

      // Build final tar.gz archive
      const archivePath = `${stagingDir}.tar.gz`;
      const tarProc = Bun.spawn(
        ["/usr/bin/tar", "czf", archivePath, "-C", stagingDir, "."],
        { stdout: "pipe", stderr: "pipe" },
      );
      const tarExit = await tarProc.exited;
      if (tarExit !== 0) {
        const stderr = await new Response(tarProc.stderr).text();
        log.error(
          { exitCode: tarExit, stderr },
          "Failed to create tar.gz archive",
        );
        return Response.json(
          { error: "Failed to create export archive" },
          { status: 500 },
        );
      }

      const archiveData = await Bun.file(archivePath).arrayBuffer();
      const duration = Math.round(performance.now() - start);
      log.info(
        {
          duration,
          archiveBytes: archiveData.byteLength,
          gateway: gatewayStatus,
          daemon: daemonStatus,
          ces: cesStatus,
        },
        "Log export completed",
      );

      // Clean up the archive file (staging dir cleaned in finally)
      try {
        rmSync(archivePath, { force: true });
      } catch {
        // best-effort
      }

      return new Response(archiveData, {
        status: 200,
        headers: {
          "Content-Type": "application/gzip",
          "Content-Disposition":
            "attachment; filename=vellum-logs-export.tar.gz",
        },
      });
    } finally {
      // Clean up staging directory and archive file (which is a sibling, not inside staging)
      try {
        rmSync(stagingDir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
      try {
        rmSync(`${stagingDir}.tar.gz`, { force: true });
      } catch {
        // best-effort
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Result processing
// ---------------------------------------------------------------------------

function processResult(
  result: PromiseSettledResult<ServiceStatus>,
  label: string,
  stagingDir: string,
): ServiceStatus {
  if (result.status === "fulfilled") {
    return result.value;
  }

  const errMsg =
    result.reason instanceof Error
      ? result.reason.message
      : String(result.reason);
  log.warn({ error: errMsg }, `${label} collection failed`);

  // Write error file to staging so it's included in the archive
  try {
    const errorFilePath = join(stagingDir, `${label}-error.log`);
    const errorContent = `Collection failed at ${new Date().toISOString()}\n${errMsg}\n`;
    writeFileSync(errorFilePath, errorContent);
  } catch {
    // best-effort
  }

  return "error";
}

// ---------------------------------------------------------------------------
// Gateway log collection
// ---------------------------------------------------------------------------

async function collectGatewayLogs(
  config: GatewayConfig,
  stagingDir: string,
  startTime?: number,
  endTime?: number,
): Promise<ServiceStatus> {
  const logDir = config.logFile.dir;
  if (!logDir || !existsSync(logDir)) {
    log.info("No gateway log directory configured or found — skipping");
    return "ok";
  }

  const destDir = join(stagingDir, "gateway-logs");
  mkdirSync(destDir, { recursive: true });

  const startDate = startTime ? new Date(startTime) : undefined;
  const endDate = endTime ? new Date(endTime) : undefined;

  const entries = readdirSync(logDir);
  let totalBytes = 0;

  for (const name of entries) {
    const match = LOG_FILE_PATTERN.exec(name);
    if (!match) continue;

    const fileDateStr = match[1];
    const fileDate = new Date(fileDateStr + "T00:00:00Z");

    // Filter by date range when provided
    if (startDate) {
      // The log file covers a full day — skip if the file's day ends before startTime
      const fileDayEnd = new Date(fileDateStr + "T23:59:59.999Z");
      if (fileDayEnd < startDate) continue;
    }
    if (endDate) {
      // Skip if the file's day starts after endTime
      if (fileDate > endDate) continue;
    }

    const srcPath = join(logDir, name);
    const size = statSync(srcPath).size;

    // Enforce the 10 MB cap
    if (totalBytes + size > GATEWAY_LOG_CAP_BYTES) {
      log.info(
        { totalBytes, fileSize: size, cap: GATEWAY_LOG_CAP_BYTES },
        "Gateway log cap reached — skipping remaining files",
      );
      break;
    }

    // Copy the file to staging
    const srcFile = Bun.file(srcPath);
    await Bun.write(join(destDir, name), srcFile);
    totalBytes += size;
  }

  log.info(
    { fileCount: readdirSync(destDir).length, totalBytes },
    "Gateway logs collected",
  );
  return "ok";
}

// ---------------------------------------------------------------------------
// Daemon export collection
// ---------------------------------------------------------------------------

async function collectDaemonExport(
  config: GatewayConfig,
  stagingDir: string,
  requestBody: ExportRequestBody,
): Promise<ServiceStatus> {
  const destDir = join(stagingDir, "daemon-exports");
  mkdirSync(destDir, { recursive: true });

  const serviceToken = mintServiceToken();
  const upstream = `${config.assistantRuntimeBaseUrl}/v1/export`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort(
      new DOMException(
        "The operation was aborted due to timeout",
        "TimeoutError",
      ),
    );
  }, EXPORT_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetchImpl(upstream, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${serviceToken}`,
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
  } catch (err) {
    clearTimeout(timeoutId);
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw new Error("Daemon export request timed out");
    }
    throw new Error(
      `Daemon export connection failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "(unreadable)");
    throw new Error(
      `Daemon export returned ${response.status}: ${body.slice(0, 256)}`,
    );
  }

  // Write the daemon's tar.gz response to a temp file and extract
  const tarGzPath = join(stagingDir, "daemon-export.tar.gz");
  const data = await response.arrayBuffer();
  await Bun.write(tarGzPath, data);

  const extractProc = Bun.spawn(
    ["/usr/bin/tar", "xzf", tarGzPath, "-C", destDir],
    { stdout: "pipe", stderr: "pipe" },
  );
  const extractExit = await extractProc.exited;
  if (extractExit !== 0) {
    const stderr = await new Response(extractProc.stderr).text();
    log.warn(
      { exitCode: extractExit, stderr },
      "Failed to extract daemon export tar.gz — including raw archive",
    );
    // Move the raw tar.gz into the dest dir so we still have something
    try {
      renameSync(tarGzPath, join(destDir, "daemon-export.tar.gz"));
    } catch {
      // best-effort — clean up below will handle it
    }
    return "error";
  }

  // Clean up the temp tar.gz
  try {
    unlinkSync(tarGzPath);
  } catch {
    // best-effort
  }

  log.info("Daemon export collected");
  return "ok";
}

// ---------------------------------------------------------------------------
// CES export collection
// ---------------------------------------------------------------------------

async function collectCesExport(
  stagingDir: string,
  startTime?: number,
  endTime?: number,
): Promise<ServiceStatus> {
  const cesBaseUrl = process.env.CES_CREDENTIAL_URL?.trim();
  if (!cesBaseUrl) {
    log.info("CES_CREDENTIAL_URL not set — skipping CES export");
    return "skipped";
  }

  const cesServiceToken = process.env.CES_SERVICE_TOKEN?.trim();
  if (!cesServiceToken) {
    log.warn("CES_CREDENTIAL_URL is set but CES_SERVICE_TOKEN is missing");
    throw new Error(
      "CES_SERVICE_TOKEN is required when CES_CREDENTIAL_URL is set",
    );
  }

  const destDir = join(stagingDir, "ces-exports");
  mkdirSync(destDir, { recursive: true });

  // Build query params
  const params = new URLSearchParams();
  if (startTime !== undefined) params.set("startTime", String(startTime));
  if (endTime !== undefined) params.set("endTime", String(endTime));
  const queryString = params.toString();
  const url = `${cesBaseUrl}/v1/logs/export${queryString ? `?${queryString}` : ""}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort(
      new DOMException(
        "The operation was aborted due to timeout",
        "TimeoutError",
      ),
    );
  }, EXPORT_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${cesServiceToken}`,
      },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
  } catch (err) {
    clearTimeout(timeoutId);
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw new Error("CES export request timed out");
    }
    throw new Error(
      `CES export connection failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "(unreadable)");
    throw new Error(
      `CES export returned ${response.status}: ${body.slice(0, 256)}`,
    );
  }

  // Write the CES tar.gz response to a temp file and extract
  const tarGzPath = join(stagingDir, "ces-export.tar.gz");
  const data = await response.arrayBuffer();
  await Bun.write(tarGzPath, data);

  const extractProc = Bun.spawn(
    ["/usr/bin/tar", "xzf", tarGzPath, "-C", destDir],
    { stdout: "pipe", stderr: "pipe" },
  );
  const extractExit = await extractProc.exited;
  if (extractExit !== 0) {
    const stderr = await new Response(extractProc.stderr).text();
    log.warn(
      { exitCode: extractExit, stderr },
      "Failed to extract CES export tar.gz — including raw archive",
    );
    // Move the raw tar.gz into the dest dir so we still have something
    try {
      renameSync(tarGzPath, join(destDir, "ces-export.tar.gz"));
    } catch {
      // best-effort
    }
    return "error";
  }

  // Clean up the temp tar.gz
  try {
    unlinkSync(tarGzPath);
  } catch {
    // best-effort
  }

  log.info("CES export collected");
  return "ok";
}
