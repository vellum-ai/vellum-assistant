import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { initGatewayDb, resetGatewayDb } from "../db/connection.js";
import type { ChannelPermissionCellRow } from "@vellumai/gateway-client";
import { ChannelPermissionStore } from "../db/channel-permission-store.js";
import {
  createChannelPermissionOverrideDeleteHandler,
  createChannelPermissionOverridesListHandler,
  createChannelPermissionOverrideSetHandler,
} from "../http/routes/channel-permission-overrides.js";
import "./test-preload.js";

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let store: ChannelPermissionStore;

beforeEach(async () => {
  resetGatewayDb();
  await initGatewayDb();
  store = new ChannelPermissionStore();
  for (const row of store.list()) {
    store.remove(row.selector, row.contactType);
  }
});

afterEach(() => {
  resetGatewayDb();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonRequest(url: string, method: string, body?: unknown): Request {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  return new Request(url, init);
}

const SLACK_CHANNEL_CELL = {
  selector: {
    scope: "channel" as const,
    adapter: "slack",
    channelExternalId: "C123",
  },
  contactType: "trusted_contact" as const,
  threshold: "none" as const,
};

// ---------------------------------------------------------------------------
// GET /v1/channel-permission-overrides
// ---------------------------------------------------------------------------

describe("GET /v1/channel-permission-overrides", () => {
  test("returns only persisted cells", async () => {
    store.set(SLACK_CHANNEL_CELL);

    const handler = createChannelPermissionOverridesListHandler();
    const res = await handler(
      jsonRequest("http://localhost/v1/channel-permission-overrides", "GET"),
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as { cells: ChannelPermissionCellRow[] };
    expect(body.cells).toHaveLength(1);
    expect(body.cells[0]!.selector).toEqual(SLACK_CHANNEL_CELL.selector);
    expect(body.cells[0]!.threshold).toBe("none");
  });

  test("returns an empty list when nothing is persisted", async () => {
    const handler = createChannelPermissionOverridesListHandler();
    const res = await handler(
      jsonRequest("http://localhost/v1/channel-permission-overrides", "GET"),
    );
    const body = (await res.json()) as { cells: ChannelPermissionCellRow[] };
    expect(body.cells).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// PUT /v1/channel-permission-overrides
// ---------------------------------------------------------------------------

describe("PUT /v1/channel-permission-overrides", () => {
  test("upserts a cell and returns the stored row", async () => {
    const handler = createChannelPermissionOverrideSetHandler();
    const res = await handler(
      jsonRequest(
        "http://localhost/v1/channel-permission-overrides",
        "PUT",
        SLACK_CHANNEL_CELL,
      ),
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as { cell: ChannelPermissionCellRow };
    expect(body.cell.threshold).toBe("none");
    expect(body.cell.updatedAt).toBeGreaterThan(0);
    expect(store.list()).toHaveLength(1);
  });

  test("second write to the same key updates in place", async () => {
    const handler = createChannelPermissionOverrideSetHandler();
    await handler(
      jsonRequest(
        "http://localhost/v1/channel-permission-overrides",
        "PUT",
        SLACK_CHANNEL_CELL,
      ),
    );
    await handler(
      jsonRequest("http://localhost/v1/channel-permission-overrides", "PUT", {
        ...SLACK_CHANNEL_CELL,
        threshold: "low",
      }),
    );

    const rows = store.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.threshold).toBe("low");
  });

  test("rejects an unknown adapter with 400", async () => {
    const handler = createChannelPermissionOverrideSetHandler();
    const res = await handler(
      jsonRequest("http://localhost/v1/channel-permission-overrides", "PUT", {
        ...SLACK_CHANNEL_CELL,
        selector: {
          scope: "channel",
          adapter: "carrier-pigeon",
          channelExternalId: "C123",
        },
      }),
    );
    expect(res.status).toBe(400);
    expect(store.list()).toHaveLength(0);
  });

  test("rejects an invalid body with 400 and zod issues", async () => {
    const handler = createChannelPermissionOverrideSetHandler();
    const res = await handler(
      jsonRequest("http://localhost/v1/channel-permission-overrides", "PUT", {
        selector: { scope: "channel", adapter: "slack" },
        contactType: "trusted_contact",
        threshold: "sky-high",
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { issues?: unknown[] };
    expect(Array.isArray(body.issues)).toBe(true);
  });

  test("rejects stale cross-scope keys (strict selector branches)", async () => {
    const handler = createChannelPermissionOverrideSetHandler();
    const res = await handler(
      jsonRequest("http://localhost/v1/channel-permission-overrides", "PUT", {
        ...SLACK_CHANNEL_CELL,
        selector: { scope: "workspace", channelExternalId: "C9" },
      }),
    );
    expect(res.status).toBe(400);
  });

  test("rejects malformed JSON with 400", async () => {
    const handler = createChannelPermissionOverrideSetHandler();
    const res = await handler(
      new Request("http://localhost/v1/channel-permission-overrides", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: "{not json",
      }),
    );
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POST /v1/channel-permission-overrides/delete
// ---------------------------------------------------------------------------

describe("POST /v1/channel-permission-overrides/delete", () => {
  test("removes the cell and reports removal", async () => {
    store.set(SLACK_CHANNEL_CELL);

    const handler = createChannelPermissionOverrideDeleteHandler();
    const res = await handler(
      jsonRequest(
        "http://localhost/v1/channel-permission-overrides/delete",
        "POST",
        {
          selector: SLACK_CHANNEL_CELL.selector,
          contactType: SLACK_CHANNEL_CELL.contactType,
        },
      ),
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as { removed: boolean };
    expect(body.removed).toBe(true);
    expect(store.list()).toHaveLength(0);
  });

  test("reports removed: false for an absent cell", async () => {
    const handler = createChannelPermissionOverrideDeleteHandler();
    const res = await handler(
      jsonRequest(
        "http://localhost/v1/channel-permission-overrides/delete",
        "POST",
        {
          selector: SLACK_CHANNEL_CELL.selector,
          contactType: "unknown",
        },
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { removed: boolean };
    expect(body.removed).toBe(false);
  });

  test("rejects an unknown adapter with 400", async () => {
    const handler = createChannelPermissionOverrideDeleteHandler();
    const res = await handler(
      jsonRequest(
        "http://localhost/v1/channel-permission-overrides/delete",
        "POST",
        {
          selector: {
            scope: "adapter",
            adapter: "carrier-pigeon",
          },
          contactType: "trusted_contact",
        },
      ),
    );
    expect(res.status).toBe(400);
  });
});
