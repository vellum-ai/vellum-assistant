import { describe, expect, test } from "bun:test";

import { capabilityKind, type MemoryNode } from "./types.js";

function makeNode(overrides: Partial<MemoryNode> = {}): MemoryNode {
  return {
    id: "node-1",
    content: "Test memory",
    type: "procedural",
    created: 0,
    lastAccessed: 0,
    lastConsolidated: 0,
    eventDate: null,
    emotionalCharge: {
      valence: 0,
      intensity: 0,
      decayCurve: "linear",
      decayRate: 0.05,
      originalIntensity: 0,
    },
    fidelity: "vivid",
    confidence: 0.8,
    significance: 0.6,
    stability: 14,
    reinforcementCount: 0,
    lastReinforced: 0,
    sourceConversations: [],
    sourceType: "direct",
    narrativeRole: null,
    partOfStory: null,
    imageRefs: null,
    ...overrides,
  };
}

describe("capabilityKind", () => {
  test("classifies a skill node by its source key", () => {
    const node = makeNode({
      content: 'The "PDF" skill (pdf) is available.',
      sourceConversations: ["capability:skill:pdf"],
    });
    expect(capabilityKind(node)).toBe("skill");
  });

  test("classifies a CLI node by its source key", () => {
    const node = makeNode({
      content: 'The "assistant status" CLI command is available.',
      sourceConversations: ["capability:cli:status"],
    });
    expect(capabilityKind(node)).toBe("cli");
  });

  test("falls back to content shape when the source key is absent", () => {
    expect(
      capabilityKind(
        makeNode({ content: 'The "Docx" skill (docx) is available.' }),
      ),
    ).toBe("skill");
    expect(
      capabilityKind(
        makeNode({ content: 'The "assistant ps" CLI command is available.' }),
      ),
    ).toBe("cli");
  });

  test("recognizes the legacy content prefixes", () => {
    expect(capabilityKind(makeNode({ content: "skill:pdf\n..." }))).toBe(
      "skill",
    );
    expect(capabilityKind(makeNode({ content: "cli:status\n..." }))).toBe(
      "cli",
    );
  });

  test("returns null for an organic procedural memory", () => {
    const node = makeNode({
      content: "FFmpeg needs -ac 2 for stereo output",
      sourceConversations: ["conv-42"],
    });
    expect(capabilityKind(node)).toBeNull();
  });

  test("returns null for a non-procedural node even with a capability key", () => {
    const node = makeNode({
      type: "semantic",
      content: 'The "PDF" skill (pdf) is available.',
      sourceConversations: ["capability:skill:pdf"],
    });
    expect(capabilityKind(node)).toBeNull();
  });
});
