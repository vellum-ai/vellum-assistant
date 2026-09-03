/**
 * Tests for the activation route handlers in `activation-routes.ts`.
 *
 * Covers the GET/POST round trip, the request-body validation contract,
 * and the route-definition metadata clients and the OpenAPI generator
 * depend on.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { ActivationProgress } from "../../api/responses/activation.js";
import type { ConversationRow } from "../../persistence/conversation-crud.js";
import { RouteError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

// Capture invalidations without standing up SSE infrastructure, and read the
// origin client the handlers thread through from the request headers.
const publishedOrigins: (string | undefined)[] = [];

mock.module("../sync/sync-publisher.js", () => ({
  publishSyncInvalidation: async (tags: string[], originClientId?: string) => {
    publishedOrigins.push(originClientId);
    return { type: "sync_changed", tags };
  },
}));

/** The conversations the daemon can resolve, as the start route sees them. */
const existingConversationIds = new Set<string>();

function conversationRow(id: string): ConversationRow {
  return {
    id,
    title: null,
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalEstimatedCost: 0,
    contextSummary: null,
    contextCompactedMessageCount: 0,
    contextCompactedAt: null,
    historyStrippedAt: null,
    slackContextCompactionWatermarkTs: null,
    slackContextCompactionWatermarkAt: null,
    conversationType: "standard",
    source: "user",
    originChannel: null,
    originInterface: null,
    forkParentConversationId: null,
    forkParentMessageId: null,
    forkStrategy: null,
    isAutoTitle: 0,
    scheduleJobId: null,
    lastMessageAt: null,
    archivedAt: null,
    surfacedAt: null,
    inferenceProfile: null,
    enabledPlugins: null,
    inferenceProfileSessionId: null,
    inferenceProfileExpiresAt: null,
    lastNotifiedInferenceProfile: null,
    processingStartedAt: null,
  };
}

// The start route resolves the conversation the way `POST /v1/messages` does.
// Stubbed against a set the tests own, so a route test states which
// conversations exist without standing up a database.
const realConversationCrud =
  await import("../../persistence/conversation-crud.js");
mock.module("../../persistence/conversation-crud.js", () => ({
  ...realConversationCrud,
  getConversation: (id: string): ConversationRow | null =>
    existingConversationIds.has(id) ? conversationRow(id) : null,
}));

const { ROUTES: ACTIVATION_ROUTES } = await import("./activation-routes.js");
const { ROUTES: ALL_ROUTES } = await import("./index.js");
const { getActivationProgressLockPath, setActivationLockTimingForTesting } =
  await import("../../activation/progress-store.js");

function findRoute(operationId: string): RouteDefinition {
  const route = ACTIVATION_ROUTES.find((r) => r.operationId === operationId);
  if (!route) {
    throw new Error(`Route ${operationId} not found`);
  }
  return route;
}

const getProgressRoute = findRoute("activation_progress_get");
const startTaskRoute = findRoute("activation_task_start_post");
const dismissRoute = findRoute("activation_dismiss_post");

async function call(
  route: RouteDefinition,
  args: RouteHandlerArgs = {},
): Promise<ActivationProgress> {
  return (await route.handler(args)) as ActivationProgress;
}

let workspaceDir: string;
let origWorkspaceDir: string | undefined;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "vellum-activation-routes-"));
  origWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR;
  process.env.VELLUM_WORKSPACE_DIR = workspaceDir;
  publishedOrigins.length = 0;
  existingConversationIds.clear();
  existingConversationIds.add("conv-1");
});

afterEach(() => {
  setActivationLockTimingForTesting();
  if (origWorkspaceDir === undefined) {
    delete process.env.VELLUM_WORKSPACE_DIR;
  } else {
    process.env.VELLUM_WORKSPACE_DIR = origWorkspaceDir;
  }
  rmSync(workspaceDir, { recursive: true, force: true });
});

describe("activation routes", () => {
  test("GET progress returns the empty default before any write", async () => {
    expect(await call(getProgressRoute)).toEqual({
      version: 1,
      listId: null,
      modalDismissedAt: null,
      allDoneShownAt: null,
      tasks: {},
    });
  });

  test("POST start links the task and returns the full progress", async () => {
    const result = await call(startTaskRoute, {
      pathParams: { taskId: "draft-email" },
      body: { conversationId: "conv-1", listId: "smb" },
    });

    expect(result.listId).toBe("smb");
    expect(result.tasks["draft-email"]).toMatchObject({
      status: "started",
      conversationId: "conv-1",
    });
    expect(await call(getProgressRoute)).toEqual(result);
  });

  test("POST dismiss records the surface and returns the full progress", async () => {
    const result = await call(dismissRoute, {
      body: { kind: "all-done", listId: "parent" },
    });

    expect(result.allDoneShownAt).not.toBeNull();
    expect(result.modalDismissedAt).toBeNull();
    expect(result.listId).toBe("parent");
  });

  test("POST start rejects a malformed task id with a 400", async () => {
    const err = await call(startTaskRoute, {
      pathParams: { taskId: "Not A Task" },
      body: { conversationId: "conv-1" },
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RouteError);
    expect((err as RouteError).statusCode).toBe(400);
  });

  test("POST start rejects a missing conversation id with a 400", async () => {
    const err = await call(startTaskRoute, {
      pathParams: { taskId: "draft-email" },
      body: {},
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RouteError);
    expect((err as RouteError).statusCode).toBe(400);
  });

  test("POST start rejects an oversized conversation id with a 400", async () => {
    const err = await call(startTaskRoute, {
      pathParams: { taskId: "draft-email" },
      body: { conversationId: "c".repeat(129) },
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RouteError);
    expect((err as RouteError).statusCode).toBe(400);
  });

  test("a write carries the client that made it, so it can suppress its own echo", async () => {
    await call(startTaskRoute, {
      pathParams: { taskId: "draft-email" },
      body: { conversationId: "conv-1" },
      headers: { "x-vellum-client-id": "client-a" },
    });
    await call(dismissRoute, {
      body: { kind: "modal" },
      headers: { "x-vellum-client-id": "client-b" },
    });

    expect(publishedOrigins).toEqual(["client-a", "client-b"]);
  });

  test("a write from a client that named none carries none", async () => {
    await call(startTaskRoute, {
      pathParams: { taskId: "draft-email" },
      body: { conversationId: "conv-1" },
      headers: { "x-vellum-client-id": "  " },
    });

    expect(publishedOrigins).toEqual([undefined]);
  });

  test("POST dismiss rejects an unknown kind with a 400", async () => {
    const err = await call(dismissRoute, { body: { kind: "sideways" } }).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(RouteError);
    expect((err as RouteError).statusCode).toBe(400);
  });

  test("POST start rejects when the write cannot be persisted", async () => {
    // Occupy the data directory's path with a regular file, so the store
    // cannot create it and the write fails.
    writeFileSync(join(workspaceDir, "data"), "not a directory", "utf-8");

    const err = await call(startTaskRoute, {
      pathParams: { taskId: "draft-email" },
      body: { conversationId: "conv-1" },
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RouteError);
    expect((err as RouteError).statusCode).toBe(500);
  });

  test("POST dismiss rejects when the write cannot be persisted", async () => {
    writeFileSync(join(workspaceDir, "data"), "not a directory", "utf-8");

    const err = await call(dismissRoute, { body: { kind: "modal" } }).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(RouteError);
    expect((err as RouteError).statusCode).toBe(500);
  });

  describe("a progress document from a newer build", () => {
    function writeNewerProgress(): void {
      mkdirSync(join(workspaceDir, "data"), { recursive: true });
      writeFileSync(
        join(workspaceDir, "data", "activation-progress.json"),
        JSON.stringify({
          version: 99,
          listId: "smb",
          modalDismissedAt: null,
          allDoneShownAt: null,
          tasks: {},
        }),
        "utf-8",
      );
    }

    test("GET still serves what this build understands", async () => {
      writeNewerProgress();

      expect((await call(getProgressRoute)).listId).toBe("smb");
    });

    test("POST start answers 409 rather than a write that never landed", async () => {
      writeNewerProgress();

      const err = await call(startTaskRoute, {
        pathParams: { taskId: "draft-email" },
        body: { conversationId: "conv-1" },
      }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(RouteError);
      expect((err as RouteError).statusCode).toBe(409);
    });

    test("POST dismiss answers 409 rather than a write that never landed", async () => {
      writeNewerProgress();

      const err = await call(dismissRoute, { body: { kind: "modal" } }).catch(
        (e: unknown) => e,
      );

      expect(err).toBeInstanceOf(RouteError);
      expect((err as RouteError).statusCode).toBe(409);
    });
  });

  test("POST start hands the conversation to the latest task", async () => {
    await call(startTaskRoute, {
      pathParams: { taskId: "draft-email" },
      body: { conversationId: "conv-1" },
    });
    const result = await call(startTaskRoute, {
      pathParams: { taskId: "book-travel" },
      body: { conversationId: "conv-1" },
    });

    expect(Object.keys(result.tasks)).toEqual(["book-travel"]);
    expect(await call(getProgressRoute)).toEqual(result);
  });

  test("POST start rejects a conversation the daemon cannot resolve with a 404", async () => {
    const err = await call(startTaskRoute, {
      pathParams: { taskId: "draft-email" },
      body: { conversationId: "conv-deleted" },
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RouteError);
    expect((err as RouteError).statusCode).toBe(404);
    // Nothing was recorded, so the row stays launchable.
    expect((await call(getProgressRoute)).tasks).toEqual({});
  });

  test("POST start answers 503 while another process holds the progress lock", async () => {
    setActivationLockTimingForTesting({ waitMs: 40 });
    mkdirSync(join(workspaceDir, "data"), { recursive: true });
    writeFileSync(
      getActivationProgressLockPath(),
      JSON.stringify({ pid: process.pid, at: Date.now() }),
      "utf-8",
    );

    const err = await call(startTaskRoute, {
      pathParams: { taskId: "draft-email" },
      body: { conversationId: "conv-1" },
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RouteError);
    expect((err as RouteError).statusCode).toBe(503);
    expect((await call(getProgressRoute)).tasks).toEqual({});
  });

  test("POST dismiss answers 503 while another process holds the progress lock", async () => {
    setActivationLockTimingForTesting({ waitMs: 40 });
    mkdirSync(join(workspaceDir, "data"), { recursive: true });
    writeFileSync(
      getActivationProgressLockPath(),
      JSON.stringify({ pid: process.pid, at: Date.now() }),
      "utf-8",
    );

    const err = await call(dismissRoute, { body: { kind: "modal" } }).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(RouteError);
    expect((err as RouteError).statusCode).toBe(503);
  });

  test("the start route declares the answers it can give", () => {
    expect(
      Object.keys(startTaskRoute.additionalResponses ?? {}).sort(),
    ).toEqual(["400", "404", "409", "503"]);
    expect(Object.keys(dismissRoute.additionalResponses ?? {}).sort()).toEqual([
      "400",
      "409",
      "503",
    ]);
  });

  test("routes declare their policy, tags, and response body", () => {
    for (const route of ACTIVATION_ROUTES) {
      expect(route.tags).toEqual(["activation"]);
      expect(route.responseBody).toBeDefined();
      expect(route.policy?.allowedPrincipalTypes.length).toBeGreaterThan(0);
    }
    expect(getProgressRoute.policy?.requiredScopes).toEqual(["chat.read"]);
    expect(startTaskRoute.policy?.requiredScopes).toEqual(["chat.write"]);
    expect(dismissRoute.policy?.requiredScopes).toEqual(["chat.write"]);
  });

  test("routes are registered in the shared route table", () => {
    const registered = new Set(ALL_ROUTES.map((r) => r.operationId));
    for (const route of ACTIVATION_ROUTES) {
      expect(registered.has(route.operationId)).toBe(true);
    }
  });
});
