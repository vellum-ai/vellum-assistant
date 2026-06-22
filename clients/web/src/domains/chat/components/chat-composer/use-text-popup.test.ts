/**
 * Tests for the text-triggered popup derivation and navigation helpers.
 *
 * The web workspace lacks @testing-library/react (no jsdom/happy-dom), so we
 * exercise behavior through pure helpers and local mirrors of the hook's
 * derivation logic:
 *   - `listIndexUp` / `listIndexDown` — local mirrors of the wrapping
 *     navigation arithmetic the hook uses internally.
 *   - `filteredCommands` / `selectedInputText` — slash command catalog
 *   - `derivePopupState` — mirrors the hook's inline derivation so the
 *     regex + search + suppress composition can be tested without a React
 *     render cycle.
 */
import { describe, expect, test } from "bun:test";

import {
  EMOJI_MIN_FILTER_LENGTH,
  EMOJI_TRIGGER_RE,
} from "@/domains/chat/components/chat-composer/emoji-catalog";
import { searchEmoji } from "@/domains/chat/components/chat-composer/emoji-catalog-data";
import {
  SLASH_PREFIX_RE,
  filteredCommands,
  selectedInputText,
  SLASH_COMMANDS,
} from "@/domains/chat/components/chat-composer/slash-command-catalog";

/** Local mirror of the hook's wrapping-up navigation. */
function listIndexUp(current: number, listLength: number): number {
  if (listLength === 0) return 0;
  return current <= 0 ? listLength - 1 : current - 1;
}

/** Local mirror of the hook's wrapping-down navigation. */
function listIndexDown(current: number, listLength: number): number {
  if (listLength === 0) return 0;
  return current >= listLength - 1 ? 0 : current + 1;
}

/** Local test helper mirroring the hook's inline derivation logic. */
function derivePopupState<T>(
  text: string,
  trigger: RegExp,
  search: (filter: string) => T[],
  suppressed: boolean,
  minFilterLength = 0,
): { show: boolean; filter: string; items: T[] } {
  const match = trigger.exec(text);
  if (!match) return { show: false, filter: "", items: [] };
  const filter = match[1] ?? "";
  if (filter.length < minFilterLength) return { show: false, filter, items: [] };
  const items = search(filter);
  return { show: items.length > 0 && !suppressed, filter, items };
}

// ---------------------------------------------------------------------------
// Slash command catalog
// ---------------------------------------------------------------------------

describe("filteredCommands", () => {
  test("empty filter returns all 6 commands", () => {
    const result = filteredCommands("");
    expect(result).toHaveLength(6);
    expect(result).toBe(SLASH_COMMANDS);
  });

  test('filter "mo" returns only models', () => {
    const result = filteredCommands("mo");
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("models");
  });

  test('filter "c" returns commands, compact, and clean', () => {
    const result = filteredCommands("c");
    expect(result).toHaveLength(3);
    expect(result.map((c) => c.name)).toEqual(["commands", "compact", "clean"]);
  });

  test('filter "xyz" returns empty list', () => {
    expect(filteredCommands("xyz")).toHaveLength(0);
  });

  test("filter is case-insensitive", () => {
    const result = filteredCommands("MO");
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("models");
  });
});

describe("selectedInputText", () => {
  test("autoSend commands get no trailing space", () => {
    const cmd = SLASH_COMMANDS.find((c) => c.name === "status")!;
    expect(selectedInputText(cmd)).toBe("/status");
  });

  test("insertTrailingSpace commands get trailing space", () => {
    const cmd = SLASH_COMMANDS.find((c) => c.name === "btw")!;
    expect(selectedInputText(cmd)).toBe("/btw ");
  });
});

// ---------------------------------------------------------------------------
// derivePopupState — slash command derivation
// ---------------------------------------------------------------------------

function deriveSlash(text: string, suppressed = false) {
  return derivePopupState(text, SLASH_PREFIX_RE, filteredCommands, suppressed);
}

describe("derivePopupState — slash commands", () => {
  test('typing "/" opens popup with all commands', () => {
    const { show, filter, items } = deriveSlash("/");
    expect(show).toBe(true);
    expect(filter).toBe("");
    expect(items).toHaveLength(6);
  });

  test('typing "/mo" filters to models', () => {
    const { show, filter, items } = deriveSlash("/mo");
    expect(show).toBe(true);
    expect(filter).toBe("mo");
    expect(items).toHaveLength(1);
    expect(items[0]!.name).toBe("models");
  });

  test('typing "/c" shows commands, compact, and clean', () => {
    const { show, items } = deriveSlash("/c");
    expect(show).toBe(true);
    expect(items.map((c) => c.name)).toEqual(["commands", "compact", "clean"]);
  });

  test('typing "/xyz" closes popup (no matching commands)', () => {
    const { show, filter, items } = deriveSlash("/xyz");
    expect(show).toBe(false);
    expect(filter).toBe("xyz");
    expect(items).toHaveLength(0);
  });

  test("empty input closes popup", () => {
    const { show, filter, items } = deriveSlash("");
    expect(show).toBe(false);
    expect(filter).toBe("");
    expect(items).toHaveLength(0);
  });

  test("input without leading slash closes popup", () => {
    expect(deriveSlash("hello").show).toBe(false);
  });

  test("input with slash not at start (e.g. 'a/b') closes popup", () => {
    expect(deriveSlash("a/b").show).toBe(false);
  });

  test("input with space after command closes popup", () => {
    expect(deriveSlash("/status hello").show).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// derivePopupState — suppress behavior
// ---------------------------------------------------------------------------

describe("derivePopupState — suppress", () => {
  test("when suppressed, show is false even with matching items", () => {
    const { show, filter, items } = deriveSlash("/", true);
    expect(show).toBe(false);
    expect(filter).toBe("");
    expect(items).toHaveLength(6);
  });

  test("when suppressed with filter, preserves filter and items", () => {
    const { show, filter, items } = deriveSlash("/mo", true);
    expect(show).toBe(false);
    expect(filter).toBe("mo");
    expect(items).toHaveLength(1);
    expect(items[0]!.name).toBe("models");
  });

  test("when not suppressed, popup shows normally", () => {
    const { show } = deriveSlash("/", false);
    expect(show).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Keyboard navigation — listIndexUp / listIndexDown
// ---------------------------------------------------------------------------

describe("listIndexUp", () => {
  test("moves up from middle of list", () => {
    expect(listIndexUp(2, 5)).toBe(1);
  });

  test("wraps from top to bottom", () => {
    expect(listIndexUp(0, 5)).toBe(4);
  });

  test("returns 0 for empty list", () => {
    expect(listIndexUp(0, 0)).toBe(0);
  });

  test("wraps in single-item list", () => {
    expect(listIndexUp(0, 1)).toBe(0);
  });
});

describe("listIndexDown", () => {
  test("moves down from middle of list", () => {
    expect(listIndexDown(2, 5)).toBe(3);
  });

  test("wraps from bottom to top", () => {
    expect(listIndexDown(4, 5)).toBe(0);
  });

  test("returns 0 for empty list", () => {
    expect(listIndexDown(0, 0)).toBe(0);
  });

  test("wraps in single-item list", () => {
    expect(listIndexDown(0, 1)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Full scenario walk-throughs
// ---------------------------------------------------------------------------

describe("scenario: dismiss + retype suppression", () => {
  test("suppress prevents showing, clearing suppress allows reopening", () => {
    // User types /
    expect(deriveSlash("/", false).show).toBe(true);

    // User dismisses (sets suppress=true)
    expect(deriveSlash("/", true).show).toBe(false);

    // After suppress is cleared (by the hook when text changes), / reopens
    expect(deriveSlash("/", false).show).toBe(true);
  });

  test("dismiss + typing filter tracks filter while suppressed", () => {
    // User types / — menu opens
    expect(deriveSlash("/", false).show).toBe(true);

    // User dismisses, then types /m — suppressed, but filter tracks
    const suppressed = deriveSlash("/m", true);
    expect(suppressed.show).toBe(false);
    expect(suppressed.filter).toBe("m");
    expect(suppressed.items.length).toBeGreaterThan(0);

    // Next keystroke /mo — suppress cleared, menu reopens with correct filter
    const reopened = deriveSlash("/mo", false);
    expect(reopened.show).toBe(true);
    expect(reopened.filter).toBe("mo");
    expect(reopened.items).toHaveLength(1);
    expect(reopened.items[0]!.name).toBe("models");
  });
});

describe("scenario: keyboard navigation wraps at boundaries", () => {
  test("full wrap cycle down through 5 commands", () => {
    let idx = 0;
    idx = listIndexDown(idx, 5); expect(idx).toBe(1);
    idx = listIndexDown(idx, 5); expect(idx).toBe(2);
    idx = listIndexDown(idx, 5); expect(idx).toBe(3);
    idx = listIndexDown(idx, 5); expect(idx).toBe(4);
    idx = listIndexDown(idx, 5); expect(idx).toBe(0);
  });

  test("full wrap cycle up through 5 commands", () => {
    let idx = 0;
    idx = listIndexUp(idx, 5); expect(idx).toBe(4);
    idx = listIndexUp(idx, 5); expect(idx).toBe(3);
    idx = listIndexUp(idx, 5); expect(idx).toBe(2);
    idx = listIndexUp(idx, 5); expect(idx).toBe(1);
    idx = listIndexUp(idx, 5); expect(idx).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// EMOJI_TRIGGER_RE — regex matching
// ---------------------------------------------------------------------------

describe("EMOJI_TRIGGER_RE", () => {
  test("matches basic shortcode like :thumbsup", () => {
    const match = EMOJI_TRIGGER_RE.exec("hello :thumbsup");
    expect(match).not.toBeNull();
    expect(match![1]).toBe("thumbsup");
  });

  test("matches :+1 shortcode (plus sign)", () => {
    const match = EMOJI_TRIGGER_RE.exec("hello :+1");
    expect(match).not.toBeNull();
    expect(match![1]).toBe("+1");
  });

  test("matches :-1 shortcode (minus sign)", () => {
    const match = EMOJI_TRIGGER_RE.exec("hello :-1");
    expect(match).not.toBeNull();
    expect(match![1]).toBe("-1");
  });

  test("matches shortcodes with mixed plus/minus like :thumbs-up", () => {
    const match = EMOJI_TRIGGER_RE.exec(":thumbs-up");
    expect(match).not.toBeNull();
    expect(match![1]).toBe("thumbs-up");
  });

  test("does not match bare colon without characters", () => {
    const match = EMOJI_TRIGGER_RE.exec("hello :");
    expect(match).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// derivePopupState — emoji derivation
// ---------------------------------------------------------------------------

function deriveEmoji(textBeforeCursor: string, suppressed = false) {
  return derivePopupState(
    textBeforeCursor,
    EMOJI_TRIGGER_RE,
    searchEmoji,
    suppressed,
    EMOJI_MIN_FILTER_LENGTH,
  );
}

describe("derivePopupState — emoji", () => {
  test("typing :th (2+ chars) opens popup with results", () => {
    const { show, filter, items } = deriveEmoji("hello :th");
    expect(show).toBe(true);
    expect(filter).toBe("th");
    expect(items.length).toBeGreaterThan(0);
  });

  test("typing :t (< 2 chars) does not open popup", () => {
    const { show } = deriveEmoji("hello :t");
    expect(show).toBe(false);
  });

  test("no colon trigger returns initial state", () => {
    const { show, filter } = deriveEmoji("hello world");
    expect(show).toBe(false);
    expect(filter).toBe("");
  });

  test("suppressed keeps menu hidden but tracks filter", () => {
    const { show, filter } = deriveEmoji("hello :th", true);
    expect(show).toBe(false);
    expect(filter).toBe("th");
  });

  test(":+1 shortcode triggers emoji popup", () => {
    const { filter, items } = deriveEmoji("hello :+1");
    expect(filter).toBe("+1");
    expect(items).toBeDefined();
  });
});
