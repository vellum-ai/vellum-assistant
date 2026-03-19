import { describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks — declared before imports that depend on logger
// ---------------------------------------------------------------------------

function makeLoggerStub(): Record<string, unknown> {
  const stub: Record<string, unknown> = {};
  for (const m of [
    "info",
    "warn",
    "error",
    "debug",
    "trace",
    "fatal",
    "silent",
    "child",
  ]) {
    stub[m] = m === "child" ? () => makeLoggerStub() : () => {};
  }
  return stub;
}

mock.module("../util/logger.js", () => ({
  getLogger: () => makeLoggerStub(),
}));

import { parseReducerOutput } from "../memory/reducer.js";
import { EMPTY_REDUCER_RESULT } from "../memory/reducer-types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Wrap a JS object through JSON.stringify so parseReducerOutput can consume it. */
function toRaw(obj: unknown): string {
  return JSON.stringify(obj);
}

// ---------------------------------------------------------------------------
// Tests: EMPTY_REDUCER_RESULT
// ---------------------------------------------------------------------------

describe("EMPTY_REDUCER_RESULT", () => {
  test("has all four arrays empty", () => {
    expect(EMPTY_REDUCER_RESULT.timeContexts).toEqual([]);
    expect(EMPTY_REDUCER_RESULT.openLoops).toEqual([]);
    expect(EMPTY_REDUCER_RESULT.archiveObservations).toEqual([]);
    expect(EMPTY_REDUCER_RESULT.archiveEpisodes).toEqual([]);
  });

  test("is frozen (immutable)", () => {
    expect(Object.isFrozen(EMPTY_REDUCER_RESULT)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: parseReducerOutput — invalid inputs
// ---------------------------------------------------------------------------

describe("parseReducerOutput — invalid inputs", () => {
  test("returns empty result for non-JSON string", () => {
    expect(parseReducerOutput("not json at all")).toBe(EMPTY_REDUCER_RESULT);
  });

  test("returns empty result for empty string", () => {
    expect(parseReducerOutput("")).toBe(EMPTY_REDUCER_RESULT);
  });

  test("returns empty result for JSON array", () => {
    expect(parseReducerOutput("[]")).toBe(EMPTY_REDUCER_RESULT);
  });

  test("returns empty result for JSON null", () => {
    expect(parseReducerOutput("null")).toBe(EMPTY_REDUCER_RESULT);
  });

  test("returns empty result for JSON number", () => {
    expect(parseReducerOutput("42")).toBe(EMPTY_REDUCER_RESULT);
  });

  test("returns empty result for JSON string", () => {
    expect(parseReducerOutput('"hello"')).toBe(EMPTY_REDUCER_RESULT);
  });

  test("returns empty result for object with no recognized arrays", () => {
    expect(parseReducerOutput(toRaw({ foo: "bar" }))).toBe(
      EMPTY_REDUCER_RESULT,
    );
  });

  test("returns empty result when all recognized keys are not arrays", () => {
    expect(
      parseReducerOutput(
        toRaw({
          timeContexts: "not an array",
          openLoops: 42,
          archiveObservations: null,
          archiveEpisodes: true,
        }),
      ),
    ).toBe(EMPTY_REDUCER_RESULT);
  });
});

// ---------------------------------------------------------------------------
// Tests: parseReducerOutput — valid full output
// ---------------------------------------------------------------------------

describe("parseReducerOutput — valid full output", () => {
  test("parses a complete valid reducer output", () => {
    const raw: Record<string, unknown> = {
      timeContexts: [
        {
          action: "create",
          summary: "User traveling next week",
          source: "conversation",
          activeFrom: 1700000000000,
          activeUntil: 1700604800000,
        },
        {
          action: "update",
          id: "tc-1",
          summary: "Updated travel dates",
        },
        {
          action: "resolve",
          id: "tc-2",
        },
      ],
      openLoops: [
        {
          action: "create",
          summary: "Follow up with Bob",
          source: "conversation",
          dueAt: 1700172800000,
        },
        {
          action: "update",
          id: "ol-1",
          summary: "Bob replied — need to review",
        },
        {
          action: "resolve",
          id: "ol-2",
          status: "resolved",
        },
      ],
      archiveObservations: [
        {
          content: "User prefers dark mode",
          role: "user",
          modality: "text",
          source: "vellum",
        },
      ],
      archiveEpisodes: [
        {
          title: "Setup discussion",
          summary: "User configured their workspace preferences",
          source: "vellum",
        },
      ],
    };

    const result = parseReducerOutput(toRaw(raw));

    expect(result.timeContexts).toHaveLength(3);
    expect(result.timeContexts[0]).toEqual({
      action: "create",
      summary: "User traveling next week",
      source: "conversation",
      activeFrom: 1700000000000,
      activeUntil: 1700604800000,
    });
    expect(result.timeContexts[1]).toEqual({
      action: "update",
      id: "tc-1",
      summary: "Updated travel dates",
    });
    expect(result.timeContexts[2]).toEqual({
      action: "resolve",
      id: "tc-2",
    });

    expect(result.openLoops).toHaveLength(3);
    expect(result.openLoops[0]).toEqual({
      action: "create",
      summary: "Follow up with Bob",
      source: "conversation",
      dueAt: 1700172800000,
    });
    expect(result.openLoops[1]).toEqual({
      action: "update",
      id: "ol-1",
      summary: "Bob replied — need to review",
    });
    expect(result.openLoops[2]).toEqual({
      action: "resolve",
      id: "ol-2",
      status: "resolved",
    });

    expect(result.archiveObservations).toHaveLength(1);
    expect(result.archiveObservations[0]).toEqual({
      content: "User prefers dark mode",
      role: "user",
      modality: "text",
      source: "vellum",
    });

    expect(result.archiveEpisodes).toHaveLength(1);
    expect(result.archiveEpisodes[0]).toEqual({
      title: "Setup discussion",
      summary: "User configured their workspace preferences",
      source: "vellum",
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: parseReducerOutput — partial outputs
// ---------------------------------------------------------------------------

describe("parseReducerOutput — partial outputs", () => {
  test("accepts output with only timeContexts", () => {
    const result = parseReducerOutput(
      toRaw({
        timeContexts: [
          {
            action: "create",
            summary: "Deadline Friday",
            source: "conversation",
            activeFrom: 1700000000000,
            activeUntil: 1700604800000,
          },
        ],
      }),
    );
    expect(result.timeContexts).toHaveLength(1);
    expect(result.openLoops).toHaveLength(0);
    expect(result.archiveObservations).toHaveLength(0);
    expect(result.archiveEpisodes).toHaveLength(0);
  });

  test("accepts output with only openLoops", () => {
    const result = parseReducerOutput(
      toRaw({
        openLoops: [
          {
            action: "create",
            summary: "Need to reply to Alice",
            source: "conversation",
          },
        ],
      }),
    );
    expect(result.openLoops).toHaveLength(1);
    expect(result.timeContexts).toHaveLength(0);
  });

  test("accepts output with only archiveObservations", () => {
    const result = parseReducerOutput(
      toRaw({
        archiveObservations: [{ content: "User likes coffee", role: "user" }],
      }),
    );
    expect(result.archiveObservations).toHaveLength(1);
    expect(result.archiveObservations[0]).toEqual({
      content: "User likes coffee",
      role: "user",
    });
  });

  test("accepts output with only archiveEpisodes", () => {
    const result = parseReducerOutput(
      toRaw({
        archiveEpisodes: [{ title: "Onboarding", summary: "First session" }],
      }),
    );
    expect(result.archiveEpisodes).toHaveLength(1);
    expect(result.archiveEpisodes[0]).toEqual({
      title: "Onboarding",
      summary: "First session",
    });
  });

  test("accepts empty arrays for all keys", () => {
    const result = parseReducerOutput(
      toRaw({
        timeContexts: [],
        openLoops: [],
        archiveObservations: [],
        archiveEpisodes: [],
      }),
    );
    expect(result.timeContexts).toHaveLength(0);
    expect(result.openLoops).toHaveLength(0);
    expect(result.archiveObservations).toHaveLength(0);
    expect(result.archiveEpisodes).toHaveLength(0);
    // Should be a fresh object, not EMPTY_REDUCER_RESULT reference
    expect(result).not.toBe(EMPTY_REDUCER_RESULT);
  });

  test("drops invalid individual operations while keeping valid ones", () => {
    const result = parseReducerOutput(
      toRaw({
        timeContexts: [
          // valid create
          {
            action: "create",
            summary: "Valid",
            source: "conversation",
            activeFrom: 1000,
            activeUntil: 2000,
          },
          // invalid — missing summary
          {
            action: "create",
            source: "conversation",
            activeFrom: 1000,
            activeUntil: 2000,
          },
          // invalid — unknown action
          { action: "delete", id: "tc-1" },
          // valid resolve
          { action: "resolve", id: "tc-3" },
        ],
        openLoops: [
          // valid create
          {
            action: "create",
            summary: "Valid loop",
            source: "conversation",
          },
          // invalid resolve — missing status
          { action: "resolve", id: "ol-1" },
          // invalid resolve — invalid status
          { action: "resolve", id: "ol-2", status: "cancelled" },
          // null entry
          null,
        ],
      }),
    );

    expect(result.timeContexts).toHaveLength(2);
    expect(result.timeContexts[0].action).toBe("create");
    expect(result.timeContexts[1].action).toBe("resolve");

    expect(result.openLoops).toHaveLength(1);
    expect(result.openLoops[0].action).toBe("create");
  });
});

// ---------------------------------------------------------------------------
// Tests: parseReducerOutput — time-context validation edge cases
// ---------------------------------------------------------------------------

describe("parseReducerOutput — time-context validation", () => {
  test("rejects create with empty summary", () => {
    const result = parseReducerOutput(
      toRaw({
        timeContexts: [
          {
            action: "create",
            summary: "",
            source: "conversation",
            activeFrom: 1000,
            activeUntil: 2000,
          },
        ],
      }),
    );
    expect(result.timeContexts).toHaveLength(0);
  });

  test("rejects create with non-string summary", () => {
    const result = parseReducerOutput(
      toRaw({
        timeContexts: [
          {
            action: "create",
            summary: 123,
            source: "conversation",
            activeFrom: 1000,
            activeUntil: 2000,
          },
        ],
      }),
    );
    expect(result.timeContexts).toHaveLength(0);
  });

  test("rejects create with negative activeUntil", () => {
    const result = parseReducerOutput(
      toRaw({
        timeContexts: [
          {
            action: "create",
            summary: "Test",
            source: "conversation",
            activeFrom: 1000,
            activeUntil: -1,
          },
        ],
      }),
    );
    expect(result.timeContexts).toHaveLength(0);
  });

  test("accepts create with activeFrom of 0 (epoch)", () => {
    const result = parseReducerOutput(
      toRaw({
        timeContexts: [
          {
            action: "create",
            summary: "From epoch",
            source: "conversation",
            activeFrom: 0,
            activeUntil: 1000,
          },
        ],
      }),
    );
    expect(result.timeContexts).toHaveLength(1);
  });

  test("rejects update with no updatable fields", () => {
    const result = parseReducerOutput(
      toRaw({
        timeContexts: [{ action: "update", id: "tc-1" }],
      }),
    );
    expect(result.timeContexts).toHaveLength(0);
  });

  test("accepts update with only summary", () => {
    const result = parseReducerOutput(
      toRaw({
        timeContexts: [
          { action: "update", id: "tc-1", summary: "New summary" },
        ],
      }),
    );
    expect(result.timeContexts).toHaveLength(1);
    const op = result.timeContexts[0];
    expect(op.action).toBe("update");
    if (op.action === "update") {
      expect(op.summary).toBe("New summary");
      expect(op.activeFrom).toBeUndefined();
      expect(op.activeUntil).toBeUndefined();
    }
  });

  test("rejects resolve with missing id", () => {
    const result = parseReducerOutput(
      toRaw({
        timeContexts: [{ action: "resolve" }],
      }),
    );
    expect(result.timeContexts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: parseReducerOutput — open-loop validation edge cases
// ---------------------------------------------------------------------------

describe("parseReducerOutput — open-loop validation", () => {
  test("accepts create without optional dueAt", () => {
    const result = parseReducerOutput(
      toRaw({
        openLoops: [
          {
            action: "create",
            summary: "No deadline",
            source: "conversation",
          },
        ],
      }),
    );
    expect(result.openLoops).toHaveLength(1);
    if (result.openLoops[0].action === "create") {
      expect(result.openLoops[0].dueAt).toBeUndefined();
    }
  });

  test("accepts create with dueAt", () => {
    const result = parseReducerOutput(
      toRaw({
        openLoops: [
          {
            action: "create",
            summary: "With deadline",
            source: "conversation",
            dueAt: 1700000000000,
          },
        ],
      }),
    );
    expect(result.openLoops).toHaveLength(1);
    if (result.openLoops[0].action === "create") {
      expect(result.openLoops[0].dueAt).toBe(1700000000000);
    }
  });

  test("rejects create with missing source", () => {
    const result = parseReducerOutput(
      toRaw({
        openLoops: [{ action: "create", summary: "Missing source" }],
      }),
    );
    expect(result.openLoops).toHaveLength(0);
  });

  test("rejects update with no updatable fields", () => {
    const result = parseReducerOutput(
      toRaw({
        openLoops: [{ action: "update", id: "ol-1" }],
      }),
    );
    expect(result.openLoops).toHaveLength(0);
  });

  test("accepts update with only dueAt", () => {
    const result = parseReducerOutput(
      toRaw({
        openLoops: [{ action: "update", id: "ol-1", dueAt: 1700000000000 }],
      }),
    );
    expect(result.openLoops).toHaveLength(1);
  });

  test("accepts resolve with status 'expired'", () => {
    const result = parseReducerOutput(
      toRaw({
        openLoops: [{ action: "resolve", id: "ol-1", status: "expired" }],
      }),
    );
    expect(result.openLoops).toHaveLength(1);
    if (result.openLoops[0].action === "resolve") {
      expect(result.openLoops[0].status).toBe("expired");
    }
  });

  test("rejects resolve with invalid status value", () => {
    const result = parseReducerOutput(
      toRaw({
        openLoops: [{ action: "resolve", id: "ol-1", status: "deleted" }],
      }),
    );
    expect(result.openLoops).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: parseReducerOutput — archive observation validation
// ---------------------------------------------------------------------------

describe("parseReducerOutput — archive observation validation", () => {
  test("rejects observation with missing content", () => {
    const result = parseReducerOutput(
      toRaw({
        archiveObservations: [{ role: "user" }],
      }),
    );
    expect(result.archiveObservations).toHaveLength(0);
  });

  test("rejects observation with missing role", () => {
    const result = parseReducerOutput(
      toRaw({
        archiveObservations: [{ content: "Something" }],
      }),
    );
    expect(result.archiveObservations).toHaveLength(0);
  });

  test("includes optional modality and source when present", () => {
    const result = parseReducerOutput(
      toRaw({
        archiveObservations: [
          {
            content: "User likes tea",
            role: "user",
            modality: "voice",
            source: "phone",
          },
        ],
      }),
    );
    expect(result.archiveObservations).toHaveLength(1);
    expect(result.archiveObservations[0].modality).toBe("voice");
    expect(result.archiveObservations[0].source).toBe("phone");
  });

  test("omits modality and source when not valid strings", () => {
    const result = parseReducerOutput(
      toRaw({
        archiveObservations: [
          {
            content: "Fact",
            role: "user",
            modality: 123,
            source: false,
          },
        ],
      }),
    );
    expect(result.archiveObservations).toHaveLength(1);
    expect(result.archiveObservations[0].modality).toBeUndefined();
    expect(result.archiveObservations[0].source).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: parseReducerOutput — archive episode validation
// ---------------------------------------------------------------------------

describe("parseReducerOutput — archive episode validation", () => {
  test("rejects episode with missing title", () => {
    const result = parseReducerOutput(
      toRaw({
        archiveEpisodes: [{ summary: "Some summary" }],
      }),
    );
    expect(result.archiveEpisodes).toHaveLength(0);
  });

  test("rejects episode with missing summary", () => {
    const result = parseReducerOutput(
      toRaw({
        archiveEpisodes: [{ title: "Some title" }],
      }),
    );
    expect(result.archiveEpisodes).toHaveLength(0);
  });

  test("includes optional source when present", () => {
    const result = parseReducerOutput(
      toRaw({
        archiveEpisodes: [
          { title: "Chat", summary: "A chat happened", source: "telegram" },
        ],
      }),
    );
    expect(result.archiveEpisodes).toHaveLength(1);
    expect(result.archiveEpisodes[0].source).toBe("telegram");
  });

  test("omits source when not a valid string", () => {
    const result = parseReducerOutput(
      toRaw({
        archiveEpisodes: [
          { title: "Chat", summary: "A chat happened", source: 42 },
        ],
      }),
    );
    expect(result.archiveEpisodes).toHaveLength(1);
    expect(result.archiveEpisodes[0].source).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: parseReducerOutput — extra/unknown keys are tolerated
// ---------------------------------------------------------------------------

describe("parseReducerOutput — tolerates extra keys", () => {
  test("ignores unknown top-level keys", () => {
    const result = parseReducerOutput(
      toRaw({
        timeContexts: [],
        unknownKey: "whatever",
        anotherOne: [1, 2, 3],
      }),
    );
    expect(result).not.toBe(EMPTY_REDUCER_RESULT);
    expect(result.timeContexts).toHaveLength(0);
  });

  test("ignores extra fields on individual operations", () => {
    const result = parseReducerOutput(
      toRaw({
        openLoops: [
          {
            action: "create",
            summary: "Valid",
            source: "conversation",
            extraField: true,
            nested: { deep: 1 },
          },
        ],
      }),
    );
    expect(result.openLoops).toHaveLength(1);
    // Extra fields should NOT be present on the validated result
    expect((result.openLoops[0] as any).extraField).toBeUndefined();
  });
});
