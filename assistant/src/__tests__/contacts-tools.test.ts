import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

// Track the gateway URL; updated once the test server starts.
let testGatewayUrl = "http://127.0.0.1:0";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},
    memory: {},
  }),
}));

// The tool implementations now call the gateway over HTTP.
// Mock the env/token modules and spin up a lightweight test server
// that delegates to the real route handlers (backed by the test DB).
mock.module("../config/env.js", () => ({
  getGatewayInternalBaseUrl: () => testGatewayUrl,
  getGatewayPort: () => 0,
}));

// contact-search now calls cliIpcCall instead of the gateway HTTP.
// Mock the IPC client to dispatch search_contacts to the real store
// (backed by the test DB) without needing a running IPC server.
mock.module("../ipc/cli-client.js", () => ({
  cliIpcCall: async (method: string, params?: Record<string, unknown>) => {
    const store = await import("../contacts/contact-store.js");
    if (method === "search_contacts") {
      return { ok: true, result: store.searchContacts(params ?? {}) };
    }
    if (method === "upsert_contact") {
      return { ok: true, result: store.upsertContact(params as never) };
    }
    if (method === "get_contact") {
      return {
        ok: true,
        result: store.getContact((params as { id: string }).id) ?? null,
      };
    }
    if (method === "merge_contacts") {
      const { keepId, mergeId } = params as { keepId: string; mergeId: string };
      return { ok: true, result: store.mergeContacts(keepId, mergeId) };
    }
    return { ok: false, error: `Unknown IPC method: ${method}` };
  },
}));

import type { Database } from "bun:sqlite";

import { executeContactMerge } from "../config/bundled-skills/contacts/tools/contact-merge.js";
import { executeContactSearch } from "../config/bundled-skills/contacts/tools/contact-search.js";
import { executeContactUpsert } from "../config/bundled-skills/contacts/tools/contact-upsert.js";
import { getDb, initializeDb, resetDb } from "../memory/db.js";
import {
  handleGetContact,
  handleListContacts,
  handleMergeContacts,
  handleUpsertContact,
} from "../runtime/routes/contact-routes.js";
import type { ToolContext } from "../tools/types.js";

initializeDb();

// ── Lightweight gateway stub ─────────────────────────────────────────────────

let testServer: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  testServer = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;

      if (path === "/v1/contacts/merge" && req.method === "POST") {
        return handleMergeContacts(req);
      }
      if (path === "/v1/contacts" && req.method === "GET") {
        return handleListContacts(url);
      }
      if (path === "/v1/contacts" && req.method === "POST") {
        return handleUpsertContact(req);
      }
      const idMatch = path.match(/^\/v1\/contacts\/([^/]+)$/);
      if (idMatch && req.method === "GET") {
        return handleGetContact(idMatch[1]);
      }
      return new Response("Not found", { status: 404 });
    },
  });
  testGatewayUrl = `http://127.0.0.1:${testServer.port}`;
});

afterAll(() => {
  testServer?.stop(true);
  resetDb();
});

function getRawDb(): Database {
  return (getDb() as unknown as { $client: Database }).$client;
}

const ctx: ToolContext = {
  workingDir: "/tmp",
  conversationId: "test-conversation",
  trustClass: "guardian",
};

function clearContacts(): void {
  getRawDb().run("DELETE FROM contact_channels");
  getRawDb().run("DELETE FROM contacts");
}

// ── contact_upsert ──────────────────────────────────────────────────

describe("contact_upsert tool", () => {
  beforeEach(clearContacts);

  test("creates a new contact with display name only", async () => {
    const result = await executeContactUpsert({ display_name: "Alice" }, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Created contact");
    expect(result.content).toContain("Alice");
  });

  test("creates a contact with all fields", async () => {
    const result = await executeContactUpsert(
      {
        display_name: "Bob",
        notes:
          "Colleague at Acme Corp, prefers professional tone, responds within hours",
        channels: [
          { type: "email", address: "bob@example.com", is_primary: true },
          { type: "slack", address: "@bob" },
        ],
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Bob");
    expect(result.content).toContain("Notes: Colleague at Acme Corp");
    expect(result.content).toContain("email: bob@example.com");
    expect(result.content).toContain("slack: @bob");
  });

  test("ignores external identity bindings supplied through tool input", async () => {
    const result = await executeContactUpsert(
      {
        display_name: "Eve",
        channels: [
          {
            type: "slack",
            address: "@eve",
            external_user_id: "UATTACKER",
            external_chat_id: "DATTACKER",
          },
        ],
      },
      ctx,
    );

    expect(result.isError).toBe(false);

    const row = getRawDb()
      .query(
        "SELECT external_user_id, external_chat_id FROM contact_channels WHERE type = 'slack' AND address = '@eve'",
      )
      .get() as {
      external_user_id: string | null;
      external_chat_id: string | null;
    };

    expect(row.external_user_id).toBeNull();
    expect(row.external_chat_id).toBeNull();
  });

  test("updates an existing contact by ID", async () => {
    const createResult = await executeContactUpsert(
      { display_name: "Charlie" },
      ctx,
    );
    expect(createResult.isError).toBe(false);

    // Extract ID from output
    const idMatch = createResult.content.match(/Contact (\S+)/);
    expect(idMatch).not.toBeNull();
    const contactId = idMatch![1];

    const updateResult = await executeContactUpsert(
      {
        id: contactId,
        display_name: "Charlie Updated",
        notes: "Updated notes for Charlie",
      },
      ctx,
    );

    expect(updateResult.isError).toBe(false);
    expect(updateResult.content).toContain("Updated contact");
    expect(updateResult.content).toContain("Charlie Updated");
    expect(updateResult.content).toContain("Notes: Updated notes for Charlie");
  });

  test("auto-matches by channel address on create", async () => {
    // Create a contact with an email
    await executeContactUpsert(
      {
        display_name: "Diana",
        channels: [{ type: "email", address: "diana@example.com" }],
      },
      ctx,
    );

    // Upsert with same email but different display name
    const result = await executeContactUpsert(
      {
        display_name: "Diana Updated",
        channels: [{ type: "email", address: "diana@example.com" }],
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Updated contact");
    expect(result.content).toContain("Diana Updated");

    // Should still be just 1 contact
    const count = getRawDb()
      .query("SELECT COUNT(*) as c FROM contacts")
      .get() as { c: number };
    expect(count.c).toBe(1);
  });

  test("rejects missing display_name", async () => {
    const result = await executeContactUpsert({}, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("display_name is required");
  });

  test("rejects empty display_name", async () => {
    const result = await executeContactUpsert({ display_name: "   " }, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("display_name is required");
  });
});

// ── contact_search ──────────────────────────────────────────────────

describe("contact_search tool", () => {
  beforeEach(clearContacts);

  test("searches by display name", async () => {
    await executeContactUpsert({ display_name: "Alice Smith" }, ctx);
    await executeContactUpsert({ display_name: "Bob Jones" }, ctx);

    const result = await executeContactSearch({ query: "Alice" }, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Alice Smith");
    expect(result.content).not.toContain("Bob Jones");
  });

  test("searches by channel address", async () => {
    await executeContactUpsert(
      {
        display_name: "Charlie",
        channels: [{ type: "email", address: "charlie@example.com" }],
      },
      ctx,
    );

    const result = await executeContactSearch(
      { channel_address: "charlie@example" },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Charlie");
  });

  test("returns no results message when nothing matches", async () => {
    await executeContactUpsert({ display_name: "Existing" }, ctx);

    const result = await executeContactSearch({ query: "Nonexistent" }, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("No contacts found");
  });

  test("rejects search with no criteria", async () => {
    const result = await executeContactSearch({}, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "At least one search criterion is required",
    );
  });

  test("searches by channel address with type filter", async () => {
    await executeContactUpsert(
      {
        display_name: "Frank",
        channels: [
          { type: "email", address: "frank@example.com" },
          { type: "slack", address: "frank@example.com" },
        ],
      },
      ctx,
    );

    const result = await executeContactSearch(
      {
        channel_address: "frank@example",
        channel_type: "slack",
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Frank");
  });
});

// ── contact_merge ───────────────────────────────────────────────────

describe("contact_merge tool", () => {
  beforeEach(clearContacts);

  function extractContactId(result: { content: string }): string {
    const match = result.content.match(/Contact (\S+)/);
    expect(match).not.toBeNull();
    return match![1];
  }

  test("merges two contacts", async () => {
    const r1 = await executeContactUpsert(
      {
        display_name: "Alice (Email)",
        notes: "Prefers email",
        channels: [{ type: "email", address: "alice@example.com" }],
      },
      ctx,
    );
    const r2 = await executeContactUpsert(
      {
        display_name: "Alice (Slack)",
        notes: "Active on Slack",
        channels: [{ type: "slack", address: "@alice" }],
      },
      ctx,
    );

    const keepId = extractContactId(r1);
    const mergeId = extractContactId(r2);

    const result = await executeContactMerge(
      {
        keep_id: keepId,
        merge_id: mergeId,
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Merged");
    expect(result.content).toContain("Notes: Prefers email\nActive on Slack"); // concatenated notes
    expect(result.content).toContain("email: alice@example.com");
    expect(result.content).toContain("slack: @alice");

    // Verify donor is deleted
    const count = getRawDb()
      .query("SELECT COUNT(*) as c FROM contacts")
      .get() as { c: number };
    expect(count.c).toBe(1);
  });

  test("rejects missing keep_id", async () => {
    const result = await executeContactMerge({ merge_id: "some-id" }, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("keep_id is required");
  });

  test("rejects missing merge_id", async () => {
    const result = await executeContactMerge({ keep_id: "some-id" }, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("merge_id is required");
  });

  test("returns error for nonexistent keep_id", async () => {
    const r = await executeContactUpsert({ display_name: "Exists" }, ctx);
    const existingId = extractContactId(r);

    const result = await executeContactMerge(
      {
        keep_id: "nonexistent",
        merge_id: existingId,
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("not found");
  });

  test("returns error for nonexistent merge_id", async () => {
    const r = await executeContactUpsert({ display_name: "Exists" }, ctx);
    const existingId = extractContactId(r);

    const result = await executeContactMerge(
      {
        keep_id: existingId,
        merge_id: "nonexistent",
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("not found");
  });
});
