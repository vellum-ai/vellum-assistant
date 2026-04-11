/**
 * Tests for the `workspace-files` list/read endpoints in settings-routes.
 *
 * Focus: the list now includes the guardian's per-user persona file
 * (`users/<slug>.md`) whenever a guardian exists, and the read endpoint
 * accepts paths under `users/`.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import { createGuardianBinding } from "../../contacts/contacts-write.js";
import { getSqlite, initializeDb } from "../../memory/db.js";
import { settingsRouteDefinitions } from "./settings-routes.js";

initializeDb();

const testWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR!;

function resetContactTables(): void {
  const sqlite = getSqlite();
  sqlite.run("DELETE FROM contact_channels");
  sqlite.run("DELETE FROM contacts");
}

// ---------------------------------------------------------------------------
// RouteContext helpers (mirrors workspace-routes.test.ts)
// ---------------------------------------------------------------------------

function makeCtx(
  endpoint: string,
  searchParams: Record<string, string> = {},
) {
  const url = new URL(`http://localhost/v1/${endpoint}`);
  for (const [k, v] of Object.entries(searchParams)) {
    url.searchParams.set(k, v);
  }
  return {
    url,
    req: new Request(url),
    server: {} as ReturnType<typeof Bun.serve>,
    authContext: {} as never,
    params: {},
  };
}

function getHandler(endpoint: string, method: string) {
  const routes = settingsRouteDefinitions();
  const route = routes.find(
    (r) => r.endpoint === endpoint && r.method === method,
  );
  if (!route) {
    throw new Error(`No route found for ${method} ${endpoint}`);
  }
  return route.handler;
}

// ---------------------------------------------------------------------------
// GET /workspace-files
// ---------------------------------------------------------------------------

describe("GET /workspace-files", () => {
  const handler = getHandler("workspace-files", "GET");

  beforeEach(() => {
    resetContactTables();
  });

  test("with no guardian: returns the static entries only", async () => {
    const res = await handler(makeCtx("workspace-files"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      files: Array<{ path: string; name: string; exists: boolean }>;
    };
    const paths = body.files.map((f) => f.path);
    expect(paths).toEqual(["IDENTITY.md", "SOUL.md", "skills/"]);
    // No guardian → no users/*.md entry.
    expect(paths.find((p) => p.startsWith("users/"))).toBeUndefined();
  });

  test("with a guardian: includes users/<slug>.md", async () => {
    createGuardianBinding({
      channel: "telegram",
      guardianExternalUserId: "Alice",
      guardianDeliveryChatId: "chat-alice",
      guardianPrincipalId: "principal-alice",
      verifiedVia: "challenge",
    });

    const res = await handler(makeCtx("workspace-files"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      files: Array<{ path: string; name: string; exists: boolean }>;
    };
    const paths = body.files.map((f) => f.path);

    // USER.md has been removed — the guardian per-user persona is the sole
    // user-profile entry.
    expect(paths).not.toContain("USER.md");
    // Guardian per-user persona is appended.
    expect(paths).toContain("users/alice.md");

    // The guardian entry reports `exists: true` because PR 2 seeds the
    // template scaffold when the binding is created.
    const guardianEntry = body.files.find((f) => f.path === "users/alice.md");
    expect(guardianEntry).toBeDefined();
    expect(guardianEntry!.exists).toBe(true);
  });

  test("reflects guardian changes on a subsequent request (not cached)", async () => {
    // Initially no guardian.
    let res = await handler(makeCtx("workspace-files"));
    let body = (await res.json()) as {
      files: Array<{ path: string }>;
    };
    expect(body.files.map((f) => f.path)).not.toContain("users/alice.md");

    // Create a guardian mid-session.
    createGuardianBinding({
      channel: "telegram",
      guardianExternalUserId: "Alice",
      guardianDeliveryChatId: "chat-alice",
      guardianPrincipalId: "principal-alice",
      verifiedVia: "challenge",
    });

    // The next request must reflect the new guardian — we do not want a
    // stale module-level cache here.
    res = await handler(makeCtx("workspace-files"));
    body = (await res.json()) as {
      files: Array<{ path: string }>;
    };
    expect(body.files.map((f) => f.path)).toContain("users/alice.md");
  });
});

// ---------------------------------------------------------------------------
// GET /workspace-files/read
// ---------------------------------------------------------------------------

describe("GET /workspace-files/read", () => {
  const handler = getHandler("workspace-files/read", "GET");

  beforeEach(() => {
    resetContactTables();
  });

  test("reads a guardian users/<slug>.md file", async () => {
    createGuardianBinding({
      channel: "telegram",
      guardianExternalUserId: "Alice",
      guardianDeliveryChatId: "chat-alice",
      guardianPrincipalId: "principal-alice",
      verifiedVia: "challenge",
    });

    const personaPath = join(testWorkspaceDir, "users", "alice.md");
    // PR 2 seeds the template scaffold; overwrite with something recognizable
    // so the test asserts on exact content rather than scaffold boilerplate.
    expect(existsSync(personaPath)).toBe(true);
    writeFileSync(
      personaPath,
      "# Alice\n\n- Preferred name/reference: Alice\n",
      "utf-8",
    );

    const res = await handler(
      makeCtx("workspace-files/read", { path: "users/alice.md" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { path: string; content: string };
    expect(body.path).toBe("users/alice.md");
    expect(body.content).toBe(readFileSync(personaPath, "utf-8"));
    expect(body.content).toContain("Preferred name/reference: Alice");
  });

  test("rejects path traversal attempts via users/", async () => {
    const res = await handler(
      makeCtx("workspace-files/read", {
        path: "users/../../etc/passwd",
      }),
    );
    expect(res.status).toBe(400);
  });

  test("returns 404 for a non-existent users/<slug>.md", async () => {
    const res = await handler(
      makeCtx("workspace-files/read", { path: "users/nobody.md" }),
    );
    expect(res.status).toBe(404);
  });
});
