import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { DEFAULT_INJECTOR_ORDER } from "../plugins/defaults/injector-order.js";
import { workspaceInjectors } from "../plugins/defaults/workspace/injectors.js";
import type { Injector, TurnContext } from "../plugins/types.js";
import { getConfigValidationResetNoticePath } from "../util/platform.js";

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

const NOTICE_PATH = getConfigValidationResetNoticePath();

function writeNotice(resetAt: string, invalidPaths: string[]): void {
  const dir = dirname(NOTICE_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(
    NOTICE_PATH,
    JSON.stringify({ resetAt, invalidPaths }, null, 2),
    "utf-8",
  );
}

function clearNotice(): void {
  rmSync(NOTICE_PATH, { force: true });
}

const injector = findInjector("config-validation-reset-notice");

describe("config-validation-reset-notice injector", () => {
  beforeEach(() => {
    clearNotice();
  });

  afterEach(() => {
    clearNotice();
  });

  test("registered at the expected order with prepend-user-tail placement", async () => {
    expect(injector.order).toBe(
      DEFAULT_INJECTOR_ORDER.configValidationResetNotice,
    );
    writeNotice(new Date().toISOString(), [
      "llm.callSites.proactiveArtifactDecision",
    ]);
    const block = await injector.produce(makeContext());
    expect(block?.placement).toBe("prepend-user-tail");
  });

  test("returns null when no sentinel is present", async () => {
    const block = await injector.produce(makeContext());
    expect(block).toBeNull();
  });

  test("injects a config-reset block naming the invalid paths when fresh", async () => {
    writeNotice(new Date().toISOString(), [
      "llm.callSites.proactiveArtifactDecision",
      "llm.activeProfile",
    ]);

    const block = await injector.produce(makeContext());
    expect(block).not.toBeNull();
    expect(block?.id).toBe("config-validation-reset-notice");
    expect(block?.text).toContain("<config_reset_notice>");
    expect(block?.text).toContain("</config_reset_notice>");
    // Names the offending config paths so the agent can guide recovery.
    expect(block?.text).toContain("llm.activeProfile");
    // Steers away from trusting stale memory for the connection status.
    expect(block?.text).toContain("assistant oauth status");
    // The sentinel is left in place until the config re-validates or it ages out.
    expect(existsSync(NOTICE_PATH)).toBe(true);
  });

  test("renders a fallback label when the invalid-path list is empty", async () => {
    writeNotice(new Date().toISOString(), []);
    const block = await injector.produce(makeContext());
    expect(block?.text).toContain("(top-level)");
  });

  test("injects nothing on non-guardian turns even when the sentinel is fresh", async () => {
    writeNotice(new Date().toISOString(), ["llm.activeProfile"]);

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
    writeNotice(eightDaysAgo, ["llm.activeProfile"]);

    const block = await injector.produce(makeContext());
    expect(block).toBeNull();
    expect(existsSync(NOTICE_PATH)).toBe(false);
  });
});
