/**
 * `getOrCreateConversation` doubles as the first-conversation bootstrap
 * bookkeeper: the first standard conversation is the onboarding one (keep
 * BOOTSTRAP.md), and the second means onboarding is over (delete it).
 *
 * Onboarding also mints internal side threads (research, personality rewrite,
 * identity rewrite) as `conversationType: "background"` rows that the user
 * never opens. Those must be completely inert with respect to this bookkeeping:
 * if a hidden side thread consumed the first-conversation slot, the user's
 * FIRST visible chat would look like the second conversation and lose
 * BOOTSTRAP.md before its opening turn.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "bun:test";

import { assertNotLiveDb } from "./assert-not-live-db.js";

const testDir = process.env.VELLUM_WORKSPACE_DIR!;
const conversationsDir = join(testDir, "conversations");
mkdirSync(conversationsDir, { recursive: true });

import {
  _resetFirstConversationSeenForTesting,
  getOrCreateConversation,
} from "../persistence/conversation-key-store.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import {
  conversationKeys,
  conversations,
} from "../persistence/schema/index.js";

await initializeDb();

const bootstrapPath = join(testDir, "BOOTSTRAP.md");
const bootstrapReferencePath = join(testDir, "BOOTSTRAP-REFERENCE.md");

function seedBootstrapFiles(): void {
  writeFileSync(bootstrapPath, "# First run\n", "utf-8");
  writeFileSync(bootstrapReferencePath, "# Reference\n", "utf-8");
}

beforeEach(() => {
  const db = getDb();
  db.delete(conversationKeys).run();
  db.delete(conversations).run();

  assertNotLiveDb(conversationsDir);
  rmSync(conversationsDir, { recursive: true, force: true });
  mkdirSync(conversationsDir, { recursive: true });

  // `firstConversationSeen` is module-level (process-global) state, so each
  // test has to replay the fresh-install sequence from a known-clean flag.
  _resetFirstConversationSeenForTesting();
  seedBootstrapFiles();
});

describe("getOrCreateConversation bootstrap bookkeeping", () => {
  test("background side threads do not consume the first-conversation slot", () => {
    // The exact onboarding sequence: three hidden side threads, then the
    // user's first real chat.
    for (const key of ["onboarding-research", "personality", "identity"]) {
      const created = getOrCreateConversation(key, {
        conversationType: "background",
      });
      expect(created.created).toBe(true);
      expect(created.conversationType).toBe("background");
      expect(existsSync(bootstrapPath)).toBe(true);
    }

    const firstVisible = getOrCreateConversation("user-first-chat");
    expect(firstVisible.created).toBe(true);
    expect(firstVisible.conversationType).toBe("standard");

    // The user's first visible chat is still the FIRST conversation as far as
    // onboarding is concerned, so its first-run context survives.
    expect(existsSync(bootstrapPath)).toBe(true);
    expect(existsSync(bootstrapReferencePath)).toBe(true);
  });

  test("a background create after the first standard one is still inert", () => {
    getOrCreateConversation("user-first-chat");
    expect(existsSync(bootstrapPath)).toBe(true);

    getOrCreateConversation("side-thread", { conversationType: "background" });
    expect(existsSync(bootstrapPath)).toBe(true);
    expect(existsSync(bootstrapReferencePath)).toBe(true);
  });

  test("the second standard conversation still deletes the bootstrap files", () => {
    getOrCreateConversation("first-chat");
    expect(existsSync(bootstrapPath)).toBe(true);

    getOrCreateConversation("second-chat");
    expect(existsSync(bootstrapPath)).toBe(false);
    expect(existsSync(bootstrapReferencePath)).toBe(false);
  });

  test("background creates interleaved with standard ones do not shift the slot", () => {
    getOrCreateConversation("bg-a", { conversationType: "background" });
    getOrCreateConversation("first-chat");
    getOrCreateConversation("bg-b", { conversationType: "background" });
    expect(existsSync(bootstrapPath)).toBe(true);

    // Only the second STANDARD conversation ends onboarding.
    getOrCreateConversation("second-chat");
    expect(existsSync(bootstrapPath)).toBe(false);
  });

  test("resolving an existing key never re-runs the bookkeeping", () => {
    const first = getOrCreateConversation("first-chat");
    const again = getOrCreateConversation("first-chat");
    expect(again.created).toBe(false);
    expect(again.conversationId).toBe(first.conversationId);
    expect(existsSync(bootstrapPath)).toBe(true);
  });
});
