/**
 * Tests for m0012-migrate-slack-channel-permissions.
 *
 * Verifies the one-time lift of `skills.entries.slack.config.channelPermissions`
 * into gateway `channel_permission_overrides`: trustLevel "restricted"
 * profiles become channel-scoped Strict cells for the non-guardian
 * contact-types; everything else migrates nothing; guardian-configured cells
 * are never overwritten.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import "./test-preload.js";
import { getConfigPath } from "../config-file-utils.js";
import { initGatewayDb, resetGatewayDb } from "../db/connection.js";
import { ChannelPermissionStore } from "../db/channel-permission-store.js";
import { up } from "../db/data-migrations/m0012-migrate-slack-channel-permissions.js";

function writeConfig(data: Record<string, unknown>): void {
  const path = getConfigPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data), "utf-8");
}

function slackConfig(
  channelPermissions: Record<string, unknown>,
): Record<string, unknown> {
  return {
    skills: { entries: { slack: { config: { channelPermissions } } } },
  };
}

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
  rmSync(getConfigPath(), { force: true });
  resetGatewayDb();
});

describe("m0012-migrate-slack-channel-permissions", () => {
  test("restricted profile becomes Strict cells for the non-guardian contact-types", () => {
    writeConfig(
      slackConfig({
        C123: { trustLevel: "restricted", blockedTools: ["bash"] },
      }),
    );

    expect(up()).toBe("done");

    const selector = {
      scope: "channel",
      adapter: "slack",
      channelExternalId: "C123",
    } as const;
    for (const contactType of [
      "trusted_contact",
      "unverified_contact",
      "unknown",
    ] as const) {
      const cell = store.get(selector, contactType);
      expect(cell).not.toBeNull();
      expect(cell!.threshold).toBe("none");
      expect(cell!.note).toContain("Migrated from Slack skill");
    }
    // The guardian column is never written by the migration.
    expect(store.get(selector, "guardian")).toBeNull();
  });

  test("standard / tool-only profiles migrate nothing", () => {
    writeConfig(
      slackConfig({
        C1: { trustLevel: "standard" },
        C2: { blockedTools: ["bash"], allowedToolCategories: ["search"] },
        C3: { label: "general" },
      }),
    );

    expect(up()).toBe("done");
    expect(store.list()).toHaveLength(0);
  });

  test("missing config or missing channelPermissions is done, not retried", () => {
    // No config file at all.
    expect(up()).toBe("done");

    writeConfig({ skills: { entries: {} } });
    expect(up()).toBe("done");
    expect(store.list()).toHaveLength(0);
  });

  test("malformed config is skip — retried on next startup, not checkpointed", () => {
    const path = getConfigPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{"skills": {truncated-mid-wr', "utf-8");

    expect(up()).toBe("skip");
    expect(store.list()).toHaveLength(0);

    // Once the config is readable again, the retry migrates normally.
    writeConfig(slackConfig({ C123: { trustLevel: "restricted" } }));
    expect(up()).toBe("done");
    expect(
      store.get(
        { scope: "channel", adapter: "slack", channelExternalId: "C123" },
        "trusted_contact",
      ),
    ).not.toBeNull();
  });

  test("re-running never overwrites a guardian-edited cell", () => {
    writeConfig(slackConfig({ C123: { trustLevel: "restricted" } }));
    expect(up()).toBe("done");

    const selector = {
      scope: "channel",
      adapter: "slack",
      channelExternalId: "C123",
    } as const;
    // Guardian relaxes the migrated cell…
    store.set({
      selector,
      contactType: "trusted_contact",
      threshold: "medium",
    });

    // …and a re-run (e.g. after a "skip" retry) leaves the edit intact.
    expect(up()).toBe("done");
    expect(store.get(selector, "trusted_contact")!.threshold).toBe("medium");
  });

  test("malformed profile entries are skipped without aborting the rest", () => {
    writeConfig(
      slackConfig({
        C1: "not-an-object",
        C2: null,
        C3: { trustLevel: "restricted" },
      }),
    );

    expect(up()).toBe("done");
    expect(
      store.get(
        { scope: "channel", adapter: "slack", channelExternalId: "C3" },
        "unknown",
      ),
    ).not.toBeNull();
  });
});
