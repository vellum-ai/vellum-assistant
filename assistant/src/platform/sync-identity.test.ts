import { beforeEach, describe, expect, mock, test } from "bun:test";

let mockClient: {
  baseUrl: string;
  platformAssistantId: string;
  fetch: (path: string, init: RequestInit) => Promise<Response>;
} | null;

mock.module("./client.js", () => ({
  VellumPlatformClient: { create: async () => mockClient },
}));

import {
  _resetSyncIdentityStateForTests,
  syncIdentityNameToPlatform,
} from "./sync-identity.js";

interface Patch {
  path: string;
  body: { name: string };
}

let patches: Patch[];
let respond: () => Response;

function makeClient(assistantId = "asst-1", baseUrl = "https://platform.a") {
  return {
    baseUrl,
    platformAssistantId: assistantId,
    fetch: async (path: string, init: RequestInit) => {
      patches.push({ path, body: JSON.parse(init.body as string) });
      return respond();
    },
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("syncIdentityNameToPlatform", () => {
  beforeEach(() => {
    _resetSyncIdentityStateForTests();
    patches = [];
    respond = () => new Response("{}", { status: 200 });
    mockClient = makeClient();
  });

  test("PATCHes the name once and dedups an unchanged name", async () => {
    syncIdentityNameToPlatform("Ada");
    await settle();
    syncIdentityNameToPlatform("Ada");
    await settle();

    expect(patches).toEqual([
      { path: "/v1/assistants/asst-1/", body: { name: "Ada" } },
    ]);
  });

  test("re-registering to another assistant id re-sends the same name", async () => {
    syncIdentityNameToPlatform("Ada");
    await settle();
    mockClient = makeClient("asst-2");
    syncIdentityNameToPlatform("Ada");
    await settle();
    syncIdentityNameToPlatform("Ada");
    await settle();

    expect(patches.map((p) => p.path)).toEqual([
      "/v1/assistants/asst-1/",
      "/v1/assistants/asst-2/",
    ]);
  });

  test("re-registering to another base URL re-sends the same name", async () => {
    syncIdentityNameToPlatform("Ada");
    await settle();
    mockClient = makeClient("asst-1", "https://platform.b");
    syncIdentityNameToPlatform("Ada");
    await settle();

    expect(patches).toHaveLength(2);
  });

  test("rapid changes collapse into one PATCH carrying the newest name", async () => {
    syncIdentityNameToPlatform("Ada");
    syncIdentityNameToPlatform("Bea");
    syncIdentityNameToPlatform("Cy");
    await settle();

    expect(patches.map((p) => p.body.name)).toEqual(["Cy"]);
  });

  test("empty names and missing client or assistant id are no-ops", async () => {
    syncIdentityNameToPlatform("");
    mockClient = null;
    syncIdentityNameToPlatform("Ada");
    await settle();
    mockClient = makeClient("");
    syncIdentityNameToPlatform("Ada");
    await settle();

    expect(patches).toHaveLength(0);
  });

  test("a failed PATCH does not dedup the next attempt", async () => {
    respond = () => new Response("nope", { status: 500 });
    syncIdentityNameToPlatform("Ada");
    await settle();
    respond = () => new Response("{}", { status: 200 });
    syncIdentityNameToPlatform("Ada");
    await settle();
    syncIdentityNameToPlatform("Ada");
    await settle();

    expect(patches).toHaveLength(2);
  });
});
