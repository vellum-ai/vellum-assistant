import { beforeEach, describe, expect, mock, test } from "bun:test";

let mockClient: {
  baseUrl: string;
  platformAssistantId: string;
  fetch: (path: string, init: RequestInit) => Promise<Response>;
} | null;

mock.module("./client.js", () => ({
  VellumPlatformClient: { create: async () => mockClient },
}));

import { syncIdentityNameToPlatform } from "./sync-identity.js";

interface Patch {
  path: string;
  body: { name: string };
}

let patches: Patch[];

function makeClient(assistantId = "asst-1") {
  return {
    baseUrl: "https://platform.a",
    platformAssistantId: assistantId,
    fetch: async (path: string, init: RequestInit) => {
      patches.push({ path, body: JSON.parse(init.body as string) });
      return new Response("{}", { status: 200 });
    },
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

// The module owns one queue, so names are unique per test to avoid dedup
// across tests. Queue semantics are covered by platform-patch-queue.test.ts.
describe("syncIdentityNameToPlatform", () => {
  beforeEach(() => {
    patches = [];
    mockClient = makeClient();
  });

  test("PATCHes the name and dedups an unchanged name", async () => {
    syncIdentityNameToPlatform("Ada");
    await settle();
    syncIdentityNameToPlatform("Ada");
    await settle();

    expect(patches).toEqual([
      { path: "/v1/assistants/asst-1/", body: { name: "Ada" } },
    ]);
  });

  test("rapid changes collapse into one PATCH carrying the newest name", async () => {
    syncIdentityNameToPlatform("Bea");
    syncIdentityNameToPlatform("Cy");
    syncIdentityNameToPlatform("Dee");
    await settle();

    expect(patches.map((p) => p.body.name)).toEqual(["Dee"]);
  });

  test("empty names and a missing client are no-ops", async () => {
    syncIdentityNameToPlatform("");
    mockClient = null;
    syncIdentityNameToPlatform("Eve");
    await settle();

    expect(patches).toHaveLength(0);
  });
});
