/**
 * Tests for the host-transfer route 403 guard introduced in Phase 3.
 *
 * Covers GET /transfers/:transferId/content, PUT /transfers/:transferId/content,
 * and POST /host-transfer-result ownership checks.
 *
 *  1. Targeted + correct x-vellum-client-id header → success
 *  2. Targeted + missing header → 400 BadRequestError
 *  3. Targeted + wrong header → 403 ForbiddenError, operation NOT performed
 *  4. Untargeted (no targetClientId, no header) → success (regression)
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

// ── Module mocks ────────────────────────────────────────────────────────────

mock.module("../config/env.js", () => ({
  isHttpAuthDisabled: () => true,
  hasUngatedHttpAuthDisabled: () => false,
}));

import type { PendingInteraction } from "../runtime/pending-interactions.js";

const pendingStore = new Map<string, PendingInteraction>();

mock.module("../runtime/pending-interactions.js", () => ({
  get: (requestId: string) => pendingStore.get(requestId),
  resolve: (requestId: string) => {
    const entry = pendingStore.get(requestId);
    if (entry) pendingStore.delete(requestId);
    return entry;
  },
}));

// Per-test controls for the proxy stub
let stubTargetClientId: string | null = null;
const getTransferContentCalls: string[] = [];
const receiveTransferContentCalls: string[] = [];
const resolveTransferResultCalls: string[] = [];

mock.module("../daemon/host-transfer-proxy.js", () => ({
  HostTransferProxy: {
    get instance() {
      return {
        getRequestIdForTransfer(_transferId: string) {
          return "req-1";
        },
        getTargetClientIdForTransfer(_transferId: string) {
          return stubTargetClientId;
        },
        getTransferContent(transferId: string) {
          getTransferContentCalls.push(transferId);
          return { buffer: Buffer.from("data"), sizeBytes: 4, sha256: "abc123" };
        },
        async receiveTransferContent(transferId: string, _data: Buffer, _sha256: string) {
          receiveTransferContentCalls.push(transferId);
          return { accepted: true };
        },
        resolveTransferResult(requestId: string, _result: unknown) {
          resolveTransferResultCalls.push(requestId);
        },
      };
    },
  },
}));

// ── Real imports (after mocks) ──────────────────────────────────────────────

import {
  BadRequestError,
  ForbiddenError,
} from "../runtime/routes/errors.js";
import { ROUTES } from "../runtime/routes/host-transfer-routes.js";

afterAll(() => {
  mock.restore();
});

const handleTransferContentGet = ROUTES.find(
  (r) => r.endpoint === "transfers/:transferId/content" && r.method === "GET",
)!.handler;

const handleTransferContentPut = ROUTES.find(
  (r) => r.endpoint === "transfers/:transferId/content" && r.method === "PUT",
)!.handler;

const handleTransferResult = ROUTES.find(
  (r) => r.endpoint === "host-transfer-result",
)!.handler;

// ── Helpers ─────────────────────────────────────────────────────────────────

const TEST_TRANSFER_ID = "transfer-abc";
const TEST_REQUEST_ID = "req-1";

function registerPending(overrides: Partial<PendingInteraction> = {}): void {
  pendingStore.set(TEST_REQUEST_ID, {
    conversationId: "conv-1",
    kind: "host_transfer",
    ...overrides,
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("handleTransferContentGet — Phase 3 targetClientId guard", () => {
  beforeEach(() => {
    pendingStore.clear();
    stubTargetClientId = null;
    getTransferContentCalls.length = 0;
  });

  // ── 1. Targeted + correct header → success ────────────────────────────────

  describe("targeted + correct x-vellum-client-id header", () => {
    test("returns Uint8Array and calls getTransferContent", async () => {
      stubTargetClientId = "client-A";
      const result = await handleTransferContentGet({
        pathParams: { transferId: TEST_TRANSFER_ID },
        headers: { "x-vellum-client-id": "client-A" },
      });

      expect(result).toBeInstanceOf(Uint8Array);
      expect(getTransferContentCalls).toContain(TEST_TRANSFER_ID);
    });

    test("trims whitespace from header before comparing", async () => {
      stubTargetClientId = "client-A";
      const result = await handleTransferContentGet({
        pathParams: { transferId: TEST_TRANSFER_ID },
        headers: { "x-vellum-client-id": "  client-A  " },
      });

      expect(result).toBeInstanceOf(Uint8Array);
    });
  });

  // ── 2. Targeted + missing header → 400 ───────────────────────────────────

  describe("targeted + missing x-vellum-client-id header", () => {
    test("throws BadRequestError when header is absent", () => {
      stubTargetClientId = "client-A";
      expect(() =>
        handleTransferContentGet({
          pathParams: { transferId: TEST_TRANSFER_ID },
        }),
      ).toThrow(BadRequestError);
    });

    test("getTransferContent NOT called on 400", () => {
      stubTargetClientId = "client-A";
      try {
        handleTransferContentGet({
          pathParams: { transferId: TEST_TRANSFER_ID },
        });
      } catch {
        // expected
      }
      expect(getTransferContentCalls).toHaveLength(0);
    });
  });

  // ── 3. Targeted + wrong header → 403 ─────────────────────────────────────

  describe("targeted + wrong x-vellum-client-id header", () => {
    test("throws ForbiddenError when client ID does not match", () => {
      stubTargetClientId = "client-A";
      expect(() =>
        handleTransferContentGet({
          pathParams: { transferId: TEST_TRANSFER_ID },
          headers: { "x-vellum-client-id": "client-B" },
        }),
      ).toThrow(ForbiddenError);
    });

    test("getTransferContent NOT called on 403", () => {
      stubTargetClientId = "client-A";
      try {
        handleTransferContentGet({
          pathParams: { transferId: TEST_TRANSFER_ID },
          headers: { "x-vellum-client-id": "client-B" },
        });
      } catch {
        // expected
      }
      expect(getTransferContentCalls).toHaveLength(0);
    });
  });

  // ── 4. Untargeted — regression ────────────────────────────────────────────

  describe("untargeted request (no targetClientId)", () => {
    test("returns Uint8Array without a header", async () => {
      stubTargetClientId = null;
      const result = await handleTransferContentGet({
        pathParams: { transferId: TEST_TRANSFER_ID },
      });

      expect(result).toBeInstanceOf(Uint8Array);
      expect(getTransferContentCalls).toContain(TEST_TRANSFER_ID);
    });
  });
});

describe("handleTransferContentPut — Phase 3 targetClientId guard", () => {
  beforeEach(() => {
    pendingStore.clear();
    stubTargetClientId = null;
    receiveTransferContentCalls.length = 0;
  });

  // ── 1. Targeted + correct header → success ────────────────────────────────

  describe("targeted + correct x-vellum-client-id header", () => {
    test("returns { accepted: true } and calls receiveTransferContent", async () => {
      stubTargetClientId = "client-A";
      const result = await handleTransferContentPut({
        pathParams: { transferId: TEST_TRANSFER_ID },
        headers: { "x-vellum-client-id": "client-A", "x-transfer-sha256": "abc" },
        rawBody: new Uint8Array(Buffer.from("data")),
      });

      expect(result).toEqual({ accepted: true });
      expect(receiveTransferContentCalls).toContain(TEST_TRANSFER_ID);
    });

    test("trims whitespace from header before comparing", async () => {
      stubTargetClientId = "client-A";
      const result = await handleTransferContentPut({
        pathParams: { transferId: TEST_TRANSFER_ID },
        headers: { "x-vellum-client-id": "  client-A  ", "x-transfer-sha256": "abc" },
        rawBody: new Uint8Array(Buffer.from("data")),
      });

      expect(result).toEqual({ accepted: true });
    });
  });

  // ── 2. Targeted + missing header → 400 ───────────────────────────────────

  describe("targeted + missing x-vellum-client-id header", () => {
    test("throws BadRequestError when header is absent", async () => {
      stubTargetClientId = "client-A";
      await expect(
        handleTransferContentPut({
          pathParams: { transferId: TEST_TRANSFER_ID },
          headers: { "x-transfer-sha256": "abc" },
          rawBody: new Uint8Array(Buffer.from("data")),
        }),
      ).rejects.toBeInstanceOf(BadRequestError);
    });

    test("receiveTransferContent NOT called on 400", async () => {
      stubTargetClientId = "client-A";
      try {
        await handleTransferContentPut({
          pathParams: { transferId: TEST_TRANSFER_ID },
          headers: { "x-transfer-sha256": "abc" },
          rawBody: new Uint8Array(Buffer.from("data")),
        });
      } catch {
        // expected
      }
      expect(receiveTransferContentCalls).toHaveLength(0);
    });
  });

  // ── 3. Targeted + wrong header → 403 ─────────────────────────────────────

  describe("targeted + wrong x-vellum-client-id header", () => {
    test("throws ForbiddenError when client ID does not match", async () => {
      stubTargetClientId = "client-A";
      await expect(
        handleTransferContentPut({
          pathParams: { transferId: TEST_TRANSFER_ID },
          headers: { "x-vellum-client-id": "client-B", "x-transfer-sha256": "abc" },
          rawBody: new Uint8Array(Buffer.from("data")),
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    test("receiveTransferContent NOT called on 403", async () => {
      stubTargetClientId = "client-A";
      try {
        await handleTransferContentPut({
          pathParams: { transferId: TEST_TRANSFER_ID },
          headers: { "x-vellum-client-id": "client-B", "x-transfer-sha256": "abc" },
          rawBody: new Uint8Array(Buffer.from("data")),
        });
      } catch {
        // expected
      }
      expect(receiveTransferContentCalls).toHaveLength(0);
    });
  });

  // ── 4. Untargeted — regression ────────────────────────────────────────────

  describe("untargeted request (no targetClientId)", () => {
    test("returns { accepted: true } without a header", async () => {
      stubTargetClientId = null;
      const result = await handleTransferContentPut({
        pathParams: { transferId: TEST_TRANSFER_ID },
        headers: { "x-transfer-sha256": "abc" },
        rawBody: new Uint8Array(Buffer.from("data")),
      });

      expect(result).toEqual({ accepted: true });
      expect(receiveTransferContentCalls).toContain(TEST_TRANSFER_ID);
    });
  });
});

describe("handleTransferResult — Phase 3 targetClientId guard", () => {
  beforeEach(() => {
    pendingStore.clear();
    stubTargetClientId = null;
    resolveTransferResultCalls.length = 0;
  });

  function registerHostTransferPending(targetClientId?: string): void {
    registerPending({ targetClientId });
  }

  function resultBody(): Record<string, unknown> {
    return { requestId: TEST_REQUEST_ID };
  }

  // ── 1. Targeted + correct header → success ────────────────────────────────

  describe("targeted + correct x-vellum-client-id header", () => {
    test("returns { accepted: true } and calls resolveTransferResult", async () => {
      registerHostTransferPending("client-A");
      const result = await handleTransferResult({
        body: resultBody(),
        headers: { "x-vellum-client-id": "client-A" },
      });

      expect(result).toEqual({ accepted: true });
      expect(resolveTransferResultCalls).toContain(TEST_REQUEST_ID);
    });

    test("trims whitespace from header before comparing", async () => {
      registerHostTransferPending("client-A");
      const result = await handleTransferResult({
        body: resultBody(),
        headers: { "x-vellum-client-id": "  client-A  " },
      });

      expect(result).toEqual({ accepted: true });
    });
  });

  // ── 2. Targeted + missing header → 400 ───────────────────────────────────

  describe("targeted + missing x-vellum-client-id header", () => {
    test("throws BadRequestError when header is absent", () => {
      registerHostTransferPending("client-A");
      expect(() =>
        handleTransferResult({ body: resultBody() }),
      ).toThrow(BadRequestError);
    });

    test("resolveTransferResult NOT called on 400", () => {
      registerHostTransferPending("client-A");
      try {
        handleTransferResult({ body: resultBody() });
      } catch {
        // expected
      }
      expect(resolveTransferResultCalls).toHaveLength(0);
    });

    test("pending interaction still present after 400", () => {
      registerHostTransferPending("client-A");
      try {
        handleTransferResult({ body: resultBody() });
      } catch {
        // expected
      }
      expect(pendingStore.has(TEST_REQUEST_ID)).toBe(true);
    });
  });

  // ── 3. Targeted + wrong header → 403 ─────────────────────────────────────

  describe("targeted + wrong x-vellum-client-id header", () => {
    test("throws ForbiddenError when client ID does not match", () => {
      registerHostTransferPending("client-A");
      expect(() =>
        handleTransferResult({
          body: resultBody(),
          headers: { "x-vellum-client-id": "client-B" },
        }),
      ).toThrow(ForbiddenError);
    });

    test("resolveTransferResult NOT called on 403", () => {
      registerHostTransferPending("client-A");
      try {
        handleTransferResult({
          body: resultBody(),
          headers: { "x-vellum-client-id": "client-B" },
        });
      } catch {
        // expected
      }
      expect(resolveTransferResultCalls).toHaveLength(0);
    });

    test("pending interaction still present after 403", () => {
      registerHostTransferPending("client-A");
      try {
        handleTransferResult({
          body: resultBody(),
          headers: { "x-vellum-client-id": "client-B" },
        });
      } catch {
        // expected
      }
      expect(pendingStore.has(TEST_REQUEST_ID)).toBe(true);
    });
  });

  // ── 4. Untargeted — regression ────────────────────────────────────────────

  describe("untargeted request (no targetClientId)", () => {
    test("accepts when no header is provided", async () => {
      registerHostTransferPending();
      const result = await handleTransferResult({
        body: resultBody(),
      });

      expect(result).toEqual({ accepted: true });
      expect(resolveTransferResultCalls).toContain(TEST_REQUEST_ID);
    });

    test("accepts when header is present (header ignored for untargeted)", async () => {
      registerHostTransferPending();
      const result = await handleTransferResult({
        body: resultBody(),
        headers: { "x-vellum-client-id": "client-whatever" },
      });

      expect(result).toEqual({ accepted: true });
    });
  });
});
