import { describe, expect, test } from "bun:test";

import { AdmissionDropLog } from "./admission-drop-log.js";
import "../__tests__/test-preload.js";

type Reason = "addressed_elsewhere" | "unreadable" | "self_authored";

function dropLog(): AdmissionDropLog<Reason> {
  return new AdmissionDropLog<Reason>({
    addressed_elsewhere: "info",
    unreadable: "info",
    self_authored: "debug",
  });
}

describe("AdmissionDropLog", () => {
  test("a promotable reason surfaces once per conversation, then at debug", () => {
    const log = dropLog();
    expect(log.levelFor("addressed_elsewhere", "room-1")).toBe("info");
    expect(log.levelFor("addressed_elsewhere", "room-1")).toBe("debug");
    expect(log.levelFor("addressed_elsewhere", "room-2")).toBe("info");
  });

  test("a drop with no conversation to key on is promoted every time", () => {
    // A malformed payload names no chat. Keying every such drop on one
    // shared bucket would surface the first and hide a wave of them later,
    // which is the failure the log exists to make visible.
    const log = dropLog();
    expect(log.levelFor("unreadable", undefined)).toBe("info");
    expect(log.levelFor("unreadable", undefined)).toBe("info");
    expect(log.levelFor("unreadable", undefined)).toBe("info");
  });

  test("an unkeyed drop consumes no conversation budget", () => {
    const log = dropLog();
    for (let i = 0; i < 600; i++) {
      log.levelFor("unreadable", undefined);
    }
    expect(log.levelFor("unreadable", "room-1")).toBe("info");
  });

  test("never-promoted reasons stay at debug with or without a key", () => {
    const log = dropLog();
    expect(log.levelFor("self_authored", "room-1")).toBe("debug");
    expect(log.levelFor("self_authored", undefined)).toBe("debug");
  });
});
