/**
 * Tests for the subagent route handlers in `subagents-routes.ts`.
 *
 * Covers the LUM-2875 recovery contract:
 *   - `subagents/reconcile` returns per-child identity (label, the
 *     subagent's OWN conversationId, parentToolUseId) alongside status
 *   - `subagents/:id` resolves the subagent's own conversation from manager
 *     state, ignoring a caller-supplied (possibly parent) conversation id
 *   - `subagents/:id` falls back to the query parameter when the manager
 *     does not know the subagent
 *   - `subagents/:id` surfaces label + parentToolUseId from manager state
 *
 * The subagent manager is mocked at the module boundary — spinning up real
 * subagents requires provider resolution, which is out of scope for
 * route-shape tests. The message store is real (seeded rows), so the
 * detail parsing runs against genuine DB reads.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Manager mock
// ---------------------------------------------------------------------------

interface FakeChild {
  status: string;
  conversationId: string;
  config: { id: string; label: string; parentToolUseId?: string };
}

const fakeChildren = new Map<string, FakeChild[]>();
const fakeStates = new Map<string, FakeChild>();

mock.module("../../../subagent/index.js", () => ({
  getSubagentManager: () => ({
    getChildrenOf: (parentConversationId: string) =>
      fakeChildren.get(parentConversationId) ?? [],
    getState: (subagentId: string) => fakeStates.get(subagentId),
  }),
}));

import { getDb } from "../../../persistence/db-connection.js";
import { initializeDb } from "../../../persistence/db-init.js";
import { conversations, messages } from "../../../persistence/schema/index.js";
import { ROUTES as SUBAGENT_ROUTES } from "../subagents-routes.js";
import type { RouteDefinition } from "../types.js";

await initializeDb();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findHandler(operationId: string): RouteDefinition["handler"] {
  const route = SUBAGENT_ROUTES.find((r) => r.operationId === operationId);
  if (!route) {
    throw new Error(`Route ${operationId} not found`);
  }
  return route.handler;
}

const reconcileHandler = findHandler("reconcileSubagents");
const detailHandler = findHandler("getSubagentDetail");

function clearDb(): void {
  const db = getDb();
  db.delete(messages).run();
  db.delete(conversations).run();
}

/** Seed a conversation with one user (objective) + one assistant message. */
function seedSubagentConversation(opts: {
  conversationId: string;
  objective: string;
  assistantText: string;
}): void {
  const now = Date.now();
  const db = getDb();
  db.insert(conversations)
    .values({
      id: opts.conversationId,
      title: "Subagent conversation",
      createdAt: now,
      updatedAt: now,
      source: "test",
      conversationType: "background",
    })
    .run();
  db.insert(messages)
    .values({
      id: `${opts.conversationId}-m1`,
      conversationId: opts.conversationId,
      role: "user",
      content: JSON.stringify([{ type: "text", text: opts.objective }]),
      createdAt: now,
    })
    .run();
  db.insert(messages)
    .values({
      id: `${opts.conversationId}-m2`,
      conversationId: opts.conversationId,
      role: "assistant",
      content: JSON.stringify([{ type: "text", text: opts.assistantText }]),
      createdAt: now + 1,
    })
    .run();
}

beforeEach(() => {
  clearDb();
  fakeChildren.clear();
  fakeStates.clear();
});

// ---------------------------------------------------------------------------
// subagents/reconcile
// ---------------------------------------------------------------------------

describe("reconcileSubagents", () => {
  test("returns identity fields per child", async () => {
    fakeChildren.set("conv-parent", [
      {
        status: "running",
        conversationId: "conv-child-1",
        config: {
          id: "sa-1",
          label: "Audit daemon defenses",
          parentToolUseId: "toolu_1",
        },
      },
      {
        status: "completed",
        conversationId: "conv-child-2",
        config: { id: "sa-2", label: "Citation matrix" },
      },
    ]);

    const result = (await reconcileHandler({
      queryParams: { parentConversationId: "conv-parent" },
    })) as {
      subagents: Record<
        string,
        {
          status: string;
          label?: string;
          conversationId?: string;
          parentToolUseId?: string;
        }
      >;
    };

    expect(result.subagents["sa-1"]).toEqual({
      status: "running",
      label: "Audit daemon defenses",
      conversationId: "conv-child-1",
      parentToolUseId: "toolu_1",
    });
    expect(result.subagents["sa-2"]).toEqual({
      status: "completed",
      label: "Citation matrix",
      conversationId: "conv-child-2",
      parentToolUseId: undefined,
    });
  });

  test("returns an empty record for a conversation with no children", async () => {
    const result = (await reconcileHandler({
      queryParams: { parentConversationId: "conv-empty" },
    })) as { subagents: Record<string, unknown> };

    expect(result.subagents).toEqual({});
  });

  test("rejects a missing parentConversationId", () => {
    expect(() => reconcileHandler({ queryParams: {} })).toThrow(
      "parentConversationId query parameter is required",
    );
  });
});

// ---------------------------------------------------------------------------
// subagents/:id
// ---------------------------------------------------------------------------

describe("getSubagentDetail", () => {
  test("resolves the subagent's own conversation from manager state, ignoring the query param", async () => {
    seedSubagentConversation({
      conversationId: "conv-child",
      objective: "audit the daemon",
      assistantText: "found three gaps",
    });
    // The parent conversation exists too — a recovering client only knows
    // this id, and pre-fix the handler would have parsed ITS messages.
    seedSubagentConversation({
      conversationId: "conv-parent",
      objective: "hey B how does vellum handle prompt injections",
      assistantText: "parent-side text",
    });
    fakeStates.set("sa-1", {
      status: "running",
      conversationId: "conv-child",
      config: { id: "sa-1", label: "Auditor", parentToolUseId: "toolu_9" },
    });

    const result = (await detailHandler({
      pathParams: { id: "sa-1" },
      queryParams: { conversationId: "conv-parent" },
    })) as {
      subagentId: string;
      objective?: string;
      status?: string;
      label?: string;
      parentToolUseId?: string;
      events: Array<{ type: string; content: string }>;
    };

    expect(result.objective).toBe("audit the daemon");
    expect(result.events.some((e) => e.content === "found three gaps")).toBe(
      true,
    );
    expect(result.events.some((e) => e.content === "parent-side text")).toBe(
      false,
    );
    expect(result.status).toBe("running");
    expect(result.label).toBe("Auditor");
    expect(result.parentToolUseId).toBe("toolu_9");
  });

  test("falls back to the query param when the manager does not know the subagent", async () => {
    seedSubagentConversation({
      conversationId: "conv-child",
      objective: "legacy objective",
      assistantText: "legacy text",
    });

    const result = (await detailHandler({
      pathParams: { id: "sa-unknown" },
      queryParams: { conversationId: "conv-child" },
    })) as { objective?: string; label?: string };

    expect(result.objective).toBe("legacy objective");
    expect(result.label).toBeUndefined();
  });

  test("rejects when neither manager state nor query param supply a conversation", () => {
    expect(() =>
      detailHandler({ pathParams: { id: "sa-unknown" }, queryParams: {} }),
    ).toThrow("conversationId query parameter is required");
  });
});
