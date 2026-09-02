import * as fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";

// The feed writer publishes `home_feed_updated` on every write; the hub is
// stubbed so tests run without an SSE server. Mocked before the writer
// module is imported so the import picks it up.
mock.module("../../runtime/assistant-event-hub.js", () => ({
  assistantEventHub: {
    publish: async () => {},
    subscribe: () => () => {},
  },
  broadcastMessage: () => {},
}));

// Gateway reads used by reconciliation. Stubs are swapped per test; the
// spread keeps every other export real so transitive importers keep
// working (partial factories break at import time).
const actualGateway =
  await import("../../channels/gateway-guardian-requests.js");
let listGuardianRequestsStub: () => Promise<unknown[]> = async () => [];
let getGuardianRequestStub: (id: string) => Promise<unknown> = async () => null;
mock.module("../../channels/gateway-guardian-requests.js", () => ({
  ...actualGateway,
  listGuardianRequests: (...args: unknown[]) =>
    (listGuardianRequestsStub as (...a: unknown[]) => Promise<unknown[]>)(
      ...args,
    ),
  getGuardianRequest: (id: string) => getGuardianRequestStub(id),
}));

const {
  buildPendingGuardianProjection,
  guardianFeedItemId,
  reconcileGuardianFeedProjections,
  requestIdFromGuardianFeedItemId,
  writeGuardianFeedReceipt,
} = await import("../guardian-feed-projection.js");
const { appendFeedItem, bulkSetFeedItemStatus, getHomeFeedPath, readHomeFeed } =
  await import("../../home/feed-writer.js");
const { GUARDIAN_TERMINAL_REASON_SUPERSEDED, isPendingGuardianFeedItem } =
  await import("../../api/responses/home.js");
type FeedItem = import("../../api/responses/home.js").FeedItem;

let workspaceDir: string;
let origWorkspaceDir: string | undefined;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "vellum-gfp-"));
  origWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR;
  process.env.VELLUM_WORKSPACE_DIR = workspaceDir;
  listGuardianRequestsStub = async () => [];
  getGuardianRequestStub = async () => null;
});

afterEach(() => {
  if (origWorkspaceDir === undefined) {
    delete process.env.VELLUM_WORKSPACE_DIR;
  } else {
    process.env.VELLUM_WORKSPACE_DIR = origWorkspaceDir;
  }
  rmSync(workspaceDir, { recursive: true, force: true });
});

const toolApprovalPayload = {
  requestKind: "tool_approval",
  requestId: "req-1",
  requestCode: "ABC123",
  questionText: "Alice asked the assistant to look up an issue",
  toolName: "linear_graphql",
  sourceChannel: "slack",
  sourceChatId: "C0123456789",
  requesterIdentifier: "Alice",
};

function pendingGuardianItem(requestId: string): FeedItem {
  const projection = buildPendingGuardianProjection({
    ...toolApprovalPayload,
    requestId,
  });
  if (!projection) {
    throw new Error("projection should build");
  }
  return {
    id: guardianFeedItemId(requestId),
    type: "notification",
    priority: 50,
    summary: "Alice asked the assistant to look up an issue",
    timestamp: "2026-08-31T12:00:00.000Z",
    createdAt: "2026-08-31T12:00:00.000Z",
    status: "new",
    urgency: "high",
    guardianRequest: projection,
  };
}

describe("buildPendingGuardianProjection", () => {
  test("tool approval projects as a pending approval with source facts", () => {
    const projection = buildPendingGuardianProjection(toolApprovalPayload);
    expect(projection).toMatchObject({
      requestId: "req-1",
      kind: "tool_approval",
      intent: "approval",
      status: "pending",
      requesterLabel: "Alice",
      toolName: "linear_graphql",
      sourceChannel: "slack",
      sourceContextLabel: "#C0123456789",
    });
  });

  test("a question without a tool projects as question intent", () => {
    const projection = buildPendingGuardianProjection({
      requestKind: "pending_question",
      requestId: "req-q",
      requestCode: "Q1",
      questionText: "Which venue should I book?",
    });
    expect(projection?.intent).toBe("question");
    expect(projection?.status).toBe("pending");
  });

  test("a captured channel name becomes the source context label", () => {
    const projection = buildPendingGuardianProjection({
      ...toolApprovalPayload,
      sourceChatName: "user-feedback",
    });
    expect(projection?.sourceContextLabel).toBe("#user-feedback");
  });

  test("a payload without a requestId projects nothing", () => {
    expect(
      buildPendingGuardianProjection({ requestKind: "tool_approval" }),
    ).toBeNull();
  });

  test("an access-request payload projects with the event's implied kind", () => {
    const projection = buildPendingGuardianProjection(
      {
        requestId: "req-a",
        requestCode: "AC1234",
        sourceChannel: "telegram",
        senderIdentifier: "Alice",
      },
      "access_request",
    );
    expect(projection).toMatchObject({
      requestId: "req-a",
      kind: "access_request",
      intent: "approval",
      status: "pending",
      requesterLabel: "Alice",
    });
  });
});

describe("guardianFeedItemId", () => {
  test("round-trips through requestIdFromGuardianFeedItemId", () => {
    expect(requestIdFromGuardianFeedItemId(guardianFeedItemId("req-9"))).toBe(
      "req-9",
    );
    expect(requestIdFromGuardianFeedItemId("notif:xyz")).toBeNull();
  });
});

describe("bulk-dismiss protection", () => {
  test("clear-all skips the pending item and clears its receipt", async () => {
    await appendFeedItem(pendingGuardianItem("req-1"));
    await appendFeedItem({
      id: "notif:other",
      type: "notification",
      priority: 50,
      summary: "routine",
      timestamp: "2026-08-31T12:00:00.000Z",
      createdAt: "2026-08-31T12:00:00.000Z",
      status: "seen",
    });

    const first = await bulkSetFeedItemStatus(
      ["new", "seen", "acted_on"],
      "dismissed",
    );
    let items = readHomeFeed().items;
    const guardianItem = items.find(
      (i) => i.id === guardianFeedItemId("req-1"),
    );
    // Exactly the routine item flipped; the pending projection is intact
    // and still actionable.
    expect(first).toBe(1);
    expect(guardianItem?.status).toBe("new");
    expect(items.find((i) => i.id === "notif:other")?.status).toBe("dismissed");
    expect(guardianItem && isPendingGuardianFeedItem(guardianItem)).toBe(true);

    // Sensitivity: once the request resolves, the same bulk op clears it.
    await writeGuardianFeedReceipt({ requestId: "req-1", status: "approved" });
    const second = await bulkSetFeedItemStatus(
      ["new", "seen", "acted_on"],
      "dismissed",
    );
    items = readHomeFeed().items;
    expect(second).toBe(1);
    expect(
      items.find((i) => i.id === guardianFeedItemId("req-1"))?.status,
    ).toBe("dismissed");
  });

  test("bulk read-marking never dismisses but may still touch guardian items", async () => {
    await appendFeedItem(pendingGuardianItem("req-2"));
    const updated = await bulkSetFeedItemStatus(["new"], "seen");
    // Only dismissal is protected; a bulk `seen` transition (not offered
    // for guardian rows by the web client, which excludes their ids) is
    // not blocked by the writer.
    expect(updated).toBe(1);
  });
});

describe("writeGuardianFeedReceipt", () => {
  test("a decision rewrites the item into a clearable receipt", async () => {
    await appendFeedItem(pendingGuardianItem("req-3"));
    const ok = await writeGuardianFeedReceipt({
      requestId: "req-3",
      status: "approved",
      decidedAction: "approve_once",
      decidedAtMs: Date.parse("2026-08-31T13:00:00.000Z"),
    });
    expect(ok).toBe(true);

    const item = readHomeFeed().items.find(
      (i) => i.id === guardianFeedItemId("req-3"),
    );
    expect(item?.guardianRequest).toMatchObject({
      status: "approved",
      decidedAction: "approve_once",
      decidedAt: "2026-08-31T13:00:00.000Z",
    });
    expect(item?.urgency).toBe("medium");
    expect(item && isPendingGuardianFeedItem(item)).toBe(false);
  });

  test("a superseded auto-deny carries its reason", async () => {
    await appendFeedItem(pendingGuardianItem("req-4"));
    await writeGuardianFeedReceipt({
      requestId: "req-4",
      status: "denied",
      decidedAction: "reject",
      terminalReason: GUARDIAN_TERMINAL_REASON_SUPERSEDED,
    });
    const item = readHomeFeed().items.find(
      (i) => i.id === guardianFeedItemId("req-4"),
    );
    expect(item?.guardianRequest?.terminalReason).toBe(
      GUARDIAN_TERMINAL_REASON_SUPERSEDED,
    );
    expect(item?.guardianRequest?.status).toBe("denied");
  });

  test("a request with no item resolves true (nothing to retry)", async () => {
    expect(
      await writeGuardianFeedReceipt({ requestId: "ghost", status: "expired" }),
    ).toBe(true);
  });

  test("a lost write on an existing item resolves false so callers retry", async () => {
    await appendFeedItem(pendingGuardianItem("req-5"));
    // Fail the next feed-file write while the item is still present in
    // the read path, so the missing-item and lost-write cases separate.
    const feedPath = getHomeFeedPath();
    const originalWrite = fs.writeFileSync;
    const spy = spyOn(fs, "writeFileSync").mockImplementation(((
      path: fs.PathOrFileDescriptor,
      data: string | NodeJS.ArrayBufferView,
      options?: fs.WriteFileOptions,
    ) => {
      if (typeof path === "string" && path === feedPath) {
        throw new Error("Simulated write failure");
      }
      return originalWrite(path, data, options);
    }) as typeof fs.writeFileSync);
    try {
      expect(
        await writeGuardianFeedReceipt({
          requestId: "req-5",
          status: "expired",
        }),
      ).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("reconcileGuardianFeedProjections", () => {
  const wireRequest = (overrides: Record<string, unknown>) => ({
    id: "req-r",
    kind: "tool_approval",
    sourceType: "channel",
    sourceChannel: "slack",
    sourceConversationId: "conv-1",
    requesterExternalUserId: "U1",
    requesterChatId: null,
    guardianExternalUserId: null,
    guardianPrincipalId: null,
    callSessionId: null,
    pendingQuestionId: null,
    questionText: "Alice asked the assistant to look up an issue",
    requestCode: "ABC123",
    toolName: "linear_graphql",
    inputDigest: null,
    commandPreview: null,
    riskLevel: null,
    activityText: null,
    executionTarget: null,
    requesterSignals: null,
    requestTrigger: null,
    status: "pending",
    answerText: null,
    decidedByExternalUserId: null,
    decidedByPrincipalId: null,
    followupState: null,
    expiresAt: null,
    createdAt: Date.parse("2026-08-31T12:00:00.000Z"),
    updatedAt: Date.parse("2026-08-31T12:00:00.000Z"),
    ...overrides,
  });

  test("backfills an item for a pending request that has none", async () => {
    listGuardianRequestsStub = async () => [wireRequest({ id: "req-r" })];
    await reconcileGuardianFeedProjections();
    const item = readHomeFeed().items.find(
      (i) => i.id === guardianFeedItemId("req-r"),
    );
    expect(item?.guardianRequest?.status).toBe("pending");
    expect(item?.conversationId).toBe("conv-1");
    expect(item?.detailPanel?.kind).toBe("permissionChat");
  });

  test("receipts an actionable item whose request went terminal", async () => {
    await appendFeedItem(pendingGuardianItem("req-t"));
    listGuardianRequestsStub = async () => [];
    getGuardianRequestStub = async () =>
      wireRequest({ id: "req-t", status: "denied" });
    await reconcileGuardianFeedProjections();
    const item = readHomeFeed().items.find(
      (i) => i.id === guardianFeedItemId("req-t"),
    );
    expect(item?.guardianRequest?.status).toBe("denied");
    expect(item && isPendingGuardianFeedItem(item)).toBe(false);
  });
});
