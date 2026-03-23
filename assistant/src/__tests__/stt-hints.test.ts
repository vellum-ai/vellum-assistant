import { describe, expect, test } from "bun:test";

import { buildSttHints, type SttHintsInput } from "../calls/stt-hints.js";

function emptyInput(): SttHintsInput {
  return {
    staticHints: [],
    assistantName: null,
    guardianName: null,
    taskDescription: null,
    targetContactName: null,
    inviteFriendName: null,
    inviteGuardianName: null,
    recentContactNames: [],
  };
}

describe("buildSttHints", () => {
  test("empty inputs produce empty string", () => {
    expect(buildSttHints(emptyInput())).toBe("");
  });

  test("static hints included verbatim", () => {
    const input = emptyInput();
    input.staticHints = ["Vellum", "Acme"];
    expect(buildSttHints(input)).toBe("Vellum,Acme");
  });

  test("assistant name included", () => {
    const input = emptyInput();
    input.assistantName = "Velissa";
    expect(buildSttHints(input)).toBe("Velissa");
  });

  test("guardian name included", () => {
    const input = emptyInput();
    input.guardianName = "Sidd";
    expect(buildSttHints(input)).toBe("Sidd");
  });

  test('default guardian name "my human" excluded', () => {
    const input = emptyInput();
    input.guardianName = "my human";
    expect(buildSttHints(input)).toBe("");
  });

  test("guardian name with whitespace around default sentinel excluded", () => {
    const input = emptyInput();
    input.guardianName = "  my human  ";
    expect(buildSttHints(input)).toBe("");
  });

  test("invite friend name included", () => {
    const input = emptyInput();
    input.inviteFriendName = "Alice";
    expect(buildSttHints(input)).toBe("Alice");
  });

  test("invite guardian name included", () => {
    const input = emptyInput();
    input.inviteGuardianName = "Bob";
    expect(buildSttHints(input)).toBe("Bob");
  });

  test("target contact name included", () => {
    const input = emptyInput();
    input.targetContactName = "Charlie";
    expect(buildSttHints(input)).toBe("Charlie");
  });

  test("recent contact names included", () => {
    const input = emptyInput();
    input.recentContactNames = ["Dave", "Eve"];
    expect(buildSttHints(input)).toBe("Dave,Eve");
  });

  test("proper nouns extracted from task description", () => {
    const input = emptyInput();
    input.taskDescription = "Call John Smith at Acme Corp";
    const result = buildSttHints(input);
    expect(result).toContain("John");
    expect(result).toContain("Smith");
    expect(result).toContain("Acme");
    expect(result).toContain("Corp");
    // "Call" is the first word of the sentence — should not be extracted
    expect(result).not.toContain("Call");
  });

  test("proper nouns extracted across sentence boundaries", () => {
    const input = emptyInput();
    input.taskDescription = "Meet with Alice. Then call Bob! Ask Charlie? Done.";
    const result = buildSttHints(input);
    expect(result).toContain("Alice");
    expect(result).toContain("Bob");
    expect(result).toContain("Charlie");
    // First words of sentences should be excluded
    expect(result).not.toContain("Meet");
    expect(result).not.toContain("Then");
    expect(result).not.toContain("Ask");
    expect(result).not.toContain("Done");
  });

  test("duplicates removed (case-insensitive)", () => {
    const input = emptyInput();
    input.staticHints = ["Vellum", "vellum", "VELLUM"];
    input.recentContactNames = ["Vellum"];
    const result = buildSttHints(input);
    // Should appear only once — the first occurrence is kept
    expect(result).toBe("Vellum");
  });

  test("empty and whitespace-only entries filtered", () => {
    const input = emptyInput();
    input.staticHints = ["", "  ", "Valid", " ", "Also Valid"];
    expect(buildSttHints(input)).toBe("Valid,Also Valid");
  });

  test("entries are trimmed", () => {
    const input = emptyInput();
    input.staticHints = ["  Padded  ", " Spaces "];
    expect(buildSttHints(input)).toBe("Padded,Spaces");
  });

  test("output truncated at MAX_HINTS_LENGTH without partial words", () => {
    const input = emptyInput();
    // Create hints that will exceed 500 chars when joined
    const longHints: string[] = [];
    for (let i = 0; i < 100; i++) {
      longHints.push(`Hint${i}LongWord`);
    }
    input.staticHints = longHints;
    const result = buildSttHints(input);
    expect(result.length).toBeLessThanOrEqual(500);
    // Should not end with a comma (that would indicate a truncation right after a separator)
    expect(result).not.toMatch(/,$/);
    // Every comma-separated part should be a complete hint from our input
    const parts = result.split(",");
    for (const part of parts) {
      expect(input.staticHints).toContain(part);
    }
  });

  test("all sources combined in correct order", () => {
    const input: SttHintsInput = {
      staticHints: ["StaticOne"],
      assistantName: "Velissa",
      guardianName: "Sidd",
      taskDescription: "Call John at Acme",
      targetContactName: "Target",
      inviteFriendName: "Friend",
      inviteGuardianName: "Guardian",
      recentContactNames: ["Recent"],
    };
    const result = buildSttHints(input);
    const parts = result.split(",");
    // Verify all expected hints are present
    expect(parts).toContain("StaticOne");
    expect(parts).toContain("Velissa");
    expect(parts).toContain("Sidd");
    expect(parts).toContain("John");
    expect(parts).toContain("Acme");
    expect(parts).toContain("Target");
    expect(parts).toContain("Friend");
    expect(parts).toContain("Guardian");
    expect(parts).toContain("Recent");
  });

  test("null and empty string names are excluded", () => {
    const input = emptyInput();
    input.assistantName = "";
    input.guardianName = "";
    input.targetContactName = null;
    input.inviteFriendName = null;
    input.inviteGuardianName = null;
    expect(buildSttHints(input)).toBe("");
  });
});
