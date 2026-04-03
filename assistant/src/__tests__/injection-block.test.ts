import { describe, expect, test } from "bun:test";

import {
  assembleContextBlock,
  assembleInjectionBlock,
} from "../memory/graph/injection.js";
import type { MemoryNode, ScoredNode } from "../memory/graph/types.js";

function makeScoredNode(
  overrides: Partial<MemoryNode> & { content: string },
): ScoredNode {
  return {
    node: {
      id: "test-id",
      content: overrides.content,
      type: overrides.type ?? "episodic",
      created: overrides.created ?? Date.now() - 3 * 24 * 60 * 60 * 1000,
      lastAccessed: overrides.lastAccessed ?? Date.now(),
      lastConsolidated: overrides.lastConsolidated ?? Date.now(),
      eventDate: overrides.eventDate ?? null,
      emotionalCharge: overrides.emotionalCharge ?? {
        valence: 0,
        intensity: 0,
        decayCurve: "linear",
        decayRate: 0,
        originalIntensity: 0,
      },
      fidelity: overrides.fidelity ?? "clear",
      confidence: overrides.confidence ?? 1,
      significance: overrides.significance ?? 0.5,
      stability: overrides.stability ?? 1,
      reinforcementCount: overrides.reinforcementCount ?? 0,
      lastReinforced: overrides.lastReinforced ?? Date.now(),
      sourceConversations: overrides.sourceConversations ?? [],
      sourceType: overrides.sourceType ?? "direct",
      narrativeRole: overrides.narrativeRole ?? null,
      partOfStory: overrides.partOfStory ?? null,
      imageRefs: overrides.imageRefs ?? null,
      scopeId: overrides.scopeId ?? "default",
    },
    score: 0.8,
    scoreBreakdown: {
      semanticSimilarity: 0.5,
      effectiveSignificance: 0.5,
      emotionalIntensity: 0,
      temporalBoost: 0,
      recencyBoost: 0,
      triggerBoost: 0,
      activationBoost: 0,
    },
  };
}

describe("assembleInjectionBlock", () => {
  test("returns empty string for empty array", () => {
    expect(assembleInjectionBlock([])).toBe("");
  });

  test("uses creation age format for nodes without eventDate", () => {
    const node = makeScoredNode({ content: "Regular memory node" });
    const result = assembleInjectionBlock([node]);
    // Should show relative age like "(3d ago)"
    expect(result).toMatch(/^\- \(\d+[dhm]o? ago\) Regular memory node$/);
  });

  test("uses event date format for nodes with eventDate", () => {
    // Set eventDate to 5 days from now
    const futureDate = Date.now() + 5 * 24 * 60 * 60 * 1000;
    const node = makeScoredNode({
      content: "Flight to NYC",
      eventDate: futureDate,
    });
    const result = assembleInjectionBlock([node]);
    // Should show event date like "Tue Apr 8, 6:00 PM (in 5d) — Flight to NYC"
    expect(result).toContain("Flight to NYC");
    expect(result).toMatch(/\(in \d+d\)/);
    // Should NOT contain the age-based format
    expect(result).not.toMatch(/\(\d+[dhm]o? ago\)/);
  });

  test("mixes both formats when nodes have mixed eventDate presence", () => {
    const regularNode = makeScoredNode({
      id: "regular",
      content: "Had coffee with friend",
    } as Partial<MemoryNode> & { content: string });
    const eventNode = makeScoredNode({
      id: "event",
      content: "Dentist appointment",
      eventDate: Date.now() + 2 * 24 * 60 * 60 * 1000,
    } as Partial<MemoryNode> & { content: string });

    const result = assembleInjectionBlock([regularNode, eventNode]);
    const lines = result.split("\n");

    expect(lines).toHaveLength(2);
    // First line: regular node with age format
    expect(lines[0]).toMatch(/\(\d+[dhm]o? ago\) Had coffee with friend/);
    // Second line: event node with event date format
    expect(lines[1]).toContain("Dentist appointment");
    expect(lines[1]).toMatch(/\(in \d+d\)/);
  });

  test("uses event date format for past event-dated nodes", () => {
    // Set eventDate to 3 days ago (past event)
    const pastDate = Date.now() - 3 * 24 * 60 * 60 * 1000;
    const node = makeScoredNode({
      content: "Team standup",
      eventDate: pastDate,
    });
    const result = assembleInjectionBlock([node]);
    // Should show event date format with past indicator, not creation age
    expect(result).toContain("Team standup");
    expect(result).toMatch(/\(\d+d ago\)/);
    // The line should use the event date format (date — content) not age format ((age) content)
    expect(result).toContain(" — Team standup");
  });

  test("assembleInjectionBlock formats procedural nodes with [skill] prefix", () => {
    const node = makeScoredNode({
      type: "procedural",
      content:
        'skill:telegram-setup\nThe "Telegram Setup" skill (telegram-setup) is available.',
    });
    const result = assembleInjectionBlock([node]);
    expect(result).toContain("[skill]");
    expect(result).toContain("→ use skill_load to activate");
  });

  test("assembleInjectionBlock omits skill_load suffix for CLI commands", () => {
    const node = makeScoredNode({
      type: "procedural",
      content:
        'cli:bash\nThe "assistant bash" CLI command is available. Execute a shell command.',
    });
    const result = assembleInjectionBlock([node]);
    expect(result).not.toContain("[skill]");
    expect(result).not.toContain("skill_load to activate");
    expect(result).toContain("CLI command is available");
  });
});

describe("assembleContextBlock — procedural nodes", () => {
  test("puts procedural nodes under Skills You Can Use", () => {
    const node = makeScoredNode({
      type: "procedural",
      content:
        'skill:telegram-setup\nThe "Telegram Setup" skill (telegram-setup) is available.',
    });
    const result = assembleContextBlock([node]);
    expect(result).toContain("### Skills You Can Use");
    expect(result).toContain("use skill_load to activate");
  });

  test("omits skill_load suffix for CLI commands", () => {
    const node = makeScoredNode({
      type: "procedural",
      content:
        'cli:bash\nThe "assistant bash" CLI command is available. Execute a shell command.',
    });
    const result = assembleContextBlock([node]);
    expect(result).toContain("### Skills You Can Use");
    expect(result).not.toContain("skill_load to activate");
    expect(result).toContain("CLI command is available");
  });

  test("strips skill: prefix from old-format content", () => {
    const node = makeScoredNode({
      type: "procedural",
      content:
        'skill:telegram-setup\nThe "Telegram Setup" skill (telegram-setup) is available.',
    });
    const result = assembleContextBlock([node]);
    // The "skill:telegram-setup" prefix line should be stripped from the rendered output
    expect(result).not.toContain("skill:telegram-setup\n");
    // But the skill name in the description should remain
    expect(result).toContain('The "Telegram Setup" skill');
  });
});
