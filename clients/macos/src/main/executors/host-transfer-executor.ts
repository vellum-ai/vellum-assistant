/**
 * Host transfer executor — handles bidirectional file transfers between
 * the daemon sandbox and the host filesystem.
 *
 * Two directions:
 *  - to_host: pull file bytes from the daemon, verify SHA-256, write to disk.
 *  - to_sandbox: read file from disk, compute SHA-256, push bytes to daemon.
 *
 * Tracks in-flight transfers so cancellation can suppress late results.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { HostProxyExecutor } from "../host-proxy-router";
import type { HostProxyPoster } from "../host-proxy-poster";
import type { HostProxySseMessage } from "../host-proxy-sse";
import log from "../logger";

// ---------------------------------------------------------------------------
// Cancellation tracking
// ---------------------------------------------------------------------------

const cancelledRequests = new Set<string>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

// ---------------------------------------------------------------------------
// Direction handlers
// ---------------------------------------------------------------------------

async function handleToHost(
  message: HostProxySseMessage,
  poster: HostProxyPoster,
): Promise<void> {
  const requestId = message.requestId as string;
  const transferId = message.transferId as string;
  const destPath = message.destPath as string;
  const expectedSha = message.sha256 as string;
  const overwrite = message.overwrite as boolean | undefined;

  const data = await poster.pullTransferContent(transferId);

  if (cancelledRequests.has(requestId)) {
    cancelledRequests.delete(requestId);
    return;
  }

  if (data === null) {
    void poster.postTransferResult({
      requestId,
      isError: true,
      errorMessage: "Failed to pull transfer content from daemon",
    });
    return;
  }

  const actualSha = sha256(data);
  if (actualSha !== expectedSha) {
    void poster.postTransferResult({
      requestId,
      isError: true,
      errorMessage: `SHA-256 mismatch: expected ${expectedSha}, got ${actualSha}`,
    });
    return;
  }

  if (existsSync(destPath) && !overwrite) {
    void poster.postTransferResult({
      requestId,
      isError: true,
      errorMessage: `File already exists and overwrite is not set: ${destPath}`,
    });
    return;
  }

  try {
    mkdirSync(dirname(destPath), { recursive: true });
    writeFileSync(destPath, data);
  } catch (err) {
    void poster.postTransferResult({
      requestId,
      isError: true,
      errorMessage: `Failed to write file: ${err}`,
    });
    return;
  }

  void poster.postTransferResult({
    requestId,
    isError: false,
    bytesWritten: data.length,
  });
}

async function handleToSandbox(
  message: HostProxySseMessage,
  poster: HostProxyPoster,
): Promise<void> {
  const requestId = message.requestId as string;
  const transferId = message.transferId as string;
  const sourcePath = message.sourcePath as string;

  let data: Buffer;
  try {
    data = readFileSync(sourcePath);
  } catch (err) {
    void poster.postTransferResult({
      requestId,
      isError: true,
      errorMessage: `Failed to read source file: ${err}`,
    });
    return;
  }

  if (cancelledRequests.has(requestId)) {
    cancelledRequests.delete(requestId);
    return;
  }

  const hash = sha256(data);
  const pushed = await poster.pushTransferContent(transferId, data, hash);

  if (cancelledRequests.has(requestId)) {
    cancelledRequests.delete(requestId);
    return;
  }

  if (!pushed) {
    void poster.postTransferResult({
      requestId,
      isError: true,
      errorMessage: "Failed to push transfer content to daemon",
    });
    return;
  }

  void poster.postTransferResult({
    requestId,
    isError: false,
    bytesWritten: data.length,
  });
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export const hostTransferExecutor: HostProxyExecutor = {
  handleRequest(message: HostProxySseMessage, poster: HostProxyPoster): void {
    const direction = message.direction as string | undefined;
    const requestId = message.requestId as string | undefined;

    if (!requestId) {
      log.warn("[host-transfer] message missing requestId");
      return;
    }

    if (direction === "to_host") {
      void handleToHost(message, poster);
    } else if (direction === "to_sandbox") {
      void handleToSandbox(message, poster);
    } else {
      log.warn("[host-transfer] unknown direction", { direction, requestId });
      void poster.postTransferResult({
        requestId,
        isError: true,
        errorMessage: `Unknown transfer direction: ${direction}`,
      });
    }
  },

  handleCancel(message: HostProxySseMessage, _poster: HostProxyPoster): void {
    const requestId = message.requestId as string | undefined;
    if (requestId) {
      cancelledRequests.add(requestId);
    }
  },
};

// ---------------------------------------------------------------------------
// Test seam
// ---------------------------------------------------------------------------

export const __testing = {
  get cancelledRequests() {
    return cancelledRequests;
  },
  reset() {
    cancelledRequests.clear();
  },
};
