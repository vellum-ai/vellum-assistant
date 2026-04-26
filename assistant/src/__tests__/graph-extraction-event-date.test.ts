import { describe, expect, test } from "bun:test";

import {
  buildAuthoritativeConversationTimestampBlock,
  EVENT_DATE_PROMPT_RULES,
  parseEpochMs,
  parseExtractionResponse,
} from "../memory/graph/extraction.js";

// ---------------------------------------------------------------------------
// parseEpochMs unit tests
// ---------------------------------------------------------------------------

describe("parseEpochMs", () => {
  test("returns number as-is", () => {
    expect(parseEpochMs(1712534400000)).toBe(1712534400000);
  });

  test("coerces numeric string to number", () => {
    expect(parseEpochMs("1712534400000")).toBe(1712534400000);
  });

  test("returns null for non-numeric string", () => {
    expect(parseEpochMs("not a number")).toBeNull();
  });

  test("returns null for null", () => {
    expect(parseEpochMs(null)).toBeNull();
  });

  test("returns null for undefined", () => {
    expect(parseEpochMs(undefined)).toBeNull();
  });

  test("returns null for Infinity", () => {
    expect(parseEpochMs(Infinity)).toBeNull();
  });

  test("returns null for NaN", () => {
    expect(parseEpochMs(NaN)).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(parseEpochMs("")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// event_date prompt grounding
// ---------------------------------------------------------------------------

describe("event_date prompt grounding", () => {
  test("conversation timestamp block includes local and ISO anchors", () => {
    const timestamp = Date.UTC(2026, 3, 26, 18, 30, 0);
    const block = buildAuthoritativeConversationTimestampBlock(timestamp);

    expect(block).toContain("## Authoritative Conversation Timestamp");
    expect(block).toContain("Local:");
    expect(block).toContain("ISO: 2026-04-26T18:30:00.000Z");
    expect(block).toContain(
      "Use this timestamp when resolving relative or partial dates",
    );
  });

  test("event date rules prefer the conversation year for partial dates", () => {
    expect(EVENT_DATE_PROMPT_RULES).toContain(
      "use the authoritative conversation year",
    );
    expect(EVENT_DATE_PROMPT_RULES).toContain(
      "Never backdate a month/day-only reference into the prior year",
    );
    expect(EVENT_DATE_PROMPT_RULES).toContain("April 19 (Sunday night)");
  });
});

// ---------------------------------------------------------------------------
// parseExtractionResponse — event_date coercion
// ---------------------------------------------------------------------------

describe("parseExtractionResponse event_date coercion", () => {
  const candidateNodeIds = new Set<string>();
  const conversationId = "test-convo";
  const scopeId = "default";
  const now = Date.now();

  function makeInput(overrides: Record<string, unknown> = {}) {
    return {
      create_nodes: [
        {
          content: "Test memory",
          type: "episodic",
          emotional_charge: {
            valence: 0.5,
            intensity: 0.5,
            decay_curve: "linear",
            decay_rate: 0.05,
          },
          significance: 0.5,
          confidence: 0.8,
          source_type: "direct",
          ...overrides,
        },
      ],
      reinforce_node_ids: [],
    };
  }

  test("coerces string event_date on create_nodes", () => {
    const input = makeInput({ event_date: "1712534400000" });
    const { diff } = parseExtractionResponse(
      input,
      conversationId,
      scopeId,
      candidateNodeIds,
      now,
    );
    expect(diff.createNodes[0].eventDate).toBe(1712534400000);
  });

  test("passes through numeric event_date on create_nodes", () => {
    const input = makeInput({ event_date: 1712534400000 });
    const { diff } = parseExtractionResponse(
      input,
      conversationId,
      scopeId,
      candidateNodeIds,
      now,
    );
    expect(diff.createNodes[0].eventDate).toBe(1712534400000);
  });

  test("nullifies non-numeric string event_date on create_nodes", () => {
    const input = makeInput({ event_date: "next tuesday" });
    const { diff } = parseExtractionResponse(
      input,
      conversationId,
      scopeId,
      candidateNodeIds,
      now,
    );
    expect(diff.createNodes[0].eventDate).toBeNull();
  });

  test("coerces string event_date on triggers", () => {
    const input = makeInput({
      event_date: 1712534400000,
      triggers: [
        {
          type: "event",
          event_date: "1712534400000",
          ramp_days: 7,
          follow_up_days: 2,
        },
      ],
    });
    const { deferredTriggers } = parseExtractionResponse(
      input,
      conversationId,
      scopeId,
      candidateNodeIds,
      now,
    );
    // Should have the explicit trigger (coerced) plus possibly the auto-created one
    const explicitTrigger = deferredTriggers.find(
      (t) => t.trigger.eventDate === 1712534400000,
    );
    expect(explicitTrigger).toBeTruthy();
    expect(explicitTrigger!.trigger.eventDate).toBe(1712534400000);
  });

  test("coerces string event_date on update_nodes", () => {
    const existingNodeId = "existing-node-1";
    const candidates = new Set([existingNodeId]);
    const input = {
      create_nodes: [],
      reinforce_node_ids: [],
      update_nodes: [
        {
          id: existingNodeId,
          event_date: "1712534400000",
        },
      ],
    };
    const { diff } = parseExtractionResponse(
      input,
      conversationId,
      scopeId,
      candidates,
      now,
    );
    expect(diff.updateNodes[0].changes.eventDate).toBe(1712534400000);
  });

  test("null-clears event_date on update_nodes when explicitly null", () => {
    const existingNodeId = "existing-node-1";
    const candidates = new Set([existingNodeId]);
    const input = {
      create_nodes: [],
      reinforce_node_ids: [],
      update_nodes: [
        {
          id: existingNodeId,
          event_date: null,
        },
      ],
    };
    const { diff } = parseExtractionResponse(
      input,
      conversationId,
      scopeId,
      candidates,
      now,
    );
    expect(diff.updateNodes[0].changes.eventDate).toBeNull();
  });
});
