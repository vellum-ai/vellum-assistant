import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { DEFAULT_INJECTOR_ORDER } from "../plugins/defaults/injector-order.js";
import { workspaceInjectors } from "../plugins/defaults/workspace/injectors.js";
import type { Injector, TurnContext } from "../plugins/types.js";
import { getConfigQuarantineNoticePath } from "../util/platform.js";

function findInjector(name: string): Injector {
  const injector = workspaceInjectors.find(
    (candidate) => candidate.name === name,
  );
  if (!injector) {
    throw new Error(`injector '${name}' not registered`);
  }
  return injector;
}

function makeContext(overrides: Partial<TurnContext> = {}): TurnContext {
  return {
    requestId: "req-test",
    conversationId: "conv-test",
    turnIndex: 0,
    trust: { sourceChannel: "vellum", trustClass: "guardian" },
    ...overrides,
  };
}

const NOTICE_PATH = getConfigQuarantineNoticePath();

function writeNotice(quarantinedAt: string): void {
  const dir = dirname(NOTICE_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(
    NOTICE_PATH,
    JSON.stringify(
      {
        quarantinedAt,
        quarantinePath: "/ws/config.json.corrupt-x.json",
        originalPath: "/ws/config.json",
      },
      null,
      2,
    ),
    "utf-8",
  );
}

function clearNotice(): void {
  rmSync(NOTICE_PATH, { force: true });
}

const injector = findInjector("config-quarantine-notice");

describe("config-quarantine-notice injector", () => {
  beforeEach(() => {
    clearNotice();
  });

  afterEach(() => {
    clearNotice();
  });

  test("registered at the expected order with prepend-user-tail placement", async () => {
    expect(injector.order).toBe(DEFAULT_INJECTOR_ORDER.configQuarantineNotice);
    writeNotice(new Date().toISOString());
    const block = await injector.produce(makeContext());
    expect(block?.placement).toBe("prepend-user-tail");
  });

  test("returns null when no sentinel is present", async () => {
    const block = await injector.produce(makeContext());
    expect(block).toBeNull();
  });

  test("injects a config-reset block when the sentinel is present and fresh", async () => {
    writeNotice(new Date().toISOString());

    const block = await injector.produce(makeContext());
    expect(block).not.toBeNull();
    expect(block?.id).toBe("config-quarantine-notice");
    expect(block?.text).toContain("<config_reset_notice>");
    expect(block?.text).toContain("</config_reset_notice>");
    expect(block?.text).toContain("/ws/config.json.corrupt-x.json");
    // The sentinel is left in place for subsequent turns until it ages out.
    expect(existsSync(NOTICE_PATH)).toBe(true);
  });

  test("injects nothing on non-guardian turns even when the sentinel is fresh", async () => {
    writeNotice(new Date().toISOString());

    for (const trustClass of ["trusted_contact", "unknown"] as const) {
      const block = await injector.produce(
        makeContext({ trust: { sourceChannel: "slack", trustClass } }),
      );
      expect(block).toBeNull();
    }
    // The sentinel is untouched — it remains for guardian turns.
    expect(existsSync(NOTICE_PATH)).toBe(true);
  });

  test("deletes the sentinel and injects nothing when it is stale (>7 days)", async () => {
    const eightDaysAgo = new Date(
      Date.now() - 8 * 24 * 60 * 60 * 1000,
    ).toISOString();
    writeNotice(eightDaysAgo);

    const block = await injector.produce(makeContext());
    expect(block).toBeNull();
    expect(existsSync(NOTICE_PATH)).toBe(false);
  });
});
