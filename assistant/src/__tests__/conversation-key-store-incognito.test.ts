import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, mock, test } from "bun:test";

import { eq } from "drizzle-orm";

const testDir = process.env.VELLUM_WORKSPACE_DIR!;
const conversationsDir = join(testDir, "conversations");
mkdirSync(conversationsDir, { recursive: true });

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},
    model: "test",
    provider: "test",
    memory: { enabled: false },
    rateLimit: { maxRequestsPerMinute: 0 },
    secretDetection: { enabled: false },
    contextWindow: { maxInputTokens: 200000 },
    services: {
      inference: {
        mode: "your-own",
        provider: "anthropic",
        model: "claude-opus-4-6",
      },
      "image-generation": {
        mode: "your-own",
        provider: "gemini",
        model: "gemini-3.1-flash-image-preview",
      },
      "web-search": { mode: "your-own", provider: "inference-provider-native" },
    },
  }),
}));

import { getOrCreateConversation } from "../memory/conversation-key-store.js";
import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { conversationKeys, conversations } from "../memory/schema.js";

initializeDb();

function readFlags(conversationId: string) {
  return getDb()
    .select({
      incognito: conversations.incognito,
      factorInMemories: conversations.factorInMemories,
    })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .get();
}

beforeEach(() => {
  const db = getDb();
  db.delete(conversationKeys).run();
  db.delete(conversations).run();

  rmSync(conversationsDir, { recursive: true, force: true });
  mkdirSync(conversationsDir, { recursive: true });
});

describe("conversation-key-store incognito flags", () => {
  test("incognito create persists incognito=1 and chosen factor_in_memories=0", () => {
    const result = getOrCreateConversation("incognito-key", {
      conversationType: "standard",
      incognito: true,
      factorInMemories: false,
    });
    expect(result.created).toBe(true);

    const flags = readFlags(result.conversationId);
    expect(flags?.incognito).toBe(1);
    expect(flags?.factorInMemories).toBe(0);
  });

  test("normal create persists incognito=0 and factor_in_memories=1", () => {
    const result = getOrCreateConversation("normal-key", {
      conversationType: "standard",
      incognito: false,
      factorInMemories: true,
    });
    expect(result.created).toBe(true);

    const flags = readFlags(result.conversationId);
    expect(flags?.incognito).toBe(0);
    expect(flags?.factorInMemories).toBe(1);
  });

  test("defaults to non-incognito with memory factoring when flags omitted", () => {
    const result = getOrCreateConversation("default-key");
    expect(result.created).toBe(true);

    const flags = readFlags(result.conversationId);
    expect(flags?.incognito).toBe(0);
    expect(flags?.factorInMemories).toBe(1);
  });
});
