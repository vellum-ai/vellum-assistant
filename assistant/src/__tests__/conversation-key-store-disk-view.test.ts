import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
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
import { getDb, initializeDb } from "../memory/db.js";
import { conversationKeys, conversations } from "../memory/schema.js";

initializeDb();

beforeEach(() => {
  const db = getDb();
  db.delete(conversationKeys).run();
  db.delete(conversations).run();

  rmSync(conversationsDir, { recursive: true, force: true });
  mkdirSync(conversationsDir, { recursive: true });
});

describe("conversation-key-store disk view", () => {
  test("creates disk-view directory on first key use and reuses it on second call", () => {
    const first = getOrCreateConversation("client-key");
    expect(first.created).toBe(true);

    const db = getDb();
    const conversation = db
      .select({ id: conversations.id, createdAt: conversations.createdAt })
      .from(conversations)
      .where(eq(conversations.id, first.conversationId))
      .get();
    expect(conversation).not.toBeUndefined();

    const expectedDirName = `${new Date(conversation!.createdAt).toISOString().replace(/:/g, "-")}_${first.conversationId}`;
    const metaPath = join(conversationsDir, expectedDirName, "meta.json");
    expect(existsSync(metaPath)).toBe(true);

    const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
    expect(meta.id).toBe(first.conversationId);
    expect(meta.title).toBe("Generating title...");
    expect(meta.type).toBe("standard");
    expect(meta.channel).toBeNull();
    expect(readdirSync(conversationsDir)).toEqual([expectedDirName]);

    const second = getOrCreateConversation("client-key");
    expect(second.created).toBe(false);
    expect(second.conversationId).toBe(first.conversationId);

    const conversationRows = db
      .select({ id: conversations.id })
      .from(conversations)
      .all();
    const keyRows = db
      .select({ id: conversationKeys.id })
      .from(conversationKeys)
      .all();
    expect(conversationRows).toHaveLength(1);
    expect(keyRows).toHaveLength(1);
    expect(readdirSync(conversationsDir)).toEqual([expectedDirName]);
  });
});
