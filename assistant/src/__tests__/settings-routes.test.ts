/**
 * Tests for the `workspace-files` list/read endpoints in settings-routes.
 *
 * Focus: the list includes the guardian's per-user persona file
 * (`users/<slug>.md`) whenever a guardian exists, and the read endpoint
 * accepts paths under `users/`.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, mock, test } from "bun:test";

// Guardian identity resolves via the gateway delivery cache, not the local
// contacts DB. Seed it per-test via seedGatewayGuardian; persona resolution
// joins the local contact (userFile) by the delivery's channelType + address.
interface GatewayGuardian {
  channelType: string;
  address: string;
  status: string;
}
let gatewayGuardians: GatewayGuardian[] = [];
mock.module("../contacts/guardian-delivery-reader.js", () => ({
  peekCachedGuardianDelivery: (input?: { channelTypes?: string[] }) => {
    if (!input?.channelTypes) return gatewayGuardians;
    return gatewayGuardians.filter((g) =>
      input.channelTypes!.includes(g.channelType),
    );
  },
  guardianForChannel: (list: GatewayGuardian[], channelType: string) =>
    list.find((g) => g.channelType === channelType && g.status === "active"),
  anyGuardian: (list: GatewayGuardian[]) => list[0],
}));

function seedGatewayGuardian(g: {
  channelType: string;
  address: string;
}): void {
  gatewayGuardians.push({ status: "active", ...g });
}

import { getSqlite } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { BadRequestError, NotFoundError } from "../runtime/routes/errors.js";
import { ROUTES } from "../runtime/routes/settings-routes.js";
import type { RouteHandlerArgs } from "../runtime/routes/types.js";
import { createGuardianBinding } from "./helpers/create-guardian-binding.js";

await initializeDb();

const testWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR!;

function resetContactTables(): void {
  const sqlite = getSqlite();
  sqlite.run("DELETE FROM contact_channels");
  sqlite.run("DELETE FROM contacts");
  gatewayGuardians = [];
}

// ---------------------------------------------------------------------------
// Route lookup + invocation helpers
// ---------------------------------------------------------------------------

function getHandler(endpoint: string, method: string) {
  const route = ROUTES.find(
    (r) => r.endpoint === endpoint && r.method === method,
  );
  if (!route) {
    throw new Error(`No route found for ${method} ${endpoint}`);
  }
  return route.handler;
}

function makeArgs(
  queryParams: Record<string, string> = {},
  body?: Record<string, unknown>,
): RouteHandlerArgs {
  return { queryParams, body };
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
    const result = (await handler(makeArgs())) as {
      files: Array<{ path: string; name: string; exists: boolean }>;
    };
    const paths = result.files.map((f) => f.path);
    expect(paths).toEqual(["IDENTITY.md", "SOUL.md", "skills/"]);
    expect(paths.find((p) => p.startsWith("users/"))).toBeUndefined();
  });

  test("with a guardian: includes users/<slug>.md", async () => {
    seedGatewayGuardian({ channelType: "telegram", address: "Alice" });
    createGuardianBinding({
      channel: "telegram",
      guardianExternalUserId: "Alice",
      guardianDeliveryChatId: "chat-alice",
      guardianPrincipalId: "principal-alice",
      verifiedVia: "challenge",
    });

    const result = (await handler(makeArgs())) as {
      files: Array<{ path: string; name: string; exists: boolean }>;
    };
    const paths = result.files.map((f) => f.path);

    expect(paths).not.toContain("USER.md");
    expect(paths).toContain("users/alice.md");

    const guardianEntry = result.files.find((f) => f.path === "users/alice.md");
    expect(guardianEntry).toBeDefined();
    expect(guardianEntry!.exists).toBe(true);
  });

  test("reflects guardian changes on a subsequent request (not cached)", async () => {
    let result = (await handler(makeArgs())) as {
      files: Array<{ path: string }>;
    };
    expect(result.files.map((f) => f.path)).not.toContain("users/alice.md");

    seedGatewayGuardian({ channelType: "telegram", address: "Alice" });
    createGuardianBinding({
      channel: "telegram",
      guardianExternalUserId: "Alice",
      guardianDeliveryChatId: "chat-alice",
      guardianPrincipalId: "principal-alice",
      verifiedVia: "challenge",
    });

    result = (await handler(makeArgs())) as {
      files: Array<{ path: string }>;
    };
    expect(result.files.map((f) => f.path)).toContain("users/alice.md");
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
    seedGatewayGuardian({ channelType: "telegram", address: "Alice" });
    createGuardianBinding({
      channel: "telegram",
      guardianExternalUserId: "Alice",
      guardianDeliveryChatId: "chat-alice",
      guardianPrincipalId: "principal-alice",
      verifiedVia: "challenge",
    });

    const personaPath = join(testWorkspaceDir, "users", "alice.md");
    expect(existsSync(personaPath)).toBe(true);
    writeFileSync(
      personaPath,
      "# Alice\n\n- Preferred name/reference: Alice\n",
      "utf-8",
    );

    const result = (await handler(makeArgs({ path: "users/alice.md" }))) as {
      path: string;
      content: string;
    };
    expect(result.path).toBe("users/alice.md");
    expect(result.content).toBe(readFileSync(personaPath, "utf-8"));
    expect(result.content).toContain("Preferred name/reference: Alice");
  });

  test("rejects path traversal attempts via users/", async () => {
    expect(() => handler(makeArgs({ path: "users/../../etc/passwd" }))).toThrow(
      BadRequestError,
    );
  });

  test("returns 404 for a non-existent users/<slug>.md", async () => {
    expect(() => handler(makeArgs({ path: "users/nobody.md" }))).toThrow(
      NotFoundError,
    );
  });
});
