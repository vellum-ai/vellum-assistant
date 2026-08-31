import { describe, expect, test } from "bun:test";

import {
  PIPELINE_HINT,
  STOCK_EXECUTE_MESSAGE,
  classifyLabelIds,
  collectAddedMessageIds,
  flagValue,
  flagValues,
  isEscalatable,
  isStockExecuteInboxSchedule,
  parseLookbackSeconds,
  shouldEscalate,
} from "../poll-lib.ts";

describe("parseLookbackSeconds", () => {
  test("parses bare seconds and unit suffixes", () => {
    expect(parseLookbackSeconds("90")).toBe(90);
    expect(parseLookbackSeconds("90m")).toBe(90 * 60);
    expect(parseLookbackSeconds("4h")).toBe(4 * 3600);
    expect(parseLookbackSeconds("2d")).toBe(2 * 86400);
    expect(parseLookbackSeconds("1w")).toBe(7 * 86400);
    expect(parseLookbackSeconds("0")).toBe(0);
  });

  test("rejects junk", () => {
    expect(() => parseLookbackSeconds("yesterday")).toThrow(
      /Invalid --lookback/,
    );
  });
});

describe("flag parsers", () => {
  test("flagValue reads the next argv token", () => {
    expect(flagValue(["--lookback", "4h"], "--lookback")).toBe("4h");
    expect(flagValue(["--other", "x"], "--lookback")).toBeUndefined();
  });

  test("flagValues collects repeats", () => {
    expect(
      flagValues(
        ["--account", "a@example.com", "--account", "b@example.com"],
        "--account",
      ),
    ).toEqual(["a@example.com", "b@example.com"]);
  });
});

describe("collectAddedMessageIds", () => {
  test("returns empty on a quiet history page", () => {
    expect(collectAddedMessageIds([])).toEqual({
      ids: [],
      lastRecordId: null,
    });
  });

  test("unions messageAdded ids and keeps the last record id", () => {
    const collected = collectAddedMessageIds([
      { id: "1", messagesAdded: [{ message: { id: "m1" } }] },
      { id: "2", messagesAdded: [] },
      {
        id: "3",
        messagesAdded: [{ message: { id: "m2" } }, { message: { id: "m1" } }],
      },
    ]);
    expect(collected.ids.sort()).toEqual(["m1", "m2"]);
    expect(collected.lastRecordId).toBe("3");
  });
});

describe("classifyLabelIds", () => {
  test("classifies inbox, sent, both, and ignore", () => {
    expect(classifyLabelIds(["INBOX", "UNREAD"])).toBe("inbox");
    expect(classifyLabelIds(["SENT"])).toBe("sent");
    expect(classifyLabelIds(["INBOX", "SENT"])).toBe("both");
    expect(classifyLabelIds(["SPAM"])).toBe("ignore");
    expect(classifyLabelIds(["DRAFT"])).toBe("ignore");
    expect(classifyLabelIds(undefined)).toBe("ignore");
  });
});

describe("shouldEscalate", () => {
  test("empty leftover pile does not wake the agent", () => {
    expect(shouldEscalate([])).toBe(false);
    expect(shouldEscalate([{ bucket: "ignore" }])).toBe(false);
  });

  test("new inbox or sent mail wakes the agent", () => {
    expect(shouldEscalate([{ bucket: "inbox" }])).toBe(true);
    expect(shouldEscalate([{ bucket: "sent" }])).toBe(true);
    expect(shouldEscalate([{ bucket: "ignore" }, { bucket: "both" }])).toBe(
      true,
    );
  });

  test("isEscalatable matches shouldEscalate", () => {
    expect(isEscalatable("ignore")).toBe(false);
    expect(isEscalatable("inbox")).toBe(true);
  });
});

describe("stock execute schedule detection", () => {
  test("matches the leftover execute-mode job, not a script poll", () => {
    expect(
      isStockExecuteInboxSchedule({
        mode: "execute",
        message: STOCK_EXECUTE_MESSAGE,
      }),
    ).toBe(true);
    expect(
      isStockExecuteInboxSchedule({
        mode: "script",
        message: STOCK_EXECUTE_MESSAGE,
      }),
    ).toBe(false);
    expect(
      isStockExecuteInboxSchedule({
        mode: "execute",
        message: "something else",
      }),
    ).toBe(false);
  });

  test("wake hint scopes the pipeline to the digest", () => {
    expect(PIPELINE_HINT).toContain("attached digest only");
    expect(PIPELINE_HINT).toContain("Do not re-scan the rest of the inbox");
  });
});
