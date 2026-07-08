import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { initGatewayDb, resetGatewayDb } from "../db/connection.js";
import { ChannelPermissionStore } from "../db/channel-permission-store.js";
import "./test-preload.js";

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
// CRUD
// ---------------------------------------------------------------------------

describe("set() / get()", () => {
  test("round-trips a workspace-scoped cell", () => {
    store.set({
      selector: { scope: "workspace" },
      contactType: "trusted_contact",
      threshold: "low",
    });

    const cell = store.get({ scope: "workspace" }, "trusted_contact");
    expect(cell).not.toBeNull();
    expect(cell!.threshold).toBe("low");
    expect(cell!.note).toBeNull();
  });

  test("round-trips a channel-scoped cell with a note", () => {
    store.set({
      selector: {
        scope: "channel",
        adapter: "slack",
        channelExternalId: "C123",
      },
      contactType: "unknown",
      threshold: "none",
      note: "locked down",
    });

    const cell = store.get(
      { scope: "channel", adapter: "slack", channelExternalId: "C123" },
      "unknown",
    );
    expect(cell).not.toBeNull();
    expect(cell!.threshold).toBe("none");
    expect(cell!.note).toBe("locked down");
  });

  test("upserts: setting the same cell twice keeps one row with the new value", () => {
    const selector = { scope: "adapter", adapter: "slack" } as const;
    store.set({ selector, contactType: "trusted_contact", threshold: "low" });
    store.set({ selector, contactType: "trusted_contact", threshold: "high" });

    expect(store.get(selector, "trusted_contact")!.threshold).toBe("high");
    expect(store.list()).toHaveLength(1);
  });

  test("cells are independent per contact-type", () => {
    const selector = { scope: "adapter", adapter: "slack" } as const;
    store.set({
      selector,
      contactType: "trusted_contact",
      threshold: "medium",
    });
    store.set({ selector, contactType: "unknown", threshold: "none" });

    expect(store.get(selector, "trusted_contact")!.threshold).toBe("medium");
    expect(store.get(selector, "unknown")!.threshold).toBe("none");
    expect(store.get(selector, "guardian")).toBeNull();
  });

  test("cells are independent per selector: same adapter, different channels", () => {
    store.set({
      selector: { scope: "channel", adapter: "slack", channelExternalId: "C1" },
      contactType: "trusted_contact",
      threshold: "none",
    });

    expect(
      store.get(
        { scope: "channel", adapter: "slack", channelExternalId: "C2" },
        "trusted_contact",
      ),
    ).toBeNull();
  });
});

describe("list() / remove()", () => {
  test("list returns every persisted cell", () => {
    store.set({
      selector: { scope: "workspace" },
      contactType: "trusted_contact",
      threshold: "low",
    });
    store.set({
      selector: { scope: "channel_type", adapter: "slack", channelType: "dm" },
      contactType: "unknown",
      threshold: "none",
    });

    const cells = store.list();
    expect(cells).toHaveLength(2);
    const scopes = cells.map((c) => c.selector.scope).sort();
    expect(scopes).toEqual(["channel_type", "workspace"]);
  });

  test("remove deletes exactly one cell and reports absence", () => {
    const selector = {
      scope: "channel_type",
      adapter: "slack",
      channelType: "public",
    } as const;
    store.set({
      selector,
      contactType: "trusted_contact",
      threshold: "medium",
    });
    store.set({ selector, contactType: "unknown", threshold: "none" });

    expect(store.remove(selector, "trusted_contact")).toBe(true);
    expect(store.get(selector, "trusted_contact")).toBeNull();
    expect(store.get(selector, "unknown")!.threshold).toBe("none");
    expect(store.remove(selector, "trusted_contact")).toBe(false);
  });
});

describe("seedCell()", () => {
  test("seeds only when absent — never overwrites a configured cell", () => {
    const selector = { scope: "workspace" } as const;
    expect(
      store.seedCell({ selector, contactType: "unknown", threshold: "none" }),
    ).toBe(true);
    expect(
      store.seedCell({ selector, contactType: "unknown", threshold: "high" }),
    ).toBe(false);
    expect(store.get(selector, "unknown")!.threshold).toBe("none");
  });
});

// ---------------------------------------------------------------------------
// Cascade resolution — most specific wins
// ---------------------------------------------------------------------------

describe("resolve()", () => {
  const query = {
    adapter: "slack",
    channelType: "public",
    channelExternalId: "C42",
    contactType: "trusted_contact",
  } as const;

  test("returns null when no level has a cell", () => {
    expect(store.resolve(query)).toBeNull();
  });

  test("falls through to the workspace default", () => {
    store.set({
      selector: { scope: "workspace" },
      contactType: "trusted_contact",
      threshold: "low",
    });
    expect(store.resolve(query)).toEqual({
      threshold: "low",
      scope: "workspace",
    });
  });

  test("adapter beats workspace", () => {
    store.set({
      selector: { scope: "workspace" },
      contactType: "trusted_contact",
      threshold: "low",
    });
    store.set({
      selector: { scope: "adapter", adapter: "slack" },
      contactType: "trusted_contact",
      threshold: "medium",
    });
    expect(store.resolve(query)).toEqual({
      threshold: "medium",
      scope: "adapter",
    });
  });

  test("channel-type beats adapter", () => {
    store.set({
      selector: { scope: "adapter", adapter: "slack" },
      contactType: "trusted_contact",
      threshold: "medium",
    });
    store.set({
      selector: {
        scope: "channel_type",
        adapter: "slack",
        channelType: "public",
      },
      contactType: "trusted_contact",
      threshold: "high",
    });
    expect(store.resolve(query)).toEqual({
      threshold: "high",
      scope: "channel_type",
    });
  });

  test("channel-ID beats every other level", () => {
    store.set({
      selector: { scope: "workspace" },
      contactType: "trusted_contact",
      threshold: "high",
    });
    store.set({
      selector: { scope: "adapter", adapter: "slack" },
      contactType: "trusted_contact",
      threshold: "high",
    });
    store.set({
      selector: {
        scope: "channel_type",
        adapter: "slack",
        channelType: "public",
      },
      contactType: "trusted_contact",
      threshold: "high",
    });
    store.set({
      selector: {
        scope: "channel",
        adapter: "slack",
        channelExternalId: "C42",
      },
      contactType: "trusted_contact",
      threshold: "none",
    });
    expect(store.resolve(query)).toEqual({
      threshold: "none",
      scope: "channel",
    });
  });

  test("a different contact-type does not inherit another type's cells", () => {
    store.set({
      selector: {
        scope: "channel",
        adapter: "slack",
        channelExternalId: "C42",
      },
      contactType: "unknown",
      threshold: "none",
    });
    expect(store.resolve(query)).toBeNull();
  });

  test("missing query keys shrink the cascade", () => {
    store.set({
      selector: {
        scope: "channel",
        adapter: "slack",
        channelExternalId: "C42",
      },
      contactType: "trusted_contact",
      threshold: "none",
    });
    store.set({
      selector: {
        scope: "channel_type",
        adapter: "slack",
        channelType: "public",
      },
      contactType: "trusted_contact",
      threshold: "medium",
    });

    // No channelExternalId → the channel-scoped cell cannot match.
    expect(
      store.resolve({
        adapter: "slack",
        channelType: "public",
        contactType: "trusted_contact",
      }),
    ).toEqual({ threshold: "medium", scope: "channel_type" });

    // No channelType either → falls through past channel_type.
    expect(
      store.resolve({ adapter: "slack", contactType: "trusted_contact" }),
    ).toBeNull();
  });

  test("a different adapter does not inherit slack cells", () => {
    store.set({
      selector: { scope: "adapter", adapter: "slack" },
      contactType: "trusted_contact",
      threshold: "none",
    });
    expect(
      store.resolve({ adapter: "telegram", contactType: "trusted_contact" }),
    ).toBeNull();
  });
});
