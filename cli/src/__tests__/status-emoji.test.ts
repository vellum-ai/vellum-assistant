import { describe, test, expect } from "bun:test";
import { statusEmoji, withStatusEmoji } from "../lib/status-emoji.js";

describe("statusEmoji", () => {
  test("returns green for running/healthy/ok statuses", () => {
    expect(statusEmoji("running")).toBe("\u{1F7E2}");
    expect(statusEmoji("healthy")).toBe("\u{1F7E2}");
    expect(statusEmoji("ok")).toBe("\u{1F7E2}");
  });

  test("returns green for statuses starting with 'up '", () => {
    expect(statusEmoji("up 5 minutes")).toBe("\u{1F7E2}");
    expect(statusEmoji("up 1d")).toBe("\u{1F7E2}");
  });

  test("returns red for error/unreachable/exited statuses", () => {
    expect(statusEmoji("error")).toBe("\u{1F534}");
    expect(statusEmoji("error (500)")).toBe("\u{1F534}");
    expect(statusEmoji("unreachable")).toBe("\u{1F534}");
    expect(statusEmoji("exited")).toBe("\u{1F534}");
    expect(statusEmoji("exited (1)")).toBe("\u{1F534}");
  });

  test("returns yellow for unknown statuses", () => {
    expect(statusEmoji("starting")).toBe("\u{1F7E1}");
    expect(statusEmoji("pending")).toBe("\u{1F7E1}");
    expect(statusEmoji("unknown")).toBe("\u{1F7E1}");
  });

  test("is case-insensitive", () => {
    expect(statusEmoji("Running")).toBe("\u{1F7E2}");
    expect(statusEmoji("HEALTHY")).toBe("\u{1F7E2}");
    expect(statusEmoji("ERROR")).toBe("\u{1F534}");
    expect(statusEmoji("Unreachable")).toBe("\u{1F534}");
  });
});

describe("withStatusEmoji", () => {
  test("prepends emoji to status string", () => {
    expect(withStatusEmoji("running")).toBe("\u{1F7E2} running");
    expect(withStatusEmoji("error")).toBe("\u{1F534} error");
    expect(withStatusEmoji("pending")).toBe("\u{1F7E1} pending");
  });
});
