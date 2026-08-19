/**
 * Tests for `observeHostScreen()`, the conversation-agnostic screen
 * observation helper.
 *
 * Covers:
 *  1. A posted `host-cu-result` resolves the request with the AX tree, with no
 *     conversation and no tool call involved.
 *  2. A request that never resolves times out cleanly and returns a failure.
 *  3. `executionError` from the client surfaces as a structured failure.
 *  4. The pending interaction is unregistered on every path.
 *  5. No capable client connected: failure rather than a throw.
 *  6. `includeScreenshot: false` drops the screenshot from the result.
 *  7. Actor binding: another user's client is never selected by default, an
 *     explicit clientId owned by another user is rejected, a caller with no
 *     actor principal reaches nothing, and two same-user clients are
 *     ambiguous rather than fanned out to.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// Module mocks (must precede the real imports)

interface MockClient {
  clientId: string;
  capabilities: string[];
  actorPrincipalId?: string;
}

const ACTOR = "principal-a";
const OTHER_ACTOR = "principal-b";

const sentMessages: Record<string, unknown>[] = [];
let mockClients: MockClient[] = [];

mock.module("../assistant-event-hub.js", () => ({
  broadcastMessage: (msg: Record<string, unknown>) => {
    sentMessages.push(msg);
  },
  assistantEventHub: {
    getMostRecentClientByCapability: (cap: string) =>
      mockClients.find((c) => c.capabilities.includes(cap)),
    listClientsByCapability: (cap: string) =>
      mockClients.filter((c) => c.capabilities.includes(cap)),
    getClientById: (id: string) => mockClients.find((c) => c.clientId === id),
    getActorPrincipalIdForClient: (id: string) =>
      mockClients.find((c) => c.clientId === id)?.actorPrincipalId,
  },
}));

// Real imports (after mocks)

const pendingInteractions = await import("../pending-interactions.js");
const { observeHostScreen } = await import("../host-observe.js");
const { ROUTES } = await import("../routes/host-cu-routes.js");

const hostCuResultRoute = ROUTES.find(
  (r) => r.operationId === "host_cu_result",
);

/**
 * Deliver a client observation through the real `/v1/host-cu-result` route,
 * with the identity headers the targeted client sends.
 */
async function postResult(
  body: Record<string, unknown>,
  headers: Record<string, string> = {
    "x-vellum-client-id": "mac-1",
    "x-vellum-actor-principal-id": ACTOR,
  },
): Promise<void> {
  await hostCuResultRoute?.handler({ body, headers });
}

/** The requestId of the single `host_cu_request` broadcast so far. */
function sentRequestId(): string {
  const request = sentMessages.find((m) => m.type === "host_cu_request");
  expect(request).toBeDefined();
  return request?.requestId as string;
}

/** Observe as the actor that owns `mac-1` in the default fixture. */
function observe(
  options: Partial<Parameters<typeof observeHostScreen>[0]> = {},
) {
  return observeHostScreen({ sourceActorPrincipalId: ACTOR, ...options });
}

describe("observeHostScreen", () => {
  beforeEach(() => {
    sentMessages.length = 0;
    mockClients = [
      {
        clientId: "mac-1",
        capabilities: ["host_cu"],
        actorPrincipalId: ACTOR,
      },
    ];
    pendingInteractions.clear();
  });

  afterEach(() => {
    pendingInteractions.clear();
  });

  test("resolves with the AX tree from a posted client result", async () => {
    const observation = observe();

    const request = sentMessages.find((m) => m.type === "host_cu_request");
    expect(request?.toolName).toBe("computer_use_observe");
    expect(request?.input).toEqual({});
    expect(request?.conversationId).toBe("");

    const requestId = sentRequestId();
    expect(pendingInteractions.get(requestId)?.kind).toBe("host_cu");
    expect(pendingInteractions.get(requestId)?.targetClientId).toBe("mac-1");

    await postResult({
      requestId,
      axTree: "Window [1]\nButton [2]",
      screenshot: "base64png",
      screenWidthPt: 1440,
      screenHeightPt: 900,
    });

    expect(await observation).toEqual({
      ok: true,
      axTree: "Window [1]\nButton [2]",
      screenshot: "base64png",
      screenWidthPt: 1440,
      screenHeightPt: 900,
    });
    expect(pendingInteractions.getAll()).toHaveLength(0);
  });

  test("times out cleanly and unregisters the pending interaction", async () => {
    const result = await observe({ timeoutMs: 20 });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.timedOut).toBe(true);
      expect(result.reason).toContain("Timed out after 20ms");
    }
    expect(pendingInteractions.getAll()).toHaveLength(0);
    expect(sentMessages.some((m) => m.type === "host_cu_cancel")).toBe(true);
  });

  test("tolerates a late result posted after the timeout", async () => {
    const result = await observe({ timeoutMs: 20 });
    expect(result.ok).toBe(false);

    // The route 404s on an unknown requestId; a late post must not throw past
    // that, and must not resurrect the already-settled request.
    await expect(postResult({ requestId: sentRequestId() })).rejects.toThrow();
    expect(pendingInteractions.getAll()).toHaveLength(0);
  });

  test("surfaces executionError as a structured failure", async () => {
    const observation = observe();
    await postResult({
      requestId: sentRequestId(),
      executionError: "Accessibility permission not granted",
      axTree: "Window [1]",
    });

    const result = await observation;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("Accessibility permission not granted");
      expect(result.timedOut).toBeUndefined();
    }
    expect(pendingInteractions.getAll()).toHaveLength(0);
  });

  test("fails without throwing when no capable client is connected", async () => {
    mockClients = [];

    const result = await observe();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("No connected client");
    }
    expect(sentMessages).toHaveLength(0);
    expect(pendingInteractions.getAll()).toHaveLength(0);
  });

  test("drops the screenshot when includeScreenshot is false", async () => {
    const observation = observe({ includeScreenshot: false });
    await postResult({
      requestId: sentRequestId(),
      axTree: "Window [1]",
      screenshot: "base64png",
      screenshotWidthPx: 2880,
      screenshotHeightPx: 1800,
    });

    expect(await observation).toEqual({ ok: true, axTree: "Window [1]" });
  });

  describe("actor binding", () => {
    test("never selects another actor's client by default", async () => {
      mockClients = [
        {
          clientId: "mac-2",
          capabilities: ["host_cu"],
          actorPrincipalId: OTHER_ACTOR,
        },
      ];

      const result = await observe();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain("No connected client");
      }
      expect(sentMessages).toHaveLength(0);
      expect(pendingInteractions.getAll()).toHaveLength(0);
    });

    test("rejects an explicit clientId owned by another actor", async () => {
      mockClients.push({
        clientId: "mac-2",
        capabilities: ["host_cu"],
        actorPrincipalId: OTHER_ACTOR,
      });

      const result = await observe({ clientId: "mac-2" });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain("different user");
      }
      expect(sentMessages).toHaveLength(0);
      expect(pendingInteractions.getAll()).toHaveLength(0);
    });

    test("rejects a caller with no actor principal", async () => {
      const result = await observeHostScreen({
        sourceActorPrincipalId: undefined,
        clientId: "mac-1",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain("no authenticated actor");
      }
      expect(sentMessages).toHaveLength(0);
    });

    test("rejects a client that registered without an actor principal", async () => {
      mockClients = [{ clientId: "mac-1", capabilities: ["host_cu"] }];

      const result = await observe({ clientId: "mac-1" });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain("without an authenticated user");
      }
      expect(sentMessages).toHaveLength(0);
    });

    test("refuses to fan out across two clients owned by the actor", async () => {
      mockClients.push({
        clientId: "mac-3",
        capabilities: ["host_cu"],
        actorPrincipalId: ACTOR,
      });

      const result = await observe();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain("Specify target_client_id");
      }
      expect(sentMessages).toHaveLength(0);
    });

    test("succeeds on the same-actor path with an explicit clientId", async () => {
      mockClients.push({
        clientId: "mac-2",
        capabilities: ["host_cu"],
        actorPrincipalId: OTHER_ACTOR,
      });

      const observation = observe({ clientId: "mac-1" });
      await postResult({ requestId: sentRequestId(), axTree: "Window [1]" });

      expect(await observation).toEqual({ ok: true, axTree: "Window [1]" });
    });

    test("rejects a result submitted by another actor's client", async () => {
      const observation = observe({ timeoutMs: 200 });
      const requestId = sentRequestId();

      await expect(
        postResult(
          { requestId, axTree: "Window [1]" },
          {
            "x-vellum-client-id": "mac-1",
            "x-vellum-actor-principal-id": OTHER_ACTOR,
          },
        ),
      ).rejects.toThrow();

      const result = await observation;
      expect(result.ok).toBe(false);
    });
  });
});
