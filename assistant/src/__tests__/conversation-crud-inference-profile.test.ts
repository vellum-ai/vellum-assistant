import { beforeEach, describe, expect, mock, test } from "bun:test";

import { makeMockLogger } from "./helpers/mock-logger.js";

mock.module("../util/logger.js", () => ({
  getLogger: () => makeMockLogger(),
}));

import {
  createConversation,
  getConversation,
  setConversationInferenceProfile,
} from "../memory/conversation-crud.js";
import { getDb, initializeDb } from "../memory/db.js";

initializeDb();

describe("setConversationInferenceProfile", () => {
  beforeEach(() => {
    const db = getDb();
    db.run(`DELETE FROM messages`);
    db.run(`DELETE FROM conversations`);
  });

  test("round-trips null → name → null on the inferenceProfile column", async () => {
    const conv = createConversation("inference-profile-roundtrip");
    expect(getConversation(conv.id)?.inferenceProfile).toBeNull();

    await setConversationInferenceProfile(conv.id, "quality-optimized");
    expect(getConversation(conv.id)?.inferenceProfile).toBe(
      "quality-optimized",
    );

    await setConversationInferenceProfile(conv.id, null);
    expect(getConversation(conv.id)?.inferenceProfile).toBeNull();
  });

  test("does not throw when called with a valid conversation id", async () => {
    const conv = createConversation("inference-profile-no-throw");
    await setConversationInferenceProfile(conv.id, "balanced");
    await setConversationInferenceProfile(conv.id, null);
  });

  test("getConversation surfaces the column on every fetch", async () => {
    const conv = createConversation("inference-profile-getter");
    const fresh = getConversation(conv.id);
    expect(fresh).not.toBeNull();
    expect(fresh).toHaveProperty("inferenceProfile", null);

    await setConversationInferenceProfile(conv.id, "cost-optimized");
    const updated = getConversation(conv.id);
    expect(updated).toHaveProperty("inferenceProfile", "cost-optimized");
  });
});
