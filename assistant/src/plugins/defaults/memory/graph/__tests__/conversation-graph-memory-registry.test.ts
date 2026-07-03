/**
 * Tests for the live, per-conversation {@link ConversationGraphMemory} registry
 * (`getLiveGraphMemory`). The registry lets memory-domain code that only knows
 * a conversation id — notably the post-compaction re-injection hook — reach the
 * same in-memory handle the turn's retrieval mutated, without the agent loop
 * threading the handle through its generic context.
 */
import { describe, expect, mock, test } from "bun:test";

import { createMockLoggerModule } from "../../../../../__tests__/helpers/mock-logger.js";

mock.module("../../../../../util/logger.js", () => createMockLoggerModule());

const { ConversationGraphMemory, getLiveGraphMemory } =
  await import("../conversation-graph-memory.js");

describe("ConversationGraphMemory live registry", () => {
  test("a constructed handle is discoverable by its conversation id", () => {
    /**
     * Tests that constructing a handle registers it so it can be looked up.
     */

    // GIVEN a conversation id
    const conversationId = `conv-registry-${crypto.randomUUID()}`;

    // WHEN a graph handle is constructed for it
    const handle = new ConversationGraphMemory(conversationId);

    // THEN the registry returns that exact instance
    expect(getLiveGraphMemory(conversationId)).toBe(handle);
  });

  test("dispose removes the handle from the registry", () => {
    /**
     * Tests that disposing a handle unregisters it.
     */

    // GIVEN a registered graph handle
    const conversationId = `conv-registry-${crypto.randomUUID()}`;
    const handle = new ConversationGraphMemory(conversationId);

    // WHEN it is disposed
    handle.dispose();

    // THEN the registry no longer resolves the conversation id
    expect(getLiveGraphMemory(conversationId)).toBeUndefined();
  });

  test("missing id and undefined id both resolve to undefined", () => {
    /**
     * Tests the lookup's absence handling for unknown and undefined keys.
     */

    // GIVEN no handle registered for these keys
    // WHEN the registry is queried with an unknown id and with undefined
    // THEN both resolve to undefined (the hook treats absence as "no graph")
    expect(
      getLiveGraphMemory(`conv-never-${crypto.randomUUID()}`),
    ).toBeUndefined();
    expect(getLiveGraphMemory(undefined)).toBeUndefined();
  });

  test("recreating for the same id replaces the registered handle", () => {
    /**
     * Tests that the latest constructed handle wins for a conversation id.
     */

    // GIVEN a handle already registered for a conversation id
    const conversationId = `conv-registry-${crypto.randomUUID()}`;
    new ConversationGraphMemory(conversationId);

    // WHEN a second handle is constructed for the same id
    const recreated = new ConversationGraphMemory(conversationId);

    // THEN the registry resolves to the most recent instance
    expect(getLiveGraphMemory(conversationId)).toBe(recreated);
  });

  test("disposing a stale handle does not evict the current one", () => {
    /**
     * Tests the dispose guard during an eviction + recreation race: a stale
     * handle must not delete the live entry that now points at a newer handle.
     */

    // GIVEN a superseded (stale) handle and the current handle for one id
    const conversationId = `conv-registry-${crypto.randomUUID()}`;
    const stale = new ConversationGraphMemory(conversationId);
    const current = new ConversationGraphMemory(conversationId);

    // WHEN the stale handle is disposed
    stale.dispose();

    // THEN the registry still resolves to the current handle
    expect(getLiveGraphMemory(conversationId)).toBe(current);
  });

  test("records and exposes the PKB query vector pair from the registry", () => {
    /**
     * Tests that the dense/sparse PKB query pair recorded during retrieval is
     * readable off the same live handle the PKB-reminder injector looks up.
     */

    // GIVEN a registered graph handle with no recorded vectors yet
    const conversationId = `conv-registry-${crypto.randomUUID()}`;
    const handle = new ConversationGraphMemory(conversationId);
    expect(handle.pkbQueryVector).toBeUndefined();
    expect(handle.pkbSparseVector).toBeUndefined();

    // WHEN a retrieval records the turn's dense/sparse pair
    const dense = [0.1, 0.2, 0.3];
    const sparse = { indices: [0, 2], values: [0.5, 0.9] };
    handle.recordPkbQueryVectors(dense, sparse);

    // THEN a registry consumer reads back the same pair by conversation id
    const looked = getLiveGraphMemory(conversationId);
    expect(looked?.pkbQueryVector).toBe(dense);
    expect(looked?.pkbSparseVector).toBe(sparse);
  });
});
