/**
 * Tests for the gateway channel-permission IPC routes.
 *
 * Drives the route handlers directly against a real test gateway DB — the
 * store is the unit under integration here, so no mocks.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";

import "../../__tests__/test-preload.js";
import { initGatewayDb, resetGatewayDb } from "../../db/connection.js";
import { ChannelPermissionStore } from "../../db/channel-permission-store.js";
import { channelPermissionRoutes } from "../channel-permission-handlers.js";
import type { IpcRoute } from "../server.js";

function route(method: string): IpcRoute {
  const found = channelPermissionRoutes.find((r) => r.method === method);
  if (!found) throw new Error(`route not registered: ${method}`);
  return found;
}

beforeEach(async () => {
  resetGatewayDb();
  await initGatewayDb();
  const store = new ChannelPermissionStore();
  for (const row of store.list()) {
    store.remove(row.selector, row.contactType);
  }
});

afterEach(() => {
  resetGatewayDb();
});

describe("schemas", () => {
  test("set_channel_permission_override validates the cell shape", () => {
    const schema = route("set_channel_permission_override").schema!;

    expect(
      schema.safeParse({
        selector: { scope: "workspace" },
        contactType: "trusted_contact",
        threshold: "low",
      }).success,
    ).toBe(true);

    // Selector keys must match the scope.
    expect(
      schema.safeParse({
        selector: { scope: "adapter" },
        contactType: "trusted_contact",
        threshold: "low",
      }).success,
    ).toBe(false);

    // Vocabulary is enforced.
    expect(
      schema.safeParse({
        selector: { scope: "workspace" },
        contactType: "somebody",
        threshold: "low",
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        selector: { scope: "workspace" },
        contactType: "trusted_contact",
        threshold: "sometimes",
      }).success,
    ).toBe(false);
  });

  test("resolve_channel_permission_threshold requires adapter and contactType", () => {
    const schema = route("resolve_channel_permission_threshold").schema!;
    expect(
      schema.safeParse({ adapter: "slack", contactType: "unknown" }).success,
    ).toBe(true);
    expect(schema.safeParse({ contactType: "unknown" }).success).toBe(false);
  });
});

describe("handlers", () => {
  test("set → list → resolve → delete round-trip", async () => {
    const setResult = (await route("set_channel_permission_override").handler({
      selector: { scope: "channel", adapter: "slack", channelExternalId: "C9" },
      contactType: "unverified_contact",
      threshold: "none",
      note: "test cell",
    })) as { cell: { threshold: string } };
    expect(setResult.cell.threshold).toBe("none");

    const listResult = (await route(
      "list_channel_permission_overrides",
    ).handler()) as { cells: unknown[] };
    expect(listResult.cells).toHaveLength(1);

    const resolved = (await route(
      "resolve_channel_permission_threshold",
    ).handler({
      adapter: "slack",
      channelExternalId: "C9",
      contactType: "unverified_contact",
    })) as { resolved: { threshold: string; scope: string } | null };
    expect(resolved.resolved).toEqual({ threshold: "none", scope: "channel" });

    const removed = (await route("delete_channel_permission_override").handler({
      selector: { scope: "channel", adapter: "slack", channelExternalId: "C9" },
      contactType: "unverified_contact",
    })) as { removed: boolean };
    expect(removed.removed).toBe(true);

    const resolvedAfter = (await route(
      "resolve_channel_permission_threshold",
    ).handler({
      adapter: "slack",
      channelExternalId: "C9",
      contactType: "unverified_contact",
    })) as { resolved: unknown };
    expect(resolvedAfter.resolved).toBeNull();
  });

  test("set rejects an unknown adapter", () => {
    expect(() =>
      route("set_channel_permission_override").handler({
        selector: {
          scope: "adapter",
          adapter: "carrier-pigeon",
        },
        contactType: "trusted_contact",
        threshold: "low",
      }),
    ).toThrow("Unknown channel adapter");
  });

  test("workspace-scoped set needs no adapter", async () => {
    const result = (await route("set_channel_permission_override").handler({
      selector: { scope: "workspace" },
      contactType: "unknown",
      threshold: "none",
    })) as { cell: { threshold: string } };
    expect(result.cell.threshold).toBe("none");
  });
});
