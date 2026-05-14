import { describe, expect, it } from "bun:test";

import { canonicalDateTimeKey } from "../context/compactor.js";

describe("canonicalDateTimeKey", () => {
  const stored = "2026-04-02 (Thursday) 01:52:33 -05:00 (America/Chicago)";

  it("reduces the verbatim stored format to date+time", () => {
    expect(canonicalDateTimeKey(stored)).toBe("2026-04-02T01:52:33");
  });

  it("matches when the model drops the weekday parens", () => {
    expect(
      canonicalDateTimeKey("2026-04-02 01:52:33 -05:00 (America/Chicago)"),
    ).toBe("2026-04-02T01:52:33");
  });

  it("matches when the model drops the timezone parens", () => {
    expect(canonicalDateTimeKey("2026-04-02 (Thursday) 01:52:33 -05:00")).toBe(
      "2026-04-02T01:52:33",
    );
  });

  it("matches when the model emits ISO-8601 with a T separator", () => {
    expect(canonicalDateTimeKey("2026-04-02T01:52:33-05:00")).toBe(
      "2026-04-02T01:52:33",
    );
  });

  it("matches when the model emits only date and time", () => {
    expect(canonicalDateTimeKey("2026-04-02 01:52:33")).toBe(
      "2026-04-02T01:52:33",
    );
  });

  it("returns null when no date+time pair is present", () => {
    expect(canonicalDateTimeKey("hello world")).toBeNull();
    expect(canonicalDateTimeKey("2026-04-02")).toBeNull();
    expect(canonicalDateTimeKey("01:52:33")).toBeNull();
  });
});
