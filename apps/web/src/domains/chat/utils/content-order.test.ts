import { describe, expect, test } from "bun:test";
import {
  encodeContentOrderEntry,
  normalizeContentOrder,
  parseContentOrderEntry,
} from "@/domains/chat/utils/content-order";

describe("encodeContentOrderEntry", () => {
  test("joins type and id with a colon", () => {
    /**
     * Encoding produces the `"<type>:<ref>"` wire form.
     */

    // GIVEN a content kind and a positional ref
    // WHEN the entry is encoded
    const entry = encodeContentOrderEntry("text", "0");

    // THEN it is the colon-joined wire string
    expect(entry).toBe("text:0");
  });

  test("preserves entity-id refs that contain colons", () => {
    /**
     * Streaming refs are entity ids that may themselves contain colons; the
     * full id must survive encoding.
     */

    // GIVEN a streaming entity id containing a colon
    // WHEN the entry is encoded
    const entry = encodeContentOrderEntry("toolCall", "toolu:abc");

    // THEN the whole id is retained after the type segment
    expect(entry).toBe("toolCall:toolu:abc");
  });
});

describe("parseContentOrderEntry", () => {
  test("splits on the first colon", () => {
    /**
     * Parsing recovers the type and ref, splitting only on the first colon so
     * refs containing colons stay intact.
     */

    // GIVEN an encoded entry whose ref contains a colon
    // WHEN it is parsed
    const parsed = parseContentOrderEntry("toolCall:toolu:abc");

    // THEN the type is the leading segment and the ref keeps its colons
    expect(parsed).toEqual({ type: "toolCall", id: "toolu:abc" });
  });

  test("returns null for entries without a leading type", () => {
    /**
     * Entries lacking a `"<type>:"` prefix can't be resolved and are rejected.
     */

    // GIVEN entries with no colon or an empty type segment
    // WHEN each is parsed
    // THEN parsing yields null
    expect(parseContentOrderEntry("nocolon")).toBeNull();
    expect(parseContentOrderEntry(":0")).toBeNull();
  });
});

describe("normalizeContentOrder", () => {
  test("passes valid entries through unchanged", () => {
    /**
     * Well-formed wire arrays are carried onto the display row as-is.
     */

    // GIVEN a wire contentOrder of valid entries
    const input = ["text:0", "tool:1", "surface:2"];

    // WHEN it is normalized
    const result = normalizeContentOrder(input);

    // THEN every entry is preserved in order
    expect(result).toEqual(input);
  });

  test("returns undefined for empty or missing input", () => {
    /**
     * Absent ordering collapses to undefined so callers can treat it as unset.
     */

    // GIVEN no contentOrder or an empty array
    // WHEN each is normalized
    // THEN the result is undefined
    expect(normalizeContentOrder(undefined)).toBeUndefined();
    expect(normalizeContentOrder([])).toBeUndefined();
  });

  test("drops malformed entries", () => {
    /**
     * Entries that can't be parsed into a `"<type>:<ref>"` pair are filtered
     * out before reaching the renderer.
     */

    // GIVEN a wire array mixing valid and unparseable entries
    const input = ["text:0", "nocolon", ":bad", "tool:1"];

    // WHEN it is normalized
    const result = normalizeContentOrder(input);

    // THEN only the parseable entries remain
    expect(result).toEqual(["text:0", "tool:1"]);
  });

  test("tolerates non-string entries from unvalidated wire data", () => {
    /**
     * The history endpoint narrows rows only by `id`/`role`, so `contentOrder`
     * reaches the sanitizer unvalidated. Legacy or malformed entries (numbers,
     * `null`, objects) must be dropped rather than thrown on.
     */

    // GIVEN a wire array containing non-string entries alongside valid ones
    const input = [
      "text:0",
      null,
      42,
      { type: "tool", id: "0" },
      undefined,
      "tool:1",
    ];

    // WHEN it is normalized
    const result = normalizeContentOrder(input);

    // THEN the non-string entries are dropped and parsing never throws
    expect(result).toEqual(["text:0", "tool:1"]);
  });
});
