import { describe, expect, test } from "bun:test";

import { parseExtractionResponse } from "./extraction.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CONV_ID = "conv-test-1";
const SCOPE_ID = "default";
const NOW = Date.now();

function parse(input: Record<string, unknown>, candidateIds: string[] = []) {
  return parseExtractionResponse(
    input,
    CONV_ID,
    SCOPE_ID,
    new Set(candidateIds),
    NOW,
  );
}

// ---------------------------------------------------------------------------
// Node creation
// ---------------------------------------------------------------------------

describe("parseExtractionResponse — node creation", () => {
  test("parses a valid create_node into a NewNode", () => {
    const { diff } = parse({
      create_nodes: [
        {
          content: "User loves hiking.",
          type: "semantic",
          emotional_charge: {
            valence: 0.3,
            intensity: 0.2,
            decay_curve: "linear",
            decay_rate: 0.05,
          },
          significance: 0.6,
          confidence: 0.9,
          source_type: "direct",
        },
      ],
      reinforce_node_ids: [],
    });

    expect(diff.createNodes).toHaveLength(1);
    const node = diff.createNodes[0];
    expect(node.content).toBe("User loves hiking.");
    expect(node.type).toBe("semantic");
    expect(node.emotionalCharge.valence).toBe(0.3);
    expect(node.emotionalCharge.intensity).toBe(0.2);
    expect(node.emotionalCharge.decayCurve).toBe("linear");
    expect(node.emotionalCharge.decayRate).toBe(0.05);
    expect(node.emotionalCharge.originalIntensity).toBe(0.2);
    expect(node.significance).toBe(0.6);
    expect(node.confidence).toBe(0.9);
    expect(node.sourceType).toBe("direct");
    expect(node.fidelity).toBe("vivid");
    expect(node.stability).toBe(14);
    expect(node.reinforcementCount).toBe(0);
    expect(node.created).toBe(NOW);
    expect(node.sourceConversations).toEqual([CONV_ID]);
    expect(node.scopeId).toBe(SCOPE_ID);
  });

  test("prospective nodes get stability=5", () => {
    const { diff } = parse({
      create_nodes: [
        {
          content: "Deploy the new version tomorrow.",
          type: "prospective",
          emotional_charge: {
            valence: 0.1,
            intensity: 0.1,
            decay_curve: "linear",
            decay_rate: 0.05,
          },
          significance: 0.5,
          confidence: 0.8,
          source_type: "direct",
        },
      ],
      reinforce_node_ids: [],
    });

    expect(diff.createNodes[0].stability).toBe(5);
  });

  test("non-prospective nodes get default stability=14", () => {
    const { diff } = parse({
      create_nodes: [
        {
          content: "User graduated from MIT.",
          type: "semantic",
          emotional_charge: {
            valence: 0.5,
            intensity: 0.3,
            decay_curve: "transformative",
            decay_rate: 0.02,
          },
          significance: 0.7,
          confidence: 0.95,
          source_type: "direct",
        },
      ],
      reinforce_node_ids: [],
    });

    expect(diff.createNodes[0].stability).toBe(14);
  });

  test("procedural nodes get stability=60", () => {
    const { diff } = parse({
      create_nodes: [
        {
          content: "ffmpeg needs -ac 2 to force stereo output.",
          type: "procedural",
          emotional_charge: {
            valence: 0,
            intensity: 0,
            decay_curve: "linear",
            decay_rate: 0.05,
          },
          significance: 0.5,
          confidence: 0.9,
          source_type: "direct",
        },
      ],
      reinforce_node_ids: [],
    });

    expect(diff.createNodes[0].stability).toBe(60);
  });

  test("clamps significance to [0, 1]", () => {
    const { diff } = parse({
      create_nodes: [
        {
          content: "Test",
          type: "semantic",
          emotional_charge: {
            valence: 0,
            intensity: 0,
            decay_curve: "linear",
            decay_rate: 0.05,
          },
          significance: 1.5, // over max
          confidence: 0.5,
          source_type: "direct",
        },
      ],
      reinforce_node_ids: [],
    });
    expect(diff.createNodes[0].significance).toBe(1.0);
  });

  test("clamps negative significance to 0", () => {
    const { diff } = parse({
      create_nodes: [
        {
          content: "Test",
          type: "semantic",
          emotional_charge: {
            valence: 0,
            intensity: 0,
            decay_curve: "linear",
            decay_rate: 0.05,
          },
          significance: -0.5,
          confidence: 0.5,
          source_type: "direct",
        },
      ],
      reinforce_node_ids: [],
    });
    expect(diff.createNodes[0].significance).toBe(0);
  });

  test("clamps valence to [-1, 1]", () => {
    const { diff } = parse({
      create_nodes: [
        {
          content: "Test",
          type: "semantic",
          emotional_charge: {
            valence: 2.0,
            intensity: 0.5,
            decay_curve: "linear",
            decay_rate: 0.05,
          },
          significance: 0.5,
          confidence: 0.5,
          source_type: "direct",
        },
      ],
      reinforce_node_ids: [],
    });
    expect(diff.createNodes[0].emotionalCharge.valence).toBe(1);
  });

  test("defaults invalid decay_curve to linear", () => {
    const { diff } = parse({
      create_nodes: [
        {
          content: "Test",
          type: "semantic",
          emotional_charge: {
            valence: 0,
            intensity: 0.5,
            decay_curve: "bogus",
            decay_rate: 0.05,
          },
          significance: 0.5,
          confidence: 0.5,
          source_type: "direct",
        },
      ],
      reinforce_node_ids: [],
    });
    expect(diff.createNodes[0].emotionalCharge.decayCurve).toBe("linear");
  });

  test("defaults invalid source_type to inferred", () => {
    const { diff } = parse({
      create_nodes: [
        {
          content: "Test",
          type: "semantic",
          emotional_charge: {
            valence: 0,
            intensity: 0,
            decay_curve: "linear",
            decay_rate: 0.05,
          },
          significance: 0.5,
          confidence: 0.5,
          source_type: "bogus",
        },
      ],
      reinforce_node_ids: [],
    });
    expect(diff.createNodes[0].sourceType).toBe("inferred");
  });

  test("skips nodes with missing content", () => {
    const { diff } = parse({
      create_nodes: [{ type: "semantic" }],
      reinforce_node_ids: [],
    });
    expect(diff.createNodes).toHaveLength(0);
  });

  test("skips nodes with invalid type", () => {
    const { diff } = parse({
      create_nodes: [
        {
          content: "Test",
          type: "invalid_type",
          emotional_charge: {
            valence: 0,
            intensity: 0,
            decay_curve: "linear",
            decay_rate: 0.05,
          },
          significance: 0.5,
          confidence: 0.5,
          source_type: "direct",
        },
      ],
      reinforce_node_ids: [],
    });
    expect(diff.createNodes).toHaveLength(0);
  });

  test("defaults missing emotional_charge fields", () => {
    const { diff } = parse({
      create_nodes: [
        {
          content: "Test",
          type: "semantic",
          emotional_charge: {}, // all fields missing
          significance: 0.5,
          confidence: 0.5,
          source_type: "direct",
        },
      ],
      reinforce_node_ids: [],
    });
    const charge = diff.createNodes[0].emotionalCharge;
    expect(charge.valence).toBe(0);
    expect(charge.intensity).toBe(0);
    expect(charge.decayCurve).toBe("linear");
    expect(charge.decayRate).toBe(0.05);
    expect(charge.originalIntensity).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Reinforcement
// ---------------------------------------------------------------------------

describe("parseExtractionResponse — reinforcement", () => {
  test("only includes IDs that exist in candidate set", () => {
    const { diff } = parse(
      {
        create_nodes: [],
        reinforce_node_ids: ["existing-1", "fake-id", "existing-2"],
      },
      ["existing-1", "existing-2"],
    );
    expect(diff.reinforceNodeIds).toEqual(["existing-1", "existing-2"]);
  });

  test("returns empty array when no IDs match candidates", () => {
    const { diff } = parse(
      {
        create_nodes: [],
        reinforce_node_ids: ["fake-1", "fake-2"],
      },
      ["real-1"],
    );
    expect(diff.reinforceNodeIds).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Node updates
// ---------------------------------------------------------------------------

describe("parseExtractionResponse — updates", () => {
  test("parses content update for existing node", () => {
    const { diff } = parse(
      {
        create_nodes: [],
        reinforce_node_ids: [],
        update_nodes: [{ id: "node-1", content: "Updated content." }],
      },
      ["node-1"],
    );
    expect(diff.updateNodes).toHaveLength(1);
    expect(diff.updateNodes[0].id).toBe("node-1");
    expect(diff.updateNodes[0].changes.content).toBe("Updated content.");
  });

  test("parses fidelity downgrade", () => {
    const { diff } = parse(
      {
        create_nodes: [],
        reinforce_node_ids: [],
        update_nodes: [{ id: "node-1", fidelity: "gist" }],
      },
      ["node-1"],
    );
    expect(diff.updateNodes[0].changes.fidelity).toBe("gist");
  });

  test("ignores invalid fidelity values", () => {
    const { diff } = parse(
      {
        create_nodes: [],
        reinforce_node_ids: [],
        update_nodes: [{ id: "node-1", fidelity: "super-vivid" }],
      },
      ["node-1"],
    );
    // No valid changes → should not produce an update entry
    expect(diff.updateNodes).toHaveLength(0);
  });

  test("clamps updated significance to [0, 1]", () => {
    const { diff } = parse(
      {
        create_nodes: [],
        reinforce_node_ids: [],
        update_nodes: [{ id: "node-1", significance: 1.5 }],
      },
      ["node-1"],
    );
    expect(diff.updateNodes[0].changes.significance).toBe(1.0);
  });

  test("skips updates for nodes not in candidate set", () => {
    const { diff } = parse(
      {
        create_nodes: [],
        reinforce_node_ids: [],
        update_nodes: [{ id: "unknown-node", content: "New content." }],
      },
      ["node-1"],
    );
    expect(diff.updateNodes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Edges between existing nodes
// ---------------------------------------------------------------------------

describe("parseExtractionResponse — edges", () => {
  test("creates edges between existing candidate nodes", () => {
    const { diff } = parse(
      {
        create_nodes: [],
        reinforce_node_ids: [],
        new_edges: [
          {
            source_node_id: "a",
            target_node_id: "b",
            relationship: "caused-by",
            weight: 0.8,
          },
        ],
      },
      ["a", "b"],
    );
    expect(diff.createEdges).toHaveLength(1);
    expect(diff.createEdges[0].sourceNodeId).toBe("a");
    expect(diff.createEdges[0].targetNodeId).toBe("b");
    expect(diff.createEdges[0].relationship).toBe("caused-by");
    expect(diff.createEdges[0].weight).toBe(0.8);
  });

  test("skips edges referencing non-candidate nodes", () => {
    const { diff } = parse(
      {
        create_nodes: [],
        reinforce_node_ids: [],
        new_edges: [
          {
            source_node_id: "a",
            target_node_id: "unknown",
            relationship: "caused-by",
          },
        ],
      },
      ["a"],
    );
    expect(diff.createEdges).toHaveLength(0);
  });

  test("skips edges with invalid relationships", () => {
    const { diff } = parse(
      {
        create_nodes: [],
        reinforce_node_ids: [],
        new_edges: [
          {
            source_node_id: "a",
            target_node_id: "b",
            relationship: "invalid-rel",
          },
        ],
      },
      ["a", "b"],
    );
    expect(diff.createEdges).toHaveLength(0);
  });

  test("defaults edge weight to 1.0", () => {
    const { diff } = parse(
      {
        create_nodes: [],
        reinforce_node_ids: [],
        new_edges: [
          {
            source_node_id: "a",
            target_node_id: "b",
            relationship: "reminds-of",
          },
        ],
      },
      ["a", "b"],
    );
    expect(diff.createEdges[0].weight).toBe(1.0);
  });
});

// ---------------------------------------------------------------------------
// Deferred edges (new node → existing node)
// ---------------------------------------------------------------------------

describe("parseExtractionResponse — deferred edges", () => {
  test("collects edges from new nodes to existing candidates", () => {
    const { deferredEdges } = parse(
      {
        create_nodes: [
          {
            content: "New memory.",
            type: "episodic",
            emotional_charge: {
              valence: 0,
              intensity: 0,
              decay_curve: "linear",
              decay_rate: 0.05,
            },
            significance: 0.5,
            confidence: 0.5,
            source_type: "direct",
            edges_to_existing: [
              {
                target_node_id: "existing-1",
                relationship: "caused-by",
                weight: 0.7,
              },
            ],
          },
        ],
        reinforce_node_ids: [],
      },
      ["existing-1"],
    );
    expect(deferredEdges).toHaveLength(1);
    expect(deferredEdges[0].newNodeIndex).toBe(0);
    expect(deferredEdges[0].targetNodeId).toBe("existing-1");
    expect(deferredEdges[0].relationship).toBe("caused-by");
    expect(deferredEdges[0].weight).toBe(0.7);
  });

  test("ignores deferred edges to non-candidate targets", () => {
    const { deferredEdges } = parse(
      {
        create_nodes: [
          {
            content: "New memory.",
            type: "episodic",
            emotional_charge: {
              valence: 0,
              intensity: 0,
              decay_curve: "linear",
              decay_rate: 0.05,
            },
            significance: 0.5,
            confidence: 0.5,
            source_type: "direct",
            edges_to_existing: [
              {
                target_node_id: "non-existing",
                relationship: "caused-by",
              },
            ],
          },
        ],
        reinforce_node_ids: [],
      },
      ["other-node"],
    );
    expect(deferredEdges).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Deferred triggers
// ---------------------------------------------------------------------------

describe("parseExtractionResponse — deferred triggers", () => {
  test("collects temporal triggers for new nodes", () => {
    const { deferredTriggers } = parse({
      create_nodes: [
        {
          content: "Check in every Monday.",
          type: "prospective",
          emotional_charge: {
            valence: 0,
            intensity: 0,
            decay_curve: "linear",
            decay_rate: 0.05,
          },
          significance: 0.4,
          confidence: 0.8,
          source_type: "direct",
          triggers: [
            {
              type: "temporal",
              schedule: "day-of-week:monday",
              recurring: true,
            },
          ],
        },
      ],
      reinforce_node_ids: [],
    });

    expect(deferredTriggers).toHaveLength(1);
    expect(deferredTriggers[0].newNodeIndex).toBe(0);
    expect(deferredTriggers[0].trigger.type).toBe("temporal");
    expect(deferredTriggers[0].trigger.schedule).toBe("day-of-week:monday");
    expect(deferredTriggers[0].trigger.recurring).toBe(true);
    expect(deferredTriggers[0].trigger.cooldownMs).toBe(1000 * 60 * 60 * 12);
  });

  test("collects semantic triggers with default threshold 0.7", () => {
    const { deferredTriggers } = parse({
      create_nodes: [
        {
          content: "When cooking comes up, mention the recipe.",
          type: "semantic",
          emotional_charge: {
            valence: 0.3,
            intensity: 0.2,
            decay_curve: "linear",
            decay_rate: 0.05,
          },
          significance: 0.4,
          confidence: 0.7,
          source_type: "direct",
          triggers: [
            {
              type: "semantic",
              condition: "topic of cooking comes up",
            },
          ],
        },
      ],
      reinforce_node_ids: [],
    });

    expect(deferredTriggers[0].trigger.type).toBe("semantic");
    expect(deferredTriggers[0].trigger.threshold).toBe(0.7);
    expect(deferredTriggers[0].trigger.condition).toBe(
      "topic of cooking comes up",
    );
  });

  test("collects event triggers with date and ramp settings", () => {
    const eventDate = Date.now() + 7 * 24 * 60 * 60 * 1000;
    const { deferredTriggers } = parse({
      create_nodes: [
        {
          content: "Trip next week.",
          type: "prospective",
          emotional_charge: {
            valence: 0.5,
            intensity: 0.4,
            decay_curve: "linear",
            decay_rate: 0.05,
          },
          significance: 0.6,
          confidence: 0.9,
          source_type: "direct",
          triggers: [
            {
              type: "event",
              event_date: eventDate,
              ramp_days: 5,
              follow_up_days: 3,
            },
          ],
        },
      ],
      reinforce_node_ids: [],
    });

    expect(deferredTriggers[0].trigger.type).toBe("event");
    expect(deferredTriggers[0].trigger.eventDate).toBe(eventDate);
    expect(deferredTriggers[0].trigger.rampDays).toBe(5);
    expect(deferredTriggers[0].trigger.followUpDays).toBe(3);
  });

  test("skips triggers with invalid types", () => {
    const { deferredTriggers } = parse({
      create_nodes: [
        {
          content: "Test.",
          type: "semantic",
          emotional_charge: {
            valence: 0,
            intensity: 0,
            decay_curve: "linear",
            decay_rate: 0.05,
          },
          significance: 0.5,
          confidence: 0.5,
          source_type: "direct",
          triggers: [{ type: "invalid-type" }],
        },
      ],
      reinforce_node_ids: [],
    });
    expect(deferredTriggers).toHaveLength(0);
  });

  test("non-recurring triggers get null cooldownMs", () => {
    const { deferredTriggers } = parse({
      create_nodes: [
        {
          content: "One-time check.",
          type: "prospective",
          emotional_charge: {
            valence: 0,
            intensity: 0,
            decay_curve: "linear",
            decay_rate: 0.05,
          },
          significance: 0.5,
          confidence: 0.5,
          source_type: "direct",
          triggers: [
            {
              type: "temporal",
              schedule: "date:04-08",
              recurring: false,
            },
          ],
        },
      ],
      reinforce_node_ids: [],
    });
    expect(deferredTriggers[0].trigger.recurring).toBe(false);
    expect(deferredTriggers[0].trigger.cooldownMs).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// event_date parsing
// ---------------------------------------------------------------------------

describe("parseExtractionResponse — event_date parsing", () => {
  test("parses event_date onto node.eventDate", () => {
    const eventDate = NOW + 7 * 24 * 60 * 60 * 1000;
    const { diff } = parse({
      create_nodes: [
        {
          content: "Flight to NYC on April 8.",
          type: "prospective",
          emotional_charge: {
            valence: 0.4,
            intensity: 0.3,
            decay_curve: "linear",
            decay_rate: 0.05,
          },
          significance: 0.6,
          confidence: 0.9,
          source_type: "direct",
          event_date: eventDate,
        },
      ],
      reinforce_node_ids: [],
    });

    expect(diff.createNodes).toHaveLength(1);
    expect(diff.createNodes[0].eventDate).toBe(eventDate);
  });

  test("event_date: null results in eventDate: null", () => {
    const { diff } = parse({
      create_nodes: [
        {
          content: "User likes hiking.",
          type: "semantic",
          emotional_charge: {
            valence: 0.3,
            intensity: 0.2,
            decay_curve: "linear",
            decay_rate: 0.05,
          },
          significance: 0.5,
          confidence: 0.8,
          source_type: "direct",
          event_date: null,
        },
      ],
      reinforce_node_ids: [],
    });

    expect(diff.createNodes[0].eventDate).toBeNull();
  });

  test("missing event_date results in eventDate: null", () => {
    const { diff } = parse({
      create_nodes: [
        {
          content: "User likes dark mode.",
          type: "semantic",
          emotional_charge: {
            valence: 0,
            intensity: 0.1,
            decay_curve: "linear",
            decay_rate: 0.05,
          },
          significance: 0.3,
          confidence: 0.9,
          source_type: "direct",
        },
      ],
      reinforce_node_ids: [],
    });

    expect(diff.createNodes[0].eventDate).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Auto-trigger for event_date
// ---------------------------------------------------------------------------

describe("parseExtractionResponse — event_date auto-trigger", () => {
  test("auto-creates event trigger when event_date is set but no event trigger provided", () => {
    const eventDate = NOW + 7 * 24 * 60 * 60 * 1000;
    const { diff, deferredTriggers } = parse({
      create_nodes: [
        {
          content: "Dentist appointment next week.",
          type: "prospective",
          emotional_charge: {
            valence: -0.1,
            intensity: 0.2,
            decay_curve: "linear",
            decay_rate: 0.05,
          },
          significance: 0.5,
          confidence: 0.9,
          source_type: "direct",
          event_date: eventDate,
        },
      ],
      reinforce_node_ids: [],
    });

    expect(diff.createNodes).toHaveLength(1);
    expect(diff.createNodes[0].eventDate).toBe(eventDate);
    expect(deferredTriggers).toHaveLength(1);
    expect(deferredTriggers[0].newNodeIndex).toBe(0);
    expect(deferredTriggers[0].trigger.type).toBe("event");
    expect(deferredTriggers[0].trigger.eventDate).toBe(eventDate);
    expect(deferredTriggers[0].trigger.rampDays).toBe(7);
    expect(deferredTriggers[0].trigger.followUpDays).toBe(2);
    expect(deferredTriggers[0].trigger.recurring).toBe(false);
    expect(deferredTriggers[0].trigger.consumed).toBe(false);
    expect(deferredTriggers[0].trigger.cooldownMs).toBeNull();
  });

  test("no duplicate trigger when LLM already provided an event trigger", () => {
    const eventDate = NOW + 7 * 24 * 60 * 60 * 1000;
    const { deferredTriggers } = parse({
      create_nodes: [
        {
          content: "Trip to Paris next week.",
          type: "prospective",
          emotional_charge: {
            valence: 0.6,
            intensity: 0.5,
            decay_curve: "linear",
            decay_rate: 0.05,
          },
          significance: 0.7,
          confidence: 0.9,
          source_type: "direct",
          event_date: eventDate,
          triggers: [
            {
              type: "event",
              event_date: eventDate,
              ramp_days: 5,
              follow_up_days: 3,
            },
          ],
        },
      ],
      reinforce_node_ids: [],
    });

    // Should only have the LLM-provided trigger, no auto-created duplicate
    expect(deferredTriggers).toHaveLength(1);
    expect(deferredTriggers[0].trigger.type).toBe("event");
    expect(deferredTriggers[0].trigger.rampDays).toBe(5); // LLM's value, not auto-trigger's 7
  });

  test("auto-creates event trigger alongside non-event triggers", () => {
    const eventDate = NOW + 14 * 24 * 60 * 60 * 1000;
    const { deferredTriggers } = parse({
      create_nodes: [
        {
          content: "Project deadline in two weeks.",
          type: "prospective",
          emotional_charge: {
            valence: -0.2,
            intensity: 0.4,
            decay_curve: "linear",
            decay_rate: 0.05,
          },
          significance: 0.6,
          confidence: 0.8,
          source_type: "direct",
          event_date: eventDate,
          triggers: [
            {
              type: "semantic",
              condition: "project deadline discussion",
            },
          ],
        },
      ],
      reinforce_node_ids: [],
    });

    // Should have the LLM-provided semantic trigger plus an auto-created event trigger
    expect(deferredTriggers).toHaveLength(2);
    const types = deferredTriggers.map((t) => t.trigger.type);
    expect(types).toContain("semantic");
    expect(types).toContain("event");

    const autoTrigger = deferredTriggers.find(
      (t) => t.trigger.type === "event",
    )!;
    expect(autoTrigger.trigger.eventDate).toBe(eventDate);
    expect(autoTrigger.trigger.rampDays).toBe(7);
  });

  test("no auto-trigger when event_date is not set", () => {
    const { deferredTriggers } = parse({
      create_nodes: [
        {
          content: "User likes functional programming.",
          type: "semantic",
          emotional_charge: {
            valence: 0.2,
            intensity: 0.1,
            decay_curve: "linear",
            decay_rate: 0.05,
          },
          significance: 0.3,
          confidence: 0.9,
          source_type: "direct",
        },
      ],
      reinforce_node_ids: [],
    });

    expect(deferredTriggers).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Empty / missing fields
// ---------------------------------------------------------------------------

describe("parseExtractionResponse — robustness", () => {
  test("handles completely empty input", () => {
    const { diff, deferredEdges, deferredTriggers } = parse({});
    expect(diff.createNodes).toHaveLength(0);
    expect(diff.updateNodes).toHaveLength(0);
    expect(diff.reinforceNodeIds).toEqual([]);
    expect(diff.createEdges).toHaveLength(0);
    expect(deferredEdges).toHaveLength(0);
    expect(deferredTriggers).toHaveLength(0);
  });

  test("handles missing create_nodes gracefully", () => {
    const { diff } = parse({ reinforce_node_ids: [] });
    expect(diff.createNodes).toHaveLength(0);
  });

  test("handles missing reinforce_node_ids gracefully", () => {
    const { diff } = parse({ create_nodes: [] });
    expect(diff.reinforceNodeIds).toEqual([]);
  });
});
