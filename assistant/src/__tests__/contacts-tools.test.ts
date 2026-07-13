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

// The tool implementations now call the gateway over HTTP.
// Mock the env/token modules and spin up a lightweight test server
// that delegates to the real route handlers (backed by the test DB).
mock.module("../config/env.js", () => ({
  getGatewayInternalBaseUrl: () => testGatewayUrl,
  getGatewayPort: () => 0,
}));

// Per-test override for the search_contacts IPC result. When set, cliIpcCall
// returns it verbatim instead of dispatching to the store — used to inject
// gateway-shaped payloads (e.g. a null interactionCount telemetry fail-soft).
let searchContactsOverride: unknown[] | null = null;

// Skill tools call cliIpcCall instead of the gateway HTTP.
// Mock the IPC client to dispatch contact reads/merge to the real store
// (backed by the test DB) without needing a running IPC server.
mock.module("../ipc/cli-client.js", () => ({
  cliIpcCall: async (method: string, params?: Record<string, unknown>) => {
    const store = await import("../contacts/contact-store.js");
    const body = (params?.body ?? params ?? {}) as Record<string, unknown>;
    const pathParams = (params?.pathParams ?? {}) as Record<string, string>;
    if (method === "search_contacts") {
      if (searchContactsOverride !== null) {
        return { ok: true, result: searchContactsOverride };
      }
      return { ok: true, result: store.searchContacts(body) };
    }
    if (method === "getContact") {
      const id = pathParams.id ?? (body as { id?: string }).id;
      const contact = id ? store.getContact(id) : null;
      if (!contact) return { ok: false, error: `Contact "${id}" not found` };
      return { ok: true, result: { ok: true, contact } };
    }
    if (method === "merge_contacts") {
      const { keepId, mergeId } = body as { keepId: string; mergeId: string };
      const contact = store.mergeContacts(keepId, mergeId);
      return { ok: true, result: { ok: true, contact } };
    }
    return { ok: false, error: `Unknown IPC method: ${method}` };
  },
}));

import type { Database } from "bun:sqlite";

import { executeContactMerge } from "../config/bundled-skills/contacts/tools/contact-merge.js";
import { executeContactSearch } from "../config/bundled-skills/contacts/tools/contact-search.js";
import { upsertContact } from "../contacts/contact-store.js";
import type { ContactWithChannels } from "../contacts/types.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { ROUTES } from "../runtime/routes/contact-routes.js";
import { RouteError } from "../runtime/routes/errors.js";
import type { ToolContext } from "../tools/types.js";
import { resetDbForTesting } from "./db-test-helpers.js";

await initializeDb();

// ── Lightweight gateway stub ─────────────────────────────────────────────────

let testServer: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  testServer = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;

      try {
        if (path === "/v1/contacts/merge" && req.method === "POST") {
          const mergeRoute = ROUTES.find(
            (r) => r.operationId === "merge_contacts",
          )!;
          const body = (await req.json()) as Record<string, unknown>;
          const result = mergeRoute.handler({ body });
          return Response.json(result);
        }
        if (path === "/v1/contacts" && req.method === "GET") {
          const listRoute = ROUTES.find(
            (r) => r.operationId === "listContacts",
          )!;
          const qp: Record<string, string> = {};
          url.searchParams.forEach((v, k) => {
            qp[k] = v;
          });
          const result = listRoute.handler({ queryParams: qp });
          return Response.json(result);
        }
      } catch (err) {
        if (err instanceof RouteError) {
          return Response.json(
            { error: err.message },
            { status: err.statusCode },
          );
        }
        throw err;
      }
      const idMatch = path.match(/^\/v1\/contacts\/([^/]+)$/);
      if (idMatch && req.method === "GET") {
        const getRoute = ROUTES.find((r) => r.operationId === "getContact")!;
        const result = getRoute.handler({ pathParams: { id: idMatch[1] } });
        return Response.json(result);
      }
      return new Response("Not found", { status: 404 });
    },
  });
  testGatewayUrl = `http://127.0.0.1:${testServer.port}`;
});

afterAll(() => {
  testServer?.stop(true);
  resetDbForTesting();
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

// ── fixture helper ──────────────────────────────────────────────────
//
// The contact_upsert skill tool was removed (gateway is now the source of
// truth — see PR #30141 + the follow-up that deleted this daemon route).
// For test fixtures we go straight to the store, which is still the
// underlying write path used by the gateway dual-write and the assistant CLI.

function upsertFixture(params: {
  display_name: string;
  notes?: string;
  channels?: Array<{ type: string; address: string; is_primary?: boolean }>;
}): ContactWithChannels {
  return upsertContact({
    displayName: params.display_name,
    notes: params.notes,
    channels: params.channels?.map((ch) => ({
      type: ch.type,
      address: ch.address,
      isPrimary: ch.is_primary,
    })),
  });
}

// ── contact_search ──────────────────────────────────────────────────

describe("contact_search tool", () => {
  beforeEach(() => {
    searchContactsOverride = null;
    clearContacts();
  });

  test("renders a null interactionCount without a false '>0' guard or a 'null' print", async () => {
    // Defensive: the daemon-native path now defaults interactionCount to 0, but
    // the ContactRead contract still permits null, so the tool must stay robust
    // to a null — neither printing "Interactions: null" nor treating null as > 0
    // (which would emit a bogus interactions line).
    searchContactsOverride = [
      {
        id: "c-blank-telemetry",
        displayName: "Telemetry Absent",
        role: "contact",
        notes: null,
        contactType: "human",
        lastInteraction: null,
        interactionCount: null,
        createdAt: 1699000000,
        updatedAt: 1700000000,
        channels: [],
      },
    ];

    const result = await executeContactSearch({ query: "Telemetry" }, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Telemetry Absent");
    // The interactions line is suppressed entirely (guard is false), so neither
    // the label nor a stringified "null" leaks into the summary.
    expect(result.content).not.toContain("Interactions");
    expect(result.content).not.toContain("null");
  });

  test("searches by display name", async () => {
    upsertFixture({ display_name: "Alice Smith" });
    upsertFixture({ display_name: "Bob Jones" });

    const result = await executeContactSearch({ query: "Alice" }, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Alice Smith");
    expect(result.content).not.toContain("Bob Jones");
  });

  test("searches by channel address", async () => {
    upsertFixture({
      display_name: "Charlie",
      channels: [{ type: "email", address: "charlie@example.com" }],
    });

    const result = await executeContactSearch(
      { channel_address: "charlie@example" },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Charlie");
  });

  test("returns no results message when nothing matches", async () => {
    upsertFixture({ display_name: "Existing" });

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
    upsertFixture({
      display_name: "Frank",
      channels: [
        { type: "email", address: "frank@example.com" },
        { type: "slack", address: "frank@example.com" },
      ],
    });

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

// ── search_contacts route (HTTP/IPC compat shim) ─────────────────────

describe("search_contacts route", () => {
  beforeEach(clearContacts);

  test("includes externalUserId (= address) on channels for older clients", async () => {
    const seeded = upsertFixture({
      display_name: "Dana",
      channels: [{ type: "slack", address: "U12345ABC" }],
    });
    const seededAddress = seeded.channels[0]!.address;

    const searchRoute = ROUTES.find(
      (r) => r.operationId === "search_contacts",
    )!;
    const contacts = (await searchRoute.handler({
      body: { channelAddress: seededAddress },
    })) as unknown as Array<{
      channels: Array<{ address: string; externalUserId?: string }>;
    }>;

    expect(contacts.length).toBeGreaterThanOrEqual(1);
    const channel = contacts[0]!.channels[0]!;
    // The route re-derives the compat field from address, so SDK/macOS
    // clients that read externalUserId keep working.
    expect(channel.externalUserId).toBe(channel.address);
  });
});

// ── contact_merge ───────────────────────────────────────────────────

describe("contact_merge tool", () => {
  beforeEach(clearContacts);

  test("merges two contacts", async () => {
    const keepId = upsertFixture({
      display_name: "Alice (Email)",
      notes: "Prefers email",
      channels: [{ type: "email", address: "alice@example.com" }],
    }).id;
    const mergeId = upsertFixture({
      display_name: "Alice (Slack)",
      notes: "Active on Slack",
      channels: [{ type: "slack", address: "@alice" }],
    }).id;

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
    const existingId = upsertFixture({ display_name: "Exists" }).id;

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
    const existingId = upsertFixture({ display_name: "Exists" }).id;

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
