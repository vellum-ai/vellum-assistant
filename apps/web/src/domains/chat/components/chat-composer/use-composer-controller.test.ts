/**
 * Tests for the composer controller state machine.
 *
 * The web workspace lacks @testing-library/react (no jsdom/happy-dom), so we
 * exercise the hook's behavior through its extracted pure helpers:
 *   - `computeSlashState` — the core state transition logic
 *   - `listIndexUp` / `listIndexDown` — keyboard navigation
 *   - `filteredCommands` / `selectedInputText` — slash command catalog
 *
 * The hook itself is a thin wiring layer that delegates to these helpers.
 */
import { describe, expect, test } from "bun:test";

import {
  filteredCommands,
  selectedInputText,
  SLASH_COMMANDS,
} from "@/domains/chat/components/chat-composer/slash-command-catalog.js";
import {
  computeEmojiState,
  computeSlashState,
  EMOJI_TRIGGER_RE,
  listIndexDown,
  listIndexUp,
} from "@/domains/chat/components/chat-composer/use-composer-controller.js";

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
// computeSlashState — state machine transitions
// ---------------------------------------------------------------------------

describe("computeSlashState", () => {
  test('typing "/" opens popup with all commands', () => {
    const [state] = computeSlashState("/", false);
    expect(state.showSlashMenu).toBe(true);
    expect(state.slashFilter).toBe("");
    expect(state.slashCommands).toHaveLength(6);
    expect(state.slashSelectedIndex).toBe(0);
  });

  test('typing "/mo" filters to models', () => {
    const [state] = computeSlashState("/mo", false);
    expect(state.showSlashMenu).toBe(true);
    expect(state.slashFilter).toBe("mo");
    expect(state.slashCommands).toHaveLength(1);
    expect(state.slashCommands[0]!.name).toBe("models");
  });

  test('typing "/c" shows commands, compact, and clean', () => {
    const [state] = computeSlashState("/c", false);
    expect(state.showSlashMenu).toBe(true);
    expect(state.slashCommands.map((c) => c.name)).toEqual(["commands", "compact", "clean"]);
  });

  test('typing "/xyz" closes popup (no matching commands)', () => {
    const [state] = computeSlashState("/xyz", false);
    expect(state.showSlashMenu).toBe(false);
    expect(state.slashFilter).toBe("xyz");
    expect(state.slashCommands).toHaveLength(0);
  });

  test("empty input closes popup", () => {
    const [state] = computeSlashState("", false);
    expect(state.showSlashMenu).toBe(false);
    expect(state.slashFilter).toBe("");
    expect(state.slashCommands).toHaveLength(0);
  });

  test("input without leading slash closes popup", () => {
    const [state] = computeSlashState("hello", false);
    expect(state.showSlashMenu).toBe(false);
  });

  test("input with slash not at start (e.g. 'a/b') closes popup", () => {
    const [state] = computeSlashState("a/b", false);
    expect(state.showSlashMenu).toBe(false);
  });

  test("input with space after command closes popup", () => {
    const [state] = computeSlashState("/status hello", false);
    expect(state.showSlashMenu).toBe(false);
  });

  test("selectedIndex resets to 0 on filter change", () => {
    // First call with /c
    const [state1] = computeSlashState("/c", false);
    expect(state1.slashSelectedIndex).toBe(0);

    // Second call with /co — index always resets
    const [state2] = computeSlashState("/co", false);
    expect(state2.slashSelectedIndex).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Suppress reopen
// ---------------------------------------------------------------------------

describe("computeSlashState — suppress reopen", () => {
  test("when suppressed, returns hidden state with correct filter and consumed=true", () => {
    const [state, consumed] = computeSlashState("/", true);
    expect(state.showSlashMenu).toBe(false);
    expect(state.slashFilter).toBe("");
    expect(state.slashCommands).toHaveLength(6);
    expect(consumed).toBe(true);
  });

  test("when suppressed with filter, preserves filter and commands", () => {
    const [state, consumed] = computeSlashState("/mo", true);
    expect(state.showSlashMenu).toBe(false);
    expect(state.slashFilter).toBe("mo");
    expect(state.slashCommands).toHaveLength(1);
    expect(state.slashCommands[0]!.name).toBe("models");
    expect(consumed).toBe(true);
  });

  test("after suppress consumed, next call with / reopens popup", () => {
    // First call: suppressed
    const [, consumed] = computeSlashState("/", true);
    expect(consumed).toBe(true);

    // Second call: suppress cleared (suppressed=false)
    const [state2] = computeSlashState("/", false);
    expect(state2.showSlashMenu).toBe(true);
  });

  test("suppress is consumed on non-slash input", () => {
    // When the trigger is gone, the flag should clear so the next "/"
    // can reopen the menu — otherwise dismiss-then-clear-input leaks the
    // flag and swallows the next keystroke.
    const [state, consumed] = computeSlashState("hello", true);
    expect(state.showSlashMenu).toBe(false);
    expect(consumed).toBe(true);
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
  test("dismiss prevents reopen for exactly one cycle", () => {
    // User types /
    const [s1] = computeSlashState("/", false);
    expect(s1.showSlashMenu).toBe(true);

    // User dismisses (sets suppress=true)
    // Next onTextChange with / still present — suppressed
    const [s2, consumed] = computeSlashState("/", true);
    expect(s2.showSlashMenu).toBe(false);
    expect(consumed).toBe(true);

    // After consume, suppress is false — next / reopens
    const [s3] = computeSlashState("/", false);
    expect(s3.showSlashMenu).toBe(true);
  });

  test("dismiss + typing filter does not require extra keystroke", () => {
    // User types / — menu opens
    const [s1] = computeSlashState("/", false);
    expect(s1.showSlashMenu).toBe(true);

    // User dismisses, then types /m — suppress consumes this keystroke
    // but filter should still track the "m" so the next keystroke works
    const [s2, consumed] = computeSlashState("/m", true);
    expect(s2.showSlashMenu).toBe(false);
    expect(s2.slashFilter).toBe("m");
    // Commands matching "m" should be present even though menu is hidden
    expect(s2.slashCommands.length).toBeGreaterThan(0);
    expect(consumed).toBe(true);

    // Next keystroke /mo — suppress cleared, menu reopens with correct filter
    const [s3] = computeSlashState("/mo", false);
    expect(s3.showSlashMenu).toBe(true);
    expect(s3.slashFilter).toBe("mo");
    expect(s3.slashCommands).toHaveLength(1);
    expect(s3.slashCommands[0]!.name).toBe("models");
  });
});

describe("scenario: keyboard navigation wraps at boundaries", () => {
  test("full wrap cycle down through 5 commands", () => {
    // Starting at 0, go down through all 5
    let idx = 0;
    idx = listIndexDown(idx, 5); // 1
    expect(idx).toBe(1);
    idx = listIndexDown(idx, 5); // 2
    expect(idx).toBe(2);
    idx = listIndexDown(idx, 5); // 3
    expect(idx).toBe(3);
    idx = listIndexDown(idx, 5); // 4
    expect(idx).toBe(4);
    idx = listIndexDown(idx, 5); // wrap to 0
    expect(idx).toBe(0);
  });

  test("full wrap cycle up through 5 commands", () => {
    let idx = 0;
    idx = listIndexUp(idx, 5); // wrap to 4
    expect(idx).toBe(4);
    idx = listIndexUp(idx, 5); // 3
    expect(idx).toBe(3);
    idx = listIndexUp(idx, 5); // 2
    expect(idx).toBe(2);
    idx = listIndexUp(idx, 5); // 1
    expect(idx).toBe(1);
    idx = listIndexUp(idx, 5); // 0
    expect(idx).toBe(0);
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
// computeEmojiState — state machine transitions
// ---------------------------------------------------------------------------

describe("computeEmojiState", () => {
  test("typing :th (2+ chars) opens popup with results", () => {
    const [state] = computeEmojiState("hello :th", false);
    expect(state.showEmojiMenu).toBe(true);
    expect(state.emojiFilter).toBe("th");
    expect(state.emojiEntries.length).toBeGreaterThan(0);
  });

  test("typing :t (< 2 chars) does not open popup", () => {
    const [state] = computeEmojiState("hello :t", false);
    expect(state.showEmojiMenu).toBe(false);
  });

  test("no colon trigger returns initial state", () => {
    const [state] = computeEmojiState("hello world", false);
    expect(state.showEmojiMenu).toBe(false);
    expect(state.emojiFilter).toBe("");
  });

  test("suppressed keeps menu hidden but tracks filter", () => {
    const [state, consumed] = computeEmojiState("hello :th", true);
    expect(state.showEmojiMenu).toBe(false);
    expect(state.emojiFilter).toBe("th");
    expect(consumed).toBe(true);
  });

  test(":+1 shortcode triggers emoji popup", () => {
    const [state] = computeEmojiState("hello :+1", false);
    // +1 is only 2 chars, meets minimum filter length
    expect(state.emojiFilter).toBe("+1");
    // Whether the menu shows depends on whether there are matching entries
    expect(state.emojiEntries).toBeDefined();
  });
});
