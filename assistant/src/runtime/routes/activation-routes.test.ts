/**
 * Tests for the activation route handlers in `activation-routes.ts`.
 *
 * Covers the GET/POST round trip, the request-body validation contract,
 * and the route-definition metadata clients and the OpenAPI generator
 * depend on.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { ActivationProgress } from "../../api/responses/activation.js";
import { ROUTES as ACTIVATION_ROUTES } from "./activation-routes.js";
import { RouteError } from "./errors.js";
import { ROUTES as ALL_ROUTES } from "./index.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

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
});

afterEach(() => {
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
