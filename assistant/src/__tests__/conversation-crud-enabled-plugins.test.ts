import { beforeEach, describe, expect, test } from "bun:test";

import {
  addMessage,
  createConversation,
  forkConversation,
  getConversation,
  getConversationEnabledPlugins,
  setConversationEnabledPlugins,
} from "../persistence/conversation-crud.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
await initializeDb();

describe("getConversationEnabledPlugins / setConversationEnabledPlugins", () => {
  beforeEach(() => {
    const db = getDb();
    db.run(`DELETE FROM messages`);
    db.run(`DELETE FROM conversations`);
  });

  test("defaults to null on a fresh conversation", () => {
    const conv = createConversation("enabled-plugins-default");
    expect(getConversationEnabledPlugins(conv.id)).toBeNull();
    expect(getConversation(conv.id)?.enabledPlugins).toBeNull();
  });

  test("round-trips a plugin list and clears it with null", () => {
    const conv = createConversation("enabled-plugins-roundtrip");

    setConversationEnabledPlugins(conv.id, ["a", "b"]);
    expect(getConversationEnabledPlugins(conv.id)).toEqual(["a", "b"]);
    expect(getConversation(conv.id)?.enabledPlugins).toEqual(["a", "b"]);

    setConversationEnabledPlugins(conv.id, null);
    expect(getConversationEnabledPlugins(conv.id)).toBeNull();
    expect(getConversation(conv.id)?.enabledPlugins).toBeNull();
  });

  test("stores an empty list distinctly from null", () => {
    const conv = createConversation("enabled-plugins-empty");
    setConversationEnabledPlugins(conv.id, []);
    expect(getConversationEnabledPlugins(conv.id)).toEqual([]);
  });

  test("a forked conversation carries the plugin selection", async () => {
    const conv = createConversation("enabled-plugins-fork-source");
    setConversationEnabledPlugins(conv.id, ["x", "y"]);
    await addMessage(conv.id, "user", "hi");

    const forked = forkConversation({ conversationId: conv.id });
    expect(getConversationEnabledPlugins(forked.id)).toEqual(["x", "y"]);
  });
});
