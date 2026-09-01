import { describe, expect, test } from "bun:test";

import {
  FOLLOWUP_MAX_AGE_MS,
  FOLLOWUP_MIN_AGE_MS,
  PIPELINE_HINT,
  classifyLabelIds,
  collectAddedMessageIds,
  dueFollowups,
  emptyAccount,
  expiredFollowups,
  filterUnreported,
  flagValue,
  flagValues,
  isImmediateWork,
  isSentCandidate,
  markReported,
  parseLookbackSeconds,
  parsePollState,
  rememberFollowups,
  shouldEscalate,
  takeDigestSlice,
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

describe("immediate vs sent work", () => {
  test("inbox and both are judged now; sent-only is aged", () => {
    expect(isImmediateWork("inbox")).toBe(true);
    expect(isImmediateWork("both")).toBe(true);
    expect(isImmediateWork("sent")).toBe(false);
    expect(isImmediateWork("ignore")).toBe(false);
    expect(isSentCandidate("sent")).toBe(true);
    expect(isSentCandidate("both")).toBe(true);
    expect(isSentCandidate("inbox")).toBe(false);
  });
});

describe("shouldEscalate", () => {
  test("empty leftover pile does not wake the assistant", () => {
    expect(shouldEscalate([])).toBe(false);
    expect(shouldEscalate([{ bucket: "ignore" }])).toBe(false);
    expect(shouldEscalate([{ bucket: "sent" }])).toBe(false);
  });

  test("new inbox mail or a due follow-up wakes the assistant", () => {
    expect(shouldEscalate([{ bucket: "inbox" }])).toBe(true);
    expect(shouldEscalate([{ bucket: "ignore" }, { bucket: "both" }])).toBe(
      true,
    );
    expect(shouldEscalate([{ bucket: "sent" }], 1)).toBe(true);
    expect(shouldEscalate([], 2)).toBe(true);
  });
});

describe("parsePollState", () => {
  test("returns empty state for junk input", () => {
    expect(parsePollState(null)).toEqual({ accounts: {} });
    expect(parsePollState("nope")).toEqual({ accounts: {} });
    expect(parsePollState({ accounts: { "user@example.com": 1 } })).toEqual({
      accounts: {},
    });
  });

  test("keeps history, pending, reported, and follow-ups", () => {
    const state = parsePollState({
      accounts: {
        "user@example.com": {
          historyId: "99",
          reported: { m1: 100 },
          pending: ["m2", 3],
          followups: [
            {
              id: "s1",
              threadId: "t1",
              sentAt: 1,
              subject: "Hello",
            },
            { id: "bad" },
          ],
        },
      },
    });
    expect(state.accounts["user@example.com"]).toEqual({
      historyId: "99",
      reported: { m1: 100 },
      pending: ["m2"],
      followups: [{ id: "s1", threadId: "t1", sentAt: 1, subject: "Hello" }],
    });
  });
});

describe("reported ledger", () => {
  test("filterUnreported skips ids already delivered", () => {
    const account = emptyAccount("1");
    markReported(account, ["m1"], 50);
    expect(filterUnreported(account, ["m1", "m2"])).toEqual(["m2"]);
  });
});

describe("follow-up aging", () => {
  const now = Date.parse("2026-08-20T12:00:00.000Z");

  test("due window is 2 to 14 days", () => {
    const rows = [
      {
        id: "young",
        threadId: "t1",
        sentAt: now - FOLLOWUP_MIN_AGE_MS + 1,
        subject: "too new",
      },
      {
        id: "due",
        threadId: "t2",
        sentAt: now - FOLLOWUP_MIN_AGE_MS,
        subject: "stale",
      },
      {
        id: "old",
        threadId: "t3",
        sentAt: now - FOLLOWUP_MAX_AGE_MS - 1,
        subject: "expired",
      },
    ];
    expect(dueFollowups(rows, now).map((row) => row.id)).toEqual(["due"]);
    expect(expiredFollowups(rows, now).map((row) => row.id)).toEqual(["old"]);
  });

  test("rememberFollowups upserts by id", () => {
    const account = emptyAccount();
    rememberFollowups(account, [
      { id: "s1", threadId: "t1", sentAt: 1, subject: "A" },
    ]);
    rememberFollowups(account, [
      { id: "s1", threadId: "t1", sentAt: 2, subject: "B" },
      { id: "s2", threadId: "t2", sentAt: 3, subject: "C" },
    ]);
    expect(account.followups).toEqual([
      { id: "s1", threadId: "t1", sentAt: 2, subject: "B" },
      { id: "s2", threadId: "t2", sentAt: 3, subject: "C" },
    ]);
  });
});

describe("takeDigestSlice", () => {
  test("follow-ups fill first; overflow inbox ids stay pending", () => {
    const followups = [{ id: "f1" }, { id: "f2" }, { id: "f3" }];
    const inbox = [{ id: "i1" }, { id: "i2" }, { id: "i3" }];
    const sliced = takeDigestSlice(followups, inbox, 4);
    expect(sliced.delivered.map((row) => row.id)).toEqual([
      "f1",
      "f2",
      "f3",
      "i1",
    ]);
    expect(sliced.overflowIds).toEqual(["i2", "i3"]);
  });

  test("follow-ups that do not fit stay out of overflow", () => {
    const sliced = takeDigestSlice(
      [{ id: "f1" }, { id: "f2" }],
      [{ id: "i1" }],
      1,
    );
    expect(sliced.delivered.map((row) => row.id)).toEqual(["f1"]);
    expect(sliced.overflowIds).toEqual(["i1"]);
  });

  test("wake hint scopes the pipeline to the digest", () => {
    expect(PIPELINE_HINT).toContain("attached digest only");
    expect(PIPELINE_HINT).toContain("Do not re-scan the rest of the inbox");
  });
});
