/**
 * Tests for the daemon-subject rewrite every minted exchange token carries.
 */

import { describe, test, expect } from "bun:test";
import "../__tests__/test-preload.js";

import { toDaemonSubject } from "./token-exchange.js";

describe("toDaemonSubject", () => {
  test("rewrites the assistant segment to self", () => {
    expect(toDaemonSubject("actor:asst_1:user_1")).toBe("actor:self:user_1");
    expect(toDaemonSubject("svc:gateway:asst_1")).toBe("svc:gateway:self");
    expect(toDaemonSubject("local:asst_1:conv_1")).toBe("local:self:conv_1");
  });

  test("falls back to the gateway service sub for unparseable subs", () => {
    expect(toDaemonSubject("garbage")).toBe("svc:gateway:self");
    expect(toDaemonSubject("")).toBe("svc:gateway:self");
  });
});
