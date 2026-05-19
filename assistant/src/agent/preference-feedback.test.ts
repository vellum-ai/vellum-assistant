import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { getSqlite, resetDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import {
  listPkbPreferences,
  upsertPkbPreference,
} from "../memory/personal-knowledge-store.js";
import type { Provider, ProviderResponse } from "../providers/types.js";
import { runPreferenceFeedback } from "./preference-feedback.js";

function mockProvider(responseText: string): Provider {
  return {
    name: "mock",
    async sendMessage(): Promise<ProviderResponse> {
      return {
        content: [{ type: "text", text: responseText }],
        model: "mock",
        usage: { inputTokens: 0, outputTokens: 0 },
        stopReason: "end_turn",
      };
    },
  };
}

describe("runPreferenceFeedback", () => {
  beforeAll(() => {
    resetDb();
    initializeDb();
  });

  beforeEach(() => {
    const sqlite = getSqlite();
    sqlite.run("DELETE FROM pkb_episodes");
    sqlite.run("DELETE FROM pkb_preferences");
    sqlite.run("DELETE FROM pkb_entities");
  });

  test("short-circuits when memory-maturation flag is disabled", async () => {
    const result = await runPreferenceFeedback(
      { userText: "make it shorter", assistantText: "ok." },
      { isEnabled: () => false },
    );
    expect(result.applied).toBe(false);
    expect(result.reinforced).toEqual([]);
    expect(result.contradicted).toEqual([]);
    expect(result.inferred).toEqual([]);
  });

  test("reinforces an existing preference", async () => {
    upsertPkbPreference({
      key: "communication-style",
      value: "concise",
      signal: "positive",
    });

    const result = await runPreferenceFeedback(
      { userText: "thanks, keep replies short", assistantText: "Got it." },
      {
        isEnabled: () => true,
        getProvider: async () =>
          mockProvider(
            JSON.stringify({
              reinforced: [{ key: "communication-style" }],
              contradicted: [],
              inferred: [],
            }),
          ),
      },
    );

    expect(result.applied).toBe(true);
    expect(result.reinforced).toEqual(["communication-style"]);

    const [row] = listPkbPreferences({});
    expect(row?.positiveCount).toBe(2);
    expect(row?.lastReinforcedAt).toBeGreaterThan(0);
  });

  test("contradicts and overwrites an existing preference value", async () => {
    upsertPkbPreference({
      key: "communication-style",
      value: "concise",
      signal: "positive",
    });

    const result = await runPreferenceFeedback(
      {
        userText: "actually give me more detail going forward",
        assistantText: "Will do — fuller answers from here on.",
      },
      {
        isEnabled: () => true,
        getProvider: async () =>
          mockProvider(
            JSON.stringify({
              reinforced: [],
              contradicted: [{ key: "communication-style", value: "detailed" }],
              inferred: [],
            }),
          ),
      },
    );

    expect(result.applied).toBe(true);
    expect(result.contradicted).toEqual(["communication-style"]);

    const [row] = listPkbPreferences({});
    expect(row?.value).toBe("detailed");
    expect(row?.negativeCount).toBe(1);
    expect(row?.positiveCount).toBe(1);
    expect(row?.lastContradictedAt).toBeGreaterThan(0);
  });

  test("records inferred new preferences only when key is unseen", async () => {
    upsertPkbPreference({
      key: "tone",
      value: "warm",
      signal: "positive",
    });

    const result = await runPreferenceFeedback(
      {
        userText: "I prefer metric units, please",
        assistantText: "Switching to metric.",
      },
      {
        isEnabled: () => true,
        getProvider: async () =>
          mockProvider(
            JSON.stringify({
              reinforced: [],
              contradicted: [],
              inferred: [
                { key: "units", value: "metric" },
                { key: "tone", value: "ignored — already present" },
              ],
            }),
          ),
      },
    );

    expect(result.applied).toBe(true);
    expect(result.inferred).toEqual([{ key: "units", value: "metric" }]);
    const rows = listPkbPreferences({});
    const keys = rows.map((r) => r.key);
    expect(keys).toContain("units");
    expect(keys).toContain("tone");
  });

  test("returns empty when the provider is missing", async () => {
    const result = await runPreferenceFeedback(
      { userText: "hi", assistantText: "hello" },
      { isEnabled: () => true, getProvider: async () => null },
    );
    expect(result.applied).toBe(false);
  });

  test("returns empty when the LLM response is malformed", async () => {
    upsertPkbPreference({
      key: "communication-style",
      value: "concise",
      signal: "positive",
    });
    const result = await runPreferenceFeedback(
      { userText: "hi", assistantText: "hello" },
      {
        isEnabled: () => true,
        getProvider: async () => mockProvider("not json"),
      },
    );
    expect(result.applied).toBe(false);
    expect(result.contradicted).toEqual([]);
  });

  test("skips inferred keys that already exist", async () => {
    upsertPkbPreference({
      key: "language",
      value: "english",
      signal: "positive",
    });

    const result = await runPreferenceFeedback(
      { userText: "switch to spanish", assistantText: "ok" },
      {
        isEnabled: () => true,
        getProvider: async () =>
          mockProvider(
            JSON.stringify({
              reinforced: [],
              contradicted: [],
              inferred: [{ key: "language", value: "spanish" }],
            }),
          ),
      },
    );

    expect(result.applied).toBe(false);
    expect(result.inferred).toEqual([]);
  });
});
