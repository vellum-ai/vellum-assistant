import { describe, expect, test } from "bun:test";

import {
  safeStringSlice,
  stripOrphanedSurrogates,
  stripOrphanedSurrogatesDeep,
} from "../util/unicode.js";

// U+1F389 PARTY POPPER = "\uD83C\uDF89" (a surrogate pair).
const EMOJI = "\uD83C\uDF89";
const HIGH = "\uD83C";
const LOW = "\uDF89";
const REPLACEMENT = "\uFFFD";

describe("safeStringSlice", () => {
  test("no-op when string has no surrogates", () => {
    expect(safeStringSlice("hello world", 0, 5)).toBe("hello");
  });

  test("behaves like slice when no surrogates on the boundary", () => {
    const s = `abc${EMOJI}xyz`;
    // slice at position 0-3: "abc", no boundary trouble
    expect(safeStringSlice(s, 0, 3)).toBe("abc");
  });

  test("backs off high surrogate at end when more string follows", () => {
    // "abc" + high surrogate at position 3, low at position 4, then "xyz".
    // Cutting at end=4 would land between the pair — back off to 3.
    const s = `abc${EMOJI}xyz`;
    const result = safeStringSlice(s, 0, 4);
    expect(result).toBe("abc");
  });

  test("preserves a complete surrogate pair at end", () => {
    const s = `abc${EMOJI}xyz`;
    // end=5 includes both code units of the pair (positions 3 and 4).
    const result = safeStringSlice(s, 0, 5);
    expect(result).toBe(`abc${EMOJI}`);
  });

  test("does NOT repair trailing high surrogate when end === length", () => {
    // An already-orphaned high surrogate at the tail must not be silently
    // dropped by safeStringSlice — that's the sanitizer's job. safeStringSlice
    // only protects against creating NEW orphans at a cut boundary.
    const s = `abc${HIGH}`;
    expect(safeStringSlice(s, 0, s.length)).toBe(`abc${HIGH}`);
  });

  test("advances start past orphaned low surrogate", () => {
    const s = `abc${EMOJI}xyz`;
    // Starting at position 4 would begin mid-pair (on the low surrogate) —
    // advance to position 5.
    const result = safeStringSlice(s, 4, s.length);
    expect(result).toBe("xyz");
  });

  test("does NOT advance when start === 0", () => {
    // start=0 can never land mid-pair — leave leading orphans alone.
    const s = `${LOW}abc`;
    expect(safeStringSlice(s, 0, s.length)).toBe(`${LOW}abc`);
  });

  test("handles both start mid-pair and end mid-pair in one call", () => {
    const s = `${EMOJI}abc${EMOJI}xyz`;
    // Slice from position 1 (low surrogate) to 6 (high surrogate of second emoji).
    // Should advance start to 2 and back off end to 5.
    const result = safeStringSlice(s, 1, 6);
    expect(result).toBe("abc");
  });

  test("clamps start and end into range", () => {
    expect(safeStringSlice("hello", -5, 100)).toBe("hello");
  });

  test("returns empty string when start > end after adjustment", () => {
    const s = EMOJI;
    // start=1 (low surrogate) advances to 2. end=1 (clamped to length=2). Empty range.
    const result = safeStringSlice(s, 1, 1);
    expect(result).toBe("");
  });
});

describe("stripOrphanedSurrogates", () => {
  test("returns same reference for ASCII", () => {
    const s = "hello world";
    expect(stripOrphanedSurrogates(s)).toBe(s);
  });

  test("returns same reference for BMP-only text", () => {
    const s = "héllo wörld";
    expect(stripOrphanedSurrogates(s)).toBe(s);
  });

  test("returns same reference when all surrogates are paired", () => {
    const s = `hello ${EMOJI} world ${EMOJI}`;
    expect(stripOrphanedSurrogates(s)).toBe(s);
  });

  test("replaces a lone high surrogate with U+FFFD", () => {
    const s = `abc${HIGH}xyz`;
    expect(stripOrphanedSurrogates(s)).toBe(`abc${REPLACEMENT}xyz`);
  });

  test("replaces a lone low surrogate with U+FFFD", () => {
    const s = `abc${LOW}xyz`;
    expect(stripOrphanedSurrogates(s)).toBe(`abc${REPLACEMENT}xyz`);
  });

  test("replaces a lone high surrogate at the very end", () => {
    const s = `abc${HIGH}`;
    expect(stripOrphanedSurrogates(s)).toBe(`abc${REPLACEMENT}`);
  });

  test("replaces a lone low surrogate at the very start", () => {
    const s = `${LOW}abc`;
    expect(stripOrphanedSurrogates(s)).toBe(`${REPLACEMENT}abc`);
  });

  test("preserves valid pairs while replacing orphans", () => {
    const s = `${EMOJI}${HIGH}${EMOJI}`;
    expect(stripOrphanedSurrogates(s)).toBe(`${EMOJI}${REPLACEMENT}${EMOJI}`);
  });

  test("handles two high surrogates in a row (both orphans)", () => {
    const s = `${HIGH}${HIGH}xyz`;
    expect(stripOrphanedSurrogates(s)).toBe(
      `${REPLACEMENT}${REPLACEMENT}xyz`,
    );
  });

  test("produces output that round-trips through JSON", () => {
    const s = `abc${HIGH}xyz`;
    const cleaned = stripOrphanedSurrogates(s);
    expect(() => JSON.stringify(cleaned)).not.toThrow();
    // And the serialized string is valid JSON that parses back.
    const json = JSON.stringify(cleaned);
    expect(JSON.parse(json)).toBe(cleaned);
  });
});

describe("stripOrphanedSurrogatesDeep", () => {
  test("returns same reference on a clean string", () => {
    const input = "hello";
    const result = stripOrphanedSurrogatesDeep(input);
    expect(result.changed).toBe(false);
    expect(result.value).toBe(input);
    expect(result.fixedStringCount).toBe(0);
  });

  test("returns same reference on a clean object tree", () => {
    const input = {
      a: "hello",
      b: { c: ["world", 42, null, { d: EMOJI }] },
    };
    const result = stripOrphanedSurrogatesDeep(input);
    expect(result.changed).toBe(false);
    expect(result.value).toBe(input);
    expect(result.fixedStringCount).toBe(0);
  });

  test("rewrites nested strings with orphans", () => {
    const input: { a: string; b: Array<{ c: string } | string> } = {
      a: "clean",
      b: [{ c: `bad${HIGH}` }, "also clean"],
    };
    const result = stripOrphanedSurrogatesDeep(input);
    expect(result.changed).toBe(true);
    expect(result.fixedStringCount).toBe(1);
    const firstChild = result.value.b[0] as { c: string };
    expect(firstChild.c).toBe(`bad${REPLACEMENT}`);
    // Clean siblings are preserved by value (structural equality).
    expect(result.value.a).toBe("clean");
    expect(result.value.b[1]).toBe("also clean");
  });

  test("leaves non-plain objects untouched", () => {
    class Custom {
      value = `bad${HIGH}`;
    }
    const inst = new Custom();
    const result = stripOrphanedSurrogatesDeep({ inst });
    // We don't walk class instances — they pass through unchanged.
    expect(result.changed).toBe(false);
    expect(result.value.inst).toBe(inst);
  });

  test("counts multiple fixed strings", () => {
    const input = {
      a: `one${HIGH}`,
      b: `two${LOW}`,
      c: "clean",
    };
    const result = stripOrphanedSurrogatesDeep(input);
    expect(result.changed).toBe(true);
    expect(result.fixedStringCount).toBe(2);
  });

  test("preserves reference identity of every clean container in a nested tree", () => {
    // The happy path must not allocate shadow arrays/objects — this runs on
    // every outbound Anthropic request, so GC churn adds up. Verify that the
    // top-level object AND every nested container is returned by reference.
    const innerArr = ["a", "b", EMOJI];
    const innerObj = { x: 1, y: "ok", z: innerArr };
    const input = {
      a: "hello",
      b: innerObj,
      c: [innerObj, "clean", EMOJI],
    };
    const result = stripOrphanedSurrogatesDeep(input);
    expect(result.changed).toBe(false);
    expect(result.value).toBe(input);
    expect(result.value.b).toBe(innerObj);
    expect(result.value.b.z).toBe(innerArr);
    expect(result.value.c).toBe(input.c);
    expect(result.value.c[0]).toBe(innerObj);
  });

  test("clean siblings alongside a dirty child reuse original references where possible", () => {
    // When one branch changes, only the containers on the path from root to
    // the change should be reallocated — untouched sibling subtrees must keep
    // their original reference.
    const cleanBranch = { deep: { list: ["a", "b"] } };
    const input = {
      clean: cleanBranch,
      dirty: { value: `bad${HIGH}` },
    };
    const result = stripOrphanedSurrogatesDeep(input);
    expect(result.changed).toBe(true);
    expect(result.value).not.toBe(input);
    expect(result.value.clean).toBe(cleanBranch);
    expect(result.value.clean.deep).toBe(cleanBranch.deep);
    expect(result.value.clean.deep.list).toBe(cleanBranch.deep.list);
    expect(result.value.dirty).not.toBe(input.dirty);
    expect(result.value.dirty.value).toBe(`bad${REPLACEMENT}`);
  });

  test("array with a dirty tail preserves clean leading element references", () => {
    const cleanItem = { k: "v" };
    const input = [cleanItem, `bad${HIGH}`];
    const result = stripOrphanedSurrogatesDeep(input);
    expect(result.changed).toBe(true);
    expect(result.value).not.toBe(input);
    expect(result.value[0]).toBe(cleanItem);
    expect(result.value[1]).toBe(`bad${REPLACEMENT}`);
  });

  test("rewritten output can be JSON-stringified end-to-end", () => {
    // This is the exact shape of the bug: a payload with an orphaned high
    // surrogate buried in a tool_result content string. After sanitization,
    // JSON.stringify must succeed and the JSON must parse back cleanly.
    const payload = {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "abc",
              content: `shell output before ${HIGH} shell output after`,
            },
          ],
        },
      ],
    };
    const result = stripOrphanedSurrogatesDeep(payload);
    expect(result.changed).toBe(true);
    const json = JSON.stringify(result.value);
    expect(() => JSON.parse(json)).not.toThrow();
  });
});
