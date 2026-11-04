import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { LockfileAssistant } from "@/runtime/local-mode-host";

import type * as GatewayClient from "./teleport-gateway-client";
import type {
  LocalGateway,
  LocalImportStart,
  LocalMigrationJob,
} from "./teleport-gateway-client";

let connections = 0;
const connectMock = mock(
  async (_assistant: LockfileAssistant): Promise<LocalGateway> => {
    connections += 1;
    return { base: "http://gateway.test", token: `token-${connections}` };
  },
);
const startMock = mock(
  async (
    _gateway: LocalGateway,
    _bundleUrl: string,
  ): Promise<LocalImportStart> => ({ ok: true, jobId: "job-1" }),
);
const pollMock = mock(
  async (
    _gateway: LocalGateway,
    _jobId: string,
    _failureCode: string,
  ): Promise<LocalMigrationJob> => ({ status: "complete" }),
);

mock.module(
  "./teleport-gateway-client",
  (): Partial<typeof GatewayClient> => ({
    connectLocalGateway: connectMock,
    startLocalImportFromUrl: startMock,
    pollLocalMigrationJob: pollMock,
  }),
);

const { importBundleToLocal } = await import("./local-import");
const { TeleportError } = await import("./teleport-types");

const LOCAL = {
  assistantId: "ast-local",
  cloud: "local",
} as unknown as LockfileAssistant;

const BUNDLE_URL =
  "https://storage.googleapis.com/bucket/uploads/org-abc/bundle.vbundle?sig=abc";

const FAST = {
  startAttempts: 3,
  startRetryMs: 1,
  pollIntervalMs: 1,
  timeoutMs: 200,
  maxConsecutivePollErrors: 2,
};

function gateway(n: number): LocalGateway {
  return { base: "http://gateway.test", token: `token-${n}` };
}

beforeEach(() => {
  connections = 0;
  connectMock.mockClear();
  startMock.mockReset();
  startMock.mockResolvedValue({ ok: true, jobId: "job-1" });
  pollMock.mockReset();
  pollMock.mockResolvedValue({ status: "complete" });
});

describe("importBundleToLocal", () => {
  test("starts a runtime-side import of the signed URL and polls it on one connection", async () => {
    pollMock
      .mockResolvedValueOnce({ status: "processing" })
      .mockResolvedValueOnce({ status: "complete" });

    await importBundleToLocal(LOCAL, BUNDLE_URL, FAST);

    expect(connectMock.mock.calls).toEqual([[LOCAL]]);
    expect(startMock.mock.calls).toEqual([[gateway(1), BUNDLE_URL]]);
    expect(pollMock.mock.calls).toEqual([
      [gateway(1), "job-1", "import_failed"],
      [gateway(1), "job-1", "import_failed"],
    ]);
  });

  test("retries the start while the gateway is still coming up", async () => {
    connectMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    startMock
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        message: "Import failed (HTTP 503).",
      })
      .mockResolvedValueOnce({ ok: true, jobId: "job-2" });

    await importBundleToLocal(LOCAL, BUNDLE_URL, FAST);

    expect(connectMock).toHaveBeenCalledTimes(3);
    expect(startMock).toHaveBeenCalledTimes(2);
    expect(pollMock.mock.calls[0]?.[1]).toBe("job-2");
  });

  test("fails without retrying when the runtime refuses the bundle URL", async () => {
    startMock.mockResolvedValue({
      ok: false,
      status: 400,
      message: "Invalid bundle URL: host not allowed",
    });

    const error = await importBundleToLocal(LOCAL, BUNDLE_URL, FAST).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(TeleportError);
    expect(error).toMatchObject({
      code: "import_failed",
      message: "Invalid bundle URL: host not allowed",
    });
    expect(startMock).toHaveBeenCalledTimes(1);
    expect(pollMock).not.toHaveBeenCalled();
  });

  test("surfaces the last start error once the attempts run out", async () => {
    startMock.mockRejectedValue(new TypeError("Failed to fetch"));

    await expect(importBundleToLocal(LOCAL, BUNDLE_URL, FAST)).rejects.toThrow(
      "Failed to fetch",
    );
    expect(startMock).toHaveBeenCalledTimes(FAST.startAttempts);
  });

  test("fails with the runtime's error when the import job fails", async () => {
    pollMock.mockResolvedValue({
      status: "failed",
      error: "Bundle exceeds the 16 GiB limit",
    });

    const error = await importBundleToLocal(LOCAL, BUNDLE_URL, FAST).catch(
      (e: unknown) => e,
    );

    expect(error).toMatchObject({
      code: "import_failed",
      message: "Bundle exceeds the 16 GiB limit",
    });
  });

  test("falls back to a generic message when a failed job carries no error", async () => {
    pollMock.mockResolvedValue({ status: "failed" });

    await expect(importBundleToLocal(LOCAL, BUNDLE_URL, FAST)).rejects.toThrow(
      "Import job failed.",
    );
  });

  test("rides out transient poll errors and reconnects after each", async () => {
    pollMock
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce({ status: "processing" })
      .mockResolvedValueOnce({ status: "complete" });

    await importBundleToLocal(LOCAL, BUNDLE_URL, FAST);

    expect(pollMock.mock.calls.map((call) => call[0])).toEqual([
      gateway(1),
      gateway(2),
      gateway(3),
      gateway(3),
    ]);
  });

  test("gives up after too many consecutive poll errors", async () => {
    pollMock.mockRejectedValue(
      new TeleportError("import_failed", "Job status check failed (HTTP 404)."),
    );

    await expect(importBundleToLocal(LOCAL, BUNDLE_URL, FAST)).rejects.toThrow(
      "Job status check failed (HTTP 404).",
    );
    expect(pollMock).toHaveBeenCalledTimes(FAST.maxConsecutivePollErrors + 1);
  });

  test("times out when the job never finishes", async () => {
    pollMock.mockResolvedValue({ status: "processing" });

    await expect(
      importBundleToLocal(LOCAL, BUNDLE_URL, { ...FAST, timeoutMs: 20 }),
    ).rejects.toThrow("Import timed out after 60 minutes.");
  });
});
