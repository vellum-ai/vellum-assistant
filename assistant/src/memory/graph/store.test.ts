import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { initializeDb, resetTestTables } from "../db.js";
import {
  applyDiff,
  countNodes,
  createEdge,
  createNode,
  createTrigger,
  deduplicateParagraphs,
  deleteEdge,
  deleteNode,
  deleteTrigger,
  getActiveTriggersByType,
  getEdgesForNode,
  getNode,
  getNodesByIds,
  getTriggersForNode,
  queryNodes,
  reinforceNode,
  supersedeNode,
  updateNode,
  updateTrigger,
} from "./store.js";
import type { NewNode } from "./types.js";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

function makeNewNode(overrides: Partial<NewNode> = {}): NewNode {
  const now = Date.now();
  return {
    content: "Test memory.",
    type: "episodic",
    created: now,
    lastAccessed: now,
    lastConsolidated: now,
    eventDate: null,
    emotionalCharge: {
      valence: 0,
      intensity: 0.3,
      decayCurve: "linear",
      decayRate: 0.05,
      originalIntensity: 0.3,
    },
    fidelity: "vivid",
    confidence: 0.8,
    significance: 0.5,
    stability: 14,
    reinforcementCount: 0,
    lastReinforced: now,
    sourceConversations: ["conv-1"],
    sourceType: "direct",
    narrativeRole: null,
    partOfStory: null,
    imageRefs: null,
    scopeId: "default",
    ...overrides,
  };
}

beforeAll(() => {
  initializeDb();
});

beforeEach(() => {
  resetTestTables(
    "memory_graph_triggers",
    "memory_graph_edges",
    "memory_graph_nodes",
  );
});

// ---------------------------------------------------------------------------
// Node CRUD
// ---------------------------------------------------------------------------

describe("node CRUD", () => {
  test("createNode assigns an ID and returns the full node", () => {
    const node = createNode(makeNewNode({ content: "Hello world." }));
    expect(node.id).toBeTruthy();
    expect(typeof node.id).toBe("string");
    expect(node.content).toBe("Hello world.");
    expect(node.type).toBe("episodic");
  });

  test("getNode returns the node by ID", () => {
    const created = createNode(makeNewNode({ content: "Find me." }));
    const found = getNode(created.id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(created.id);
    expect(found!.content).toBe("Find me.");
  });

  test("getNode returns null for non-existent ID", () => {
    expect(getNode("non-existent")).toBeNull();
  });

  test("getNodesByIds returns multiple nodes", () => {
    const a = createNode(makeNewNode({ content: "Node A." }));
    const b = createNode(makeNewNode({ content: "Node B." }));
    createNode(makeNewNode({ content: "Node C." }));

    const found = getNodesByIds([a.id, b.id]);
    expect(found).toHaveLength(2);
    const contents = found.map((n) => n.content).sort();
    expect(contents).toEqual(["Node A.", "Node B."]);
  });

  test("getNodesByIds returns empty for empty input", () => {
    expect(getNodesByIds([])).toEqual([]);
  });

  test("updateNode modifies specified fields", () => {
    const node = createNode(makeNewNode({ content: "Original." }));
    updateNode(node.id, {
      content: "Updated.",
      significance: 0.9,
    });
    const updated = getNode(node.id);
    expect(updated!.content).toBe("Updated.");
    expect(updated!.significance).toBe(0.9);
    // Untouched fields should remain
    expect(updated!.type).toBe("episodic");
  });

  test("updateNode with empty changes is a no-op", () => {
    const node = createNode(makeNewNode({ content: "Unchanged." }));
    updateNode(node.id, {});
    const same = getNode(node.id);
    expect(same!.content).toBe("Unchanged.");
  });

  test("updateNode serializes emotionalCharge as JSON", () => {
    const node = createNode(makeNewNode());
    updateNode(node.id, {
      emotionalCharge: {
        valence: 0.8,
        intensity: 0.9,
        decayCurve: "permanent",
        decayRate: 0,
        originalIntensity: 0.9,
      },
    });
    const updated = getNode(node.id);
    expect(updated!.emotionalCharge.valence).toBe(0.8);
    expect(updated!.emotionalCharge.decayCurve).toBe("permanent");
  });

  test("createNode with eventDate round-trips through getNode", () => {
    const eventDate = Date.now() - 86400000; // yesterday
    const node = createNode(makeNewNode({ eventDate }));
    const found = getNode(node.id);
    expect(found).not.toBeNull();
    expect(found!.eventDate).toBe(eventDate);
  });

  test("createNode with null eventDate round-trips as null", () => {
    const node = createNode(makeNewNode({ eventDate: null }));
    const found = getNode(node.id);
    expect(found).not.toBeNull();
    expect(found!.eventDate).toBeNull();
  });

  test("updateNode updates eventDate", () => {
    const node = createNode(makeNewNode({ eventDate: null }));
    const newEventDate = Date.now() - 86400000;
    updateNode(node.id, { eventDate: newEventDate });
    const updated = getNode(node.id);
    expect(updated!.eventDate).toBe(newEventDate);
  });

  test("updateNode can set eventDate to null", () => {
    const eventDate = Date.now() - 86400000;
    const node = createNode(makeNewNode({ eventDate }));
    updateNode(node.id, { eventDate: null });
    const updated = getNode(node.id);
    expect(updated!.eventDate).toBeNull();
  });

  test("deleteNode soft-deletes the node by setting fidelity to gone", () => {
    const node = createNode(makeNewNode());
    deleteNode(node.id);
    const deleted = getNode(node.id);
    expect(deleted).not.toBeNull();
    expect(deleted!.fidelity).toBe("gone");
  });
});

// ---------------------------------------------------------------------------
// Node queries
// ---------------------------------------------------------------------------

describe("queryNodes", () => {
  test("filters by scopeId", () => {
    createNode(makeNewNode({ scopeId: "scope-a", content: "A." }));
    createNode(makeNewNode({ scopeId: "scope-b", content: "B." }));

    const results = queryNodes({ scopeId: "scope-a" });
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("A.");
  });

  test("filters by type", () => {
    createNode(makeNewNode({ type: "episodic", content: "Ep." }));
    createNode(makeNewNode({ type: "semantic", content: "Sem." }));
    createNode(makeNewNode({ type: "emotional", content: "Em." }));

    const results = queryNodes({ types: ["semantic", "emotional"] });
    expect(results).toHaveLength(2);
  });

  test("excludes fidelity levels", () => {
    createNode(makeNewNode({ fidelity: "vivid", content: "Vivid." }));
    createNode(makeNewNode({ fidelity: "gone", content: "Gone." }));

    const results = queryNodes({ fidelityNot: ["gone"] });
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("Vivid.");
  });

  test("filters by minimum significance", () => {
    createNode(makeNewNode({ significance: 0.3, content: "Low." }));
    createNode(makeNewNode({ significance: 0.7, content: "High." }));

    const results = queryNodes({ minSignificance: 0.5 });
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("High.");
  });

  test("respects limit", () => {
    for (let i = 0; i < 5; i++) {
      createNode(makeNewNode({ content: `Node ${i}.` }));
    }
    const results = queryNodes({ limit: 3 });
    expect(results).toHaveLength(3);
  });

  test("orders by significance descending", () => {
    createNode(makeNewNode({ significance: 0.3 }));
    createNode(makeNewNode({ significance: 0.9 }));
    createNode(makeNewNode({ significance: 0.6 }));

    const results = queryNodes({});
    expect(results[0].significance).toBe(0.9);
    expect(results[1].significance).toBe(0.6);
    expect(results[2].significance).toBe(0.3);
  });

  test("filters by hasEventDate", () => {
    createNode(makeNewNode({ content: "Dated.", eventDate: 1700000000000 }));
    createNode(makeNewNode({ content: "Undated.", eventDate: null }));

    const results = queryNodes({ hasEventDate: true });
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("Dated.");
  });

  test("filters by eventDateAfter", () => {
    createNode(makeNewNode({ content: "Old.", eventDate: 1700000000000 }));
    createNode(makeNewNode({ content: "Recent.", eventDate: 1710000000000 }));
    createNode(makeNewNode({ content: "None.", eventDate: null }));

    const results = queryNodes({ eventDateAfter: 1705000000000 });
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("Recent.");
  });

  test("filters by eventDateBefore", () => {
    createNode(makeNewNode({ content: "Old.", eventDate: 1700000000000 }));
    createNode(makeNewNode({ content: "Recent.", eventDate: 1710000000000 }));
    createNode(makeNewNode({ content: "None.", eventDate: null }));

    const results = queryNodes({ eventDateBefore: 1705000000000 });
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("Old.");
  });

  test("combines eventDateAfter and eventDateBefore for range query", () => {
    createNode(makeNewNode({ content: "Before.", eventDate: 1690000000000 }));
    createNode(makeNewNode({ content: "In range.", eventDate: 1700000000000 }));
    createNode(makeNewNode({ content: "After.", eventDate: 1720000000000 }));

    const results = queryNodes({
      eventDateAfter: 1695000000000,
      eventDateBefore: 1710000000000,
    });
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("In range.");
  });
});

describe("countNodes", () => {
  test("counts non-gone nodes in a scope", () => {
    createNode(makeNewNode({ scopeId: "s1", fidelity: "vivid" }));
    createNode(makeNewNode({ scopeId: "s1", fidelity: "clear" }));
    createNode(makeNewNode({ scopeId: "s1", fidelity: "gone" }));
    createNode(makeNewNode({ scopeId: "s2", fidelity: "vivid" }));

    expect(countNodes("s1")).toBe(2);
    expect(countNodes("s2")).toBe(1);
    expect(countNodes("s3")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Edge CRUD
// ---------------------------------------------------------------------------

describe("edge CRUD", () => {
  test("createEdge assigns an ID and returns the full edge", () => {
    const a = createNode(makeNewNode());
    const b = createNode(makeNewNode());
    const edge = createEdge({
      sourceNodeId: a.id,
      targetNodeId: b.id,
      relationship: "caused-by",
      weight: 0.8,
      created: Date.now(),
    });
    expect(edge.id).toBeTruthy();
    expect(edge.sourceNodeId).toBe(a.id);
    expect(edge.targetNodeId).toBe(b.id);
    expect(edge.relationship).toBe("caused-by");
    expect(edge.weight).toBe(0.8);
  });

  test("getEdgesForNode returns all edges (both directions)", () => {
    const a = createNode(makeNewNode());
    const b = createNode(makeNewNode());
    const c = createNode(makeNewNode());
    createEdge({
      sourceNodeId: a.id,
      targetNodeId: b.id,
      relationship: "reminds-of",
      weight: 1.0,
      created: Date.now(),
    });
    createEdge({
      sourceNodeId: c.id,
      targetNodeId: a.id,
      relationship: "part-of",
      weight: 0.5,
      created: Date.now(),
    });

    const edges = getEdgesForNode(a.id);
    expect(edges).toHaveLength(2);
  });

  test("getEdgesForNode with outgoing direction", () => {
    const a = createNode(makeNewNode());
    const b = createNode(makeNewNode());
    createEdge({
      sourceNodeId: a.id,
      targetNodeId: b.id,
      relationship: "reminds-of",
      weight: 1.0,
      created: Date.now(),
    });
    createEdge({
      sourceNodeId: b.id,
      targetNodeId: a.id,
      relationship: "caused-by",
      weight: 1.0,
      created: Date.now(),
    });

    const outgoing = getEdgesForNode(a.id, "outgoing");
    expect(outgoing).toHaveLength(1);
    expect(outgoing[0].targetNodeId).toBe(b.id);
  });

  test("getEdgesForNode with incoming direction", () => {
    const a = createNode(makeNewNode());
    const b = createNode(makeNewNode());
    createEdge({
      sourceNodeId: b.id,
      targetNodeId: a.id,
      relationship: "caused-by",
      weight: 1.0,
      created: Date.now(),
    });

    const incoming = getEdgesForNode(a.id, "incoming");
    expect(incoming).toHaveLength(1);
    expect(incoming[0].sourceNodeId).toBe(b.id);
  });

  test("deleteEdge removes the edge", () => {
    const a = createNode(makeNewNode());
    const b = createNode(makeNewNode());
    const edge = createEdge({
      sourceNodeId: a.id,
      targetNodeId: b.id,
      relationship: "reminds-of",
      weight: 1.0,
      created: Date.now(),
    });
    deleteEdge(edge.id);
    expect(getEdgesForNode(a.id)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Trigger CRUD
// ---------------------------------------------------------------------------

describe("trigger CRUD", () => {
  test("createTrigger assigns an ID and returns the full trigger", () => {
    const node = createNode(makeNewNode());
    const trigger = createTrigger({
      nodeId: node.id,
      type: "temporal",
      schedule: "day-of-week:monday",
      condition: null,
      conditionEmbedding: null,
      threshold: null,
      eventDate: null,
      rampDays: null,
      followUpDays: null,
      recurring: true,
      consumed: false,
      cooldownMs: 1000 * 60 * 60 * 12,
      lastFired: null,
    });
    expect(trigger.id).toBeTruthy();
    expect(trigger.type).toBe("temporal");
    expect(trigger.schedule).toBe("day-of-week:monday");
    expect(trigger.recurring).toBe(true);
  });

  test("getTriggersForNode returns triggers for a given node", () => {
    const node = createNode(makeNewNode());
    createTrigger({
      nodeId: node.id,
      type: "temporal",
      schedule: "time:morning",
      condition: null,
      conditionEmbedding: null,
      threshold: null,
      eventDate: null,
      rampDays: null,
      followUpDays: null,
      recurring: false,
      consumed: false,
      cooldownMs: null,
      lastFired: null,
    });
    createTrigger({
      nodeId: node.id,
      type: "semantic",
      schedule: null,
      condition: "cooking topic",
      conditionEmbedding: null,
      threshold: 0.7,
      eventDate: null,
      rampDays: null,
      followUpDays: null,
      recurring: false,
      consumed: false,
      cooldownMs: null,
      lastFired: null,
    });

    const triggers = getTriggersForNode(node.id);
    expect(triggers).toHaveLength(2);
  });

  test("updateTrigger modifies consumed and lastFired", () => {
    const node = createNode(makeNewNode());
    const trigger = createTrigger({
      nodeId: node.id,
      type: "temporal",
      schedule: "date:04-08",
      condition: null,
      conditionEmbedding: null,
      threshold: null,
      eventDate: null,
      rampDays: null,
      followUpDays: null,
      recurring: false,
      consumed: false,
      cooldownMs: null,
      lastFired: null,
    });

    const now = Date.now();
    updateTrigger(trigger.id, { consumed: true, lastFired: now });

    const updated = getTriggersForNode(node.id);
    expect(updated[0].consumed).toBe(true);
    expect(updated[0].lastFired).toBe(now);
  });

  test("getActiveTriggersByType returns only non-consumed triggers", () => {
    const node = createNode(makeNewNode());
    createTrigger({
      nodeId: node.id,
      type: "temporal",
      schedule: "time:morning",
      condition: null,
      conditionEmbedding: null,
      threshold: null,
      eventDate: null,
      rampDays: null,
      followUpDays: null,
      recurring: false,
      consumed: false,
      cooldownMs: null,
      lastFired: null,
    });
    createTrigger({
      nodeId: node.id,
      type: "temporal",
      schedule: "time:evening",
      condition: null,
      conditionEmbedding: null,
      threshold: null,
      eventDate: null,
      rampDays: null,
      followUpDays: null,
      recurring: false,
      consumed: true,
      cooldownMs: null,
      lastFired: null,
    });

    const active = getActiveTriggersByType("temporal");
    expect(active).toHaveLength(1);
    expect(active[0].schedule).toBe("time:morning");
  });

  test("getActiveTriggersByType filters by scope when provided", () => {
    const nodeA = createNode(makeNewNode({ scopeId: "scope-a" }));
    const nodeB = createNode(makeNewNode({ scopeId: "scope-b" }));
    createTrigger({
      nodeId: nodeA.id,
      type: "temporal",
      schedule: "time:morning",
      condition: null,
      conditionEmbedding: null,
      threshold: null,
      eventDate: null,
      rampDays: null,
      followUpDays: null,
      recurring: false,
      consumed: false,
      cooldownMs: null,
      lastFired: null,
    });
    createTrigger({
      nodeId: nodeB.id,
      type: "temporal",
      schedule: "time:evening",
      condition: null,
      conditionEmbedding: null,
      threshold: null,
      eventDate: null,
      rampDays: null,
      followUpDays: null,
      recurring: false,
      consumed: false,
      cooldownMs: null,
      lastFired: null,
    });

    const scopeA = getActiveTriggersByType("temporal", "scope-a");
    expect(scopeA).toHaveLength(1);
    expect(scopeA[0].schedule).toBe("time:morning");
  });
});

// ---------------------------------------------------------------------------
// Reinforcement
// ---------------------------------------------------------------------------

describe("reinforceNode", () => {
  test("increments reinforcementCount", () => {
    const node = createNode(
      makeNewNode({ reinforcementCount: 0, stability: 14, significance: 0.5 }),
    );
    reinforceNode(node.id);
    const updated = getNode(node.id)!;
    expect(updated.reinforcementCount).toBe(1);
  });

  test("multiplies stability by 1.5", () => {
    const node = createNode(makeNewNode({ stability: 14 }));
    reinforceNode(node.id);
    const updated = getNode(node.id)!;
    expect(updated.stability).toBeCloseTo(21, 5); // 14 × 1.5
  });

  test("boosts significance by 10%, capped at 1.0", () => {
    const node = createNode(makeNewNode({ significance: 0.5 }));
    reinforceNode(node.id);
    const updated = getNode(node.id)!;
    expect(updated.significance).toBeCloseTo(0.55, 5); // 0.5 × 1.1
  });

  test("significance does not exceed 1.0", () => {
    const node = createNode(makeNewNode({ significance: 0.95 }));
    reinforceNode(node.id);
    const updated = getNode(node.id)!;
    expect(updated.significance).toBeLessThanOrEqual(1.0);
  });

  test("updates lastReinforced timestamp", () => {
    const oldTime = Date.now() - 10000;
    const node = createNode(makeNewNode({ lastReinforced: oldTime }));
    reinforceNode(node.id);
    const updated = getNode(node.id)!;
    expect(updated.lastReinforced).toBeGreaterThan(oldTime);
  });

  test("multiple reinforcements compound stability", () => {
    const node = createNode(makeNewNode({ stability: 14 }));
    reinforceNode(node.id);
    reinforceNode(node.id);
    reinforceNode(node.id);
    const updated = getNode(node.id)!;
    expect(updated.reinforcementCount).toBe(3);
    // 14 × 1.5^3 = 47.25
    expect(updated.stability).toBeCloseTo(47.25, 1);
  });
});

// ---------------------------------------------------------------------------
// Supersession
// ---------------------------------------------------------------------------

describe("supersedeNode", () => {
  test("creates new node with inherited durability", () => {
    const old = createNode(
      makeNewNode({
        content: "Old fact.",
        stability: 50,
        reinforcementCount: 5,
        significance: 0.9,
      }),
    );
    const newNodeInput = makeNewNode({
      content: "Updated fact.",
      stability: 14,
      reinforcementCount: 0,
      significance: 0.5,
    });

    const { newNode, oldNode } = supersedeNode(old.id, newNodeInput);

    expect(newNode.content).toBe("Updated fact.");
    // Inherits max of each durability metric
    expect(newNode.stability).toBe(50); // max(14, 50)
    expect(newNode.reinforcementCount).toBe(5); // max(0, 5)
    expect(newNode.significance).toBe(0.9); // max(0.5, 0.9)
    expect(oldNode).not.toBeNull();
    expect(oldNode!.id).toBe(old.id);
  });

  test("creates a supersedes edge between new and old node", () => {
    const old = createNode(makeNewNode({ content: "Old." }));
    const { newNode } = supersedeNode(old.id, makeNewNode({ content: "New." }));

    const edges = getEdgesForNode(newNode.id, "outgoing");
    expect(edges).toHaveLength(1);
    expect(edges[0].relationship).toBe("supersedes");
    expect(edges[0].targetNodeId).toBe(old.id);
    expect(edges[0].weight).toBe(1.0);
  });

  test("inherits eventDate from old node when new node has null eventDate", () => {
    const eventDate = 1712534400000; // April 8 2024
    const old = createNode(
      makeNewNode({ content: "Dentist April 8.", eventDate }),
    );
    const newNodeInput = makeNewNode({
      content: "Dentist appointment rescheduled.",
      eventDate: null,
    });

    const { newNode } = supersedeNode(old.id, newNodeInput);

    expect(newNode.eventDate).toBe(eventDate);
  });

  test("uses new node eventDate when both nodes have eventDate", () => {
    const old = createNode(
      makeNewNode({ content: "Flight Tuesday.", eventDate: 1712534400000 }),
    );
    const newEventDate = 1712620800000;
    const newNodeInput = makeNewNode({
      content: "Flight moved to Thursday.",
      eventDate: newEventDate,
    });

    const { newNode } = supersedeNode(old.id, newNodeInput);

    expect(newNode.eventDate).toBe(newEventDate);
  });

  test("handles non-existent old node by just creating new node", () => {
    const { newNode, oldNode } = supersedeNode(
      "non-existent",
      makeNewNode({ content: "Brand new." }),
    );
    expect(newNode.content).toBe("Brand new.");
    expect(oldNode).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// applyDiff
// ---------------------------------------------------------------------------

describe("applyDiff", () => {
  test("creates nodes and returns counts", () => {
    const result = applyDiff({
      createNodes: [
        makeNewNode({ content: "Node 1." }),
        makeNewNode({ content: "Node 2." }),
      ],
      updateNodes: [],
      deleteNodeIds: [],
      createEdges: [],
      deleteEdgeIds: [],
      createTriggers: [],
      deleteTriggerIds: [],
      reinforceNodeIds: [],
    });

    expect(result.nodesCreated).toBe(2);
    expect(result.createdNodeIds).toHaveLength(2);
  });

  test("deletes nodes", () => {
    const node = createNode(makeNewNode());
    const result = applyDiff({
      createNodes: [],
      updateNodes: [],
      deleteNodeIds: [node.id],
      createEdges: [],
      deleteEdgeIds: [],
      createTriggers: [],
      deleteTriggerIds: [],
      reinforceNodeIds: [],
    });
    expect(result.nodesDeleted).toBe(1);
    const deleted = getNode(node.id);
    expect(deleted).not.toBeNull();
    expect(deleted!.fidelity).toBe("gone");
  });

  test("updates nodes", () => {
    const node = createNode(makeNewNode({ content: "Before." }));
    const result = applyDiff({
      createNodes: [],
      updateNodes: [{ id: node.id, changes: { content: "After." } }],
      deleteNodeIds: [],
      createEdges: [],
      deleteEdgeIds: [],
      createTriggers: [],
      deleteTriggerIds: [],
      reinforceNodeIds: [],
    });
    expect(result.nodesUpdated).toBe(1);
    expect(getNode(node.id)!.content).toBe("After.");
  });

  test("reinforces nodes", () => {
    const node = createNode(makeNewNode({ reinforcementCount: 0 }));
    const result = applyDiff({
      createNodes: [],
      updateNodes: [],
      deleteNodeIds: [],
      createEdges: [],
      deleteEdgeIds: [],
      createTriggers: [],
      deleteTriggerIds: [],
      reinforceNodeIds: [node.id],
    });
    expect(result.nodesReinforced).toBe(1);
    expect(getNode(node.id)!.reinforcementCount).toBe(1);
  });

  test("creates and deletes edges", () => {
    const a = createNode(makeNewNode());
    const b = createNode(makeNewNode());
    const existingEdge = createEdge({
      sourceNodeId: a.id,
      targetNodeId: b.id,
      relationship: "reminds-of",
      weight: 1.0,
      created: Date.now(),
    });

    const result = applyDiff({
      createNodes: [],
      updateNodes: [],
      deleteNodeIds: [],
      createEdges: [
        {
          sourceNodeId: b.id,
          targetNodeId: a.id,
          relationship: "caused-by",
          weight: 0.5,
          created: Date.now(),
        },
      ],
      deleteEdgeIds: [existingEdge.id],
      createTriggers: [],
      deleteTriggerIds: [],
      reinforceNodeIds: [],
    });
    expect(result.edgesCreated).toBe(1);
    expect(result.edgesDeleted).toBe(1);
  });

  test("creates and deletes triggers", () => {
    const node = createNode(makeNewNode());
    const existingTrigger = createTrigger({
      nodeId: node.id,
      type: "temporal",
      schedule: "time:morning",
      condition: null,
      conditionEmbedding: null,
      threshold: null,
      eventDate: null,
      rampDays: null,
      followUpDays: null,
      recurring: false,
      consumed: false,
      cooldownMs: null,
      lastFired: null,
    });

    const result = applyDiff({
      createNodes: [],
      updateNodes: [],
      deleteNodeIds: [],
      createEdges: [],
      deleteEdgeIds: [],
      createTriggers: [
        {
          nodeId: node.id,
          type: "semantic",
          schedule: null,
          condition: "test",
          conditionEmbedding: null,
          threshold: 0.7,
          eventDate: null,
          rampDays: null,
          followUpDays: null,
          recurring: false,
          consumed: false,
          cooldownMs: null,
          lastFired: null,
        },
      ],
      deleteTriggerIds: [existingTrigger.id],
      reinforceNodeIds: [],
    });
    expect(result.triggersCreated).toBe(1);
    expect(result.triggersDeleted).toBe(1);
    const remaining = getTriggersForNode(node.id);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].type).toBe("semantic");
  });

  test("applies all operations atomically", () => {
    // Verify all operations are in the same transaction by creating
    // a complex diff and checking the result counts.
    const existingNode = createNode(makeNewNode({ content: "Existing." }));

    const result = applyDiff({
      createNodes: [makeNewNode({ content: "New 1." })],
      updateNodes: [{ id: existingNode.id, changes: { content: "Updated." } }],
      deleteNodeIds: [],
      createEdges: [],
      deleteEdgeIds: [],
      createTriggers: [],
      deleteTriggerIds: [],
      reinforceNodeIds: [existingNode.id],
    });

    expect(result.nodesCreated).toBe(1);
    expect(result.nodesUpdated).toBe(1);
    expect(result.nodesReinforced).toBe(1);
    expect(getNode(existingNode.id)!.content).toBe("Updated.");
    expect(getNode(existingNode.id)!.reinforcementCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// deleteTrigger
// ---------------------------------------------------------------------------

describe("deleteTrigger", () => {
  test("removes a trigger by ID", () => {
    const node = createNode(makeNewNode());
    const trigger = createTrigger({
      nodeId: node.id,
      type: "event",
      schedule: null,
      condition: null,
      conditionEmbedding: null,
      threshold: null,
      eventDate: Date.now(),
      rampDays: 7,
      followUpDays: 2,
      recurring: false,
      consumed: false,
      cooldownMs: null,
      lastFired: null,
    });
    deleteTrigger(trigger.id);
    expect(getTriggersForNode(node.id)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// updateNode — event trigger sync
// ---------------------------------------------------------------------------

describe("updateNode event trigger sync", () => {
  test("syncs event trigger eventDate when node eventDate is updated", () => {
    const originalDate = 1712534400000;
    const newDate = 1712620800000;
    const node = createNode(makeNewNode({ eventDate: originalDate }));
    createTrigger({
      nodeId: node.id,
      type: "event",
      schedule: null,
      condition: null,
      conditionEmbedding: null,
      threshold: null,
      eventDate: originalDate,
      rampDays: 7,
      followUpDays: 2,
      recurring: false,
      consumed: false,
      cooldownMs: null,
      lastFired: null,
    });

    updateNode(node.id, { eventDate: newDate });

    const triggers = getTriggersForNode(node.id);
    expect(triggers).toHaveLength(1);
    expect(triggers[0].eventDate).toBe(newDate);
  });

  test("deletes event trigger when node eventDate is cleared to null", () => {
    const eventDate = 1712534400000;
    const node = createNode(makeNewNode({ eventDate }));
    createTrigger({
      nodeId: node.id,
      type: "event",
      schedule: null,
      condition: null,
      conditionEmbedding: null,
      threshold: null,
      eventDate,
      rampDays: 7,
      followUpDays: 2,
      recurring: false,
      consumed: false,
      cooldownMs: null,
      lastFired: null,
    });

    updateNode(node.id, { eventDate: null });

    const triggers = getTriggersForNode(node.id);
    expect(triggers).toHaveLength(0);
  });

  test("does not affect non-event triggers when eventDate changes", () => {
    const node = createNode(makeNewNode({ eventDate: 1712534400000 }));
    createTrigger({
      nodeId: node.id,
      type: "event",
      schedule: null,
      condition: null,
      conditionEmbedding: null,
      threshold: null,
      eventDate: 1712534400000,
      rampDays: 7,
      followUpDays: 2,
      recurring: false,
      consumed: false,
      cooldownMs: null,
      lastFired: null,
    });
    createTrigger({
      nodeId: node.id,
      type: "semantic",
      schedule: null,
      condition: "cooking topic",
      conditionEmbedding: null,
      threshold: 0.7,
      eventDate: null,
      rampDays: null,
      followUpDays: null,
      recurring: false,
      consumed: false,
      cooldownMs: null,
      lastFired: null,
    });

    updateNode(node.id, { eventDate: null });

    const triggers = getTriggersForNode(node.id);
    expect(triggers).toHaveLength(1);
    expect(triggers[0].type).toBe("semantic");
  });

  test("does not touch triggers when eventDate is not in changes", () => {
    const eventDate = 1712534400000;
    const node = createNode(makeNewNode({ eventDate }));
    createTrigger({
      nodeId: node.id,
      type: "event",
      schedule: null,
      condition: null,
      conditionEmbedding: null,
      threshold: null,
      eventDate,
      rampDays: 7,
      followUpDays: 2,
      recurring: false,
      consumed: false,
      cooldownMs: null,
      lastFired: null,
    });

    // Update something other than eventDate
    updateNode(node.id, { content: "Updated content." });

    const triggers = getTriggersForNode(node.id);
    expect(triggers).toHaveLength(1);
    expect(triggers[0].eventDate).toBe(eventDate);
  });
});

// ---------------------------------------------------------------------------
// Paragraph deduplication
// ---------------------------------------------------------------------------

describe("deduplicateParagraphs", () => {
  test("content with no duplicates passes through unchanged", () => {
    const input = "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.";
    expect(deduplicateParagraphs(input)).toBe(input);
  });

  test("two identical paragraphs separated by \\n\\n collapses to one", () => {
    const input = "Hello world.\n\nHello world.";
    expect(deduplicateParagraphs(input)).toBe("Hello world.");
  });

  test("paragraphs that differ only in trailing whitespace are treated as duplicates", () => {
    const input = "Hello world.  \n\nHello world.";
    expect(deduplicateParagraphs(input)).toBe("Hello world.  ");
  });

  test("bullet lists with repeated items are deduped", () => {
    const input = "- item one\n- item two\n- item one\n- item three";
    expect(deduplicateParagraphs(input)).toBe(
      "- item one\n- item two\n- item three",
    );
  });

  test("empty content returns empty string", () => {
    expect(deduplicateParagraphs("")).toBe("");
  });

  test("multiple duplicate paragraphs with different content", () => {
    const input = "Alpha.\n\nBeta.\n\nAlpha.\n\nGamma.\n\nBeta.";
    expect(deduplicateParagraphs(input)).toBe("Alpha.\n\nBeta.\n\nGamma.");
  });

  test("bullet dedup within a paragraph preserves non-bullet lines", () => {
    const input = "Header:\n- item A\n- item B\n- item A";
    expect(deduplicateParagraphs(input)).toBe("Header:\n- item A\n- item B");
  });

  test("paragraphs differing only in internal whitespace are treated as duplicates", () => {
    const input = "hello   world\n\nhello world";
    expect(deduplicateParagraphs(input)).toBe("hello   world");
  });
});
