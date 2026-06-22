import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Stubs — must precede the executor import
// ---------------------------------------------------------------------------

mock.module("electron-log/main", () => {
  const noop = () => {};
  return {
    default: {
      info: noop,
      warn: noop,
      error: noop,
      debug: noop,
      initialize: noop,
      transports: {
        file: {
          maxSize: 0,
          fileName: "",
          format: "",
          getFile: () => ({ path: "" }),
        },
      },
    },
  };
});

const MOCK_DEVICE_ID = "test-device-00000000-0000-0000-0000-000000000000";
mock.module("../device-id", () => ({
  getDeviceId: () => MOCK_DEVICE_ID,
  resetDeviceIdCache: () => {},
}));

const { HostProxyPoster } = await import("../host-proxy-poster");
const { hostTransferExecutor, __testing } = await import(
  "./host-transfer-executor"
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_DIR = path.join(
  os.tmpdir(),
  `host-transfer-test-${process.pid}`,
);

function sha256hex(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

interface PosterCapture {
  poster: InstanceType<typeof HostProxyPoster>;
  transferResult: () => Record<string, unknown> | null;
  pullData: Buffer;
  pushCalls: Array<{ transferId: string; data: Buffer; sha256: string }>;
  pushReturn: boolean;
}

/**
 * Build a poster with injectable pull/push behavior and result capture.
 */
function capturingPoster(opts: {
  pullData?: Buffer;
  pushReturn?: boolean;
}): PosterCapture {
  const pullData = opts.pullData ?? Buffer.alloc(0);
  const pushReturn = opts.pushReturn ?? true;
  let transferResult: Record<string, unknown> | null = null;
  const pushCalls: PosterCapture["pushCalls"] = [];

  const fakeFetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();

    // POST to host-transfer-result
    if (url.includes("/v1/host-transfer-result") && init?.method === "POST") {
      transferResult = JSON.parse(init.body as string);
      return new Response("ok");
    }

    // GET transfer content (pull)
    if (url.includes("/v1/transfers/") && init?.method === "GET") {
      if (pullData.length === 0) {
        return new Response(null, { status: 404 });
      }
      return new Response(pullData, { status: 200 });
    }

    // PUT transfer content (push)
    if (url.includes("/v1/transfers/") && init?.method === "PUT") {
      const idMatch = url.match(/\/v1\/transfers\/([^/]+)\/content/);
      const transferId = idMatch ? decodeURIComponent(idMatch[1]) : "";
      const headers = init.headers as Record<string, string>;
      let body: Buffer;
      if (Buffer.isBuffer(init.body)) {
        body = init.body;
      } else if (init.body instanceof Uint8Array) {
        body = Buffer.from(init.body);
      } else {
        body = Buffer.from(init.body as string);
      }
      pushCalls.push({
        transferId,
        data: body,
        sha256: headers["X-Transfer-SHA256"],
      });
      return new Response("ok", { status: pushReturn ? 200 : 500 });
    }

    return new Response("not found", { status: 404 });
  };

  const poster = new HostProxyPoster({
    endpointBase: "http://127.0.0.1:9000/v1",
    authHeaders: () => ({ Authorization: "Bearer test-token" }),
    fetch: fakeFetch as typeof globalThis.fetch,
  });

  return {
    poster,
    transferResult: () => transferResult,
    pullData,
    pushCalls,
    pushReturn,
  };
}

async function flush(ms = 50): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("host-transfer-executor", () => {
  beforeEach(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    __testing.reset();
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // -- to_host --------------------------------------------------------------

  describe("to_host", () => {
    test("writes file with SHA-256 verification", async () => {
      const fileContent = Buffer.from("hello, host filesystem!");
      const hash = sha256hex(fileContent);
      const destPath = path.join(TEST_DIR, "subdir", "received.txt");

      const cap = capturingPoster({ pullData: fileContent });

      hostTransferExecutor.handleRequest(
        {
          type: "host_transfer_request",
          requestId: "r1",
          direction: "to_host",
          transferId: "xfer-1",
          destPath,
          sha256: hash,
          overwrite: false,
        },
        cap.poster,
      );
      await flush();

      expect(cap.transferResult()).not.toBeNull();
      expect(cap.transferResult()!.requestId).toBe("r1");
      expect(cap.transferResult()!.isError).toBe(false);
      expect(cap.transferResult()!.bytesWritten).toBe(fileContent.length);

      const written = fs.readFileSync(destPath);
      expect(written.toString()).toBe("hello, host filesystem!");
    });

    test("fails on SHA-256 mismatch", async () => {
      const fileContent = Buffer.from("correct data");
      const destPath = path.join(TEST_DIR, "bad-sha.txt");

      const cap = capturingPoster({ pullData: fileContent });

      hostTransferExecutor.handleRequest(
        {
          type: "host_transfer_request",
          requestId: "r2",
          direction: "to_host",
          transferId: "xfer-2",
          destPath,
          sha256: "0000000000000000000000000000000000000000000000000000000000000000",
          overwrite: false,
        },
        cap.poster,
      );
      await flush();

      expect(cap.transferResult()!.isError).toBe(true);
      expect(cap.transferResult()!.errorMessage).toContain("SHA-256 mismatch");
      expect(fs.existsSync(destPath)).toBe(false);
    });

    test("respects overwrite=false when file exists", async () => {
      const destPath = path.join(TEST_DIR, "existing.txt");
      fs.writeFileSync(destPath, "original");

      const fileContent = Buffer.from("replacement");
      const hash = sha256hex(fileContent);
      const cap = capturingPoster({ pullData: fileContent });

      hostTransferExecutor.handleRequest(
        {
          type: "host_transfer_request",
          requestId: "r3",
          direction: "to_host",
          transferId: "xfer-3",
          destPath,
          sha256: hash,
          overwrite: false,
        },
        cap.poster,
      );
      await flush();

      expect(cap.transferResult()!.isError).toBe(true);
      expect(cap.transferResult()!.errorMessage).toContain("already exists");
      expect(fs.readFileSync(destPath, "utf-8")).toBe("original");
    });

    test("overwrites when overwrite=true", async () => {
      const destPath = path.join(TEST_DIR, "overwrite-me.txt");
      fs.writeFileSync(destPath, "original");

      const fileContent = Buffer.from("replacement");
      const hash = sha256hex(fileContent);
      const cap = capturingPoster({ pullData: fileContent });

      hostTransferExecutor.handleRequest(
        {
          type: "host_transfer_request",
          requestId: "r4",
          direction: "to_host",
          transferId: "xfer-4",
          destPath,
          sha256: hash,
          overwrite: true,
        },
        cap.poster,
      );
      await flush();

      expect(cap.transferResult()!.isError).toBe(false);
      expect(fs.readFileSync(destPath, "utf-8")).toBe("replacement");
    });

    test("reports error when pull returns empty data", async () => {
      const cap = capturingPoster({ pullData: Buffer.alloc(0) });

      hostTransferExecutor.handleRequest(
        {
          type: "host_transfer_request",
          requestId: "r5",
          direction: "to_host",
          transferId: "xfer-5",
          destPath: path.join(TEST_DIR, "nope.txt"),
          sha256: "abc",
        },
        cap.poster,
      );
      await flush();

      expect(cap.transferResult()!.isError).toBe(true);
      expect(cap.transferResult()!.errorMessage).toContain(
        "Failed to pull transfer content",
      );
    });
  });

  // -- to_sandbox -----------------------------------------------------------

  describe("to_sandbox", () => {
    test("reads file and pushes with SHA-256", async () => {
      const sourcePath = path.join(TEST_DIR, "upload.txt");
      const content = Buffer.from("push me to sandbox");
      fs.writeFileSync(sourcePath, content);

      const cap = capturingPoster({ pushReturn: true });

      hostTransferExecutor.handleRequest(
        {
          type: "host_transfer_request",
          requestId: "r6",
          direction: "to_sandbox",
          transferId: "xfer-6",
          sourcePath,
        },
        cap.poster,
      );
      await flush();

      expect(cap.transferResult()!.isError).toBe(false);
      expect(cap.transferResult()!.bytesWritten).toBe(content.length);

      expect(cap.pushCalls).toHaveLength(1);
      expect(cap.pushCalls[0].transferId).toBe("xfer-6");
      expect(cap.pushCalls[0].data.toString()).toBe("push me to sandbox");
      expect(cap.pushCalls[0].sha256).toBe(sha256hex(content));
    });

    test("reports error when source file does not exist", async () => {
      const cap = capturingPoster({ pushReturn: true });

      hostTransferExecutor.handleRequest(
        {
          type: "host_transfer_request",
          requestId: "r7",
          direction: "to_sandbox",
          transferId: "xfer-7",
          sourcePath: path.join(TEST_DIR, "nonexistent.txt"),
        },
        cap.poster,
      );
      await flush();

      expect(cap.transferResult()!.isError).toBe(true);
      expect(cap.transferResult()!.errorMessage).toContain(
        "Failed to read source file",
      );
    });

    test("reports error when push fails", async () => {
      const sourcePath = path.join(TEST_DIR, "push-fail.txt");
      fs.writeFileSync(sourcePath, "data");

      const cap = capturingPoster({ pushReturn: false });

      hostTransferExecutor.handleRequest(
        {
          type: "host_transfer_request",
          requestId: "r8",
          direction: "to_sandbox",
          transferId: "xfer-8",
          sourcePath,
        },
        cap.poster,
      );
      await flush();

      expect(cap.transferResult()!.isError).toBe(true);
      expect(cap.transferResult()!.errorMessage).toContain(
        "Failed to push transfer content",
      );
    });
  });

  // -- Cancellation ---------------------------------------------------------

  describe("cancellation", () => {
    test("cancelling suppresses the result for to_host", async () => {
      const fileContent = Buffer.from("cancelled transfer");
      const hash = sha256hex(fileContent);
      const destPath = path.join(TEST_DIR, "cancelled.txt");

      // Use a slow pull to give us time to cancel
      let pullResolve: ((value: Response) => void) | null = null;
      const slowFetch = async (
        input: string | URL | Request,
        init?: RequestInit,
      ): Promise<Response> => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/v1/transfers/") && init?.method === "GET") {
          return new Promise<Response>((resolve) => {
            pullResolve = resolve;
          });
        }
        if (url.includes("/v1/host-transfer-result")) {
          return new Response("ok");
        }
        return new Response("not found", { status: 404 });
      };

      const poster = new HostProxyPoster({
        endpointBase: "http://127.0.0.1:9000/v1",
        authHeaders: () => ({ Authorization: "Bearer t" }),
        fetch: slowFetch as typeof globalThis.fetch,
      });

      hostTransferExecutor.handleRequest(
        {
          type: "host_transfer_request",
          requestId: "cancel-1",
          direction: "to_host",
          transferId: "xfer-cancel",
          destPath,
          sha256: hash,
        },
        poster,
      );

      // Cancel before pull resolves
      hostTransferExecutor.handleCancel(
        { type: "host_transfer_cancel", requestId: "cancel-1" },
        poster,
      );

      // Now resolve the pull
      pullResolve!(new Response(fileContent, { status: 200 }));
      await flush();

      // File should not be written because the request was cancelled
      expect(fs.existsSync(destPath)).toBe(false);
    });

    test("cancelling a to_sandbox suppresses the result", async () => {
      const sourcePath = path.join(TEST_DIR, "cancel-upload.txt");
      fs.writeFileSync(sourcePath, "data");

      let transferResult: Record<string, unknown> | null = null;
      let pushResolve: ((value: Response) => void) | null = null;

      const slowFetch = async (
        input: string | URL | Request,
        init?: RequestInit,
      ): Promise<Response> => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/v1/transfers/") && init?.method === "PUT") {
          return new Promise<Response>((resolve) => {
            pushResolve = resolve;
          });
        }
        if (url.includes("/v1/host-transfer-result") && init?.method === "POST") {
          transferResult = JSON.parse(init.body as string);
          return new Response("ok");
        }
        return new Response("not found", { status: 404 });
      };

      const poster = new HostProxyPoster({
        endpointBase: "http://127.0.0.1:9000/v1",
        authHeaders: () => ({ Authorization: "Bearer t" }),
        fetch: slowFetch as typeof globalThis.fetch,
      });

      hostTransferExecutor.handleRequest(
        {
          type: "host_transfer_request",
          requestId: "cancel-2",
          direction: "to_sandbox",
          transferId: "xfer-cancel-2",
          sourcePath,
        },
        poster,
      );

      // Cancel before push resolves
      hostTransferExecutor.handleCancel(
        { type: "host_transfer_cancel", requestId: "cancel-2" },
        poster,
      );

      // Resolve the push
      pushResolve!(new Response("ok", { status: 200 }));
      await flush();

      // No result should have been posted
      expect(transferResult).toBeNull();
    });
  });

  // -- Edge cases -----------------------------------------------------------

  describe("edge cases", () => {
    test("unknown direction posts error", async () => {
      const cap = capturingPoster({});

      hostTransferExecutor.handleRequest(
        {
          type: "host_transfer_request",
          requestId: "r-bad",
          direction: "sideways",
          transferId: "xfer-bad",
        },
        cap.poster,
      );
      await flush();

      expect(cap.transferResult()!.isError).toBe(true);
      expect(cap.transferResult()!.errorMessage).toContain("Unknown transfer direction");
    });

    test("missing requestId is a no-op", () => {
      const cap = capturingPoster({});

      // Should not throw
      hostTransferExecutor.handleRequest(
        { type: "host_transfer_request", direction: "to_host" },
        cap.poster,
      );

      expect(cap.transferResult()).toBeNull();
    });
  });
});
