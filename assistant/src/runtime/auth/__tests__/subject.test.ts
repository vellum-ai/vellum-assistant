import { describe, expect, test } from "bun:test";

import { parseSub } from "../subject.js";

describe("parseSub", () => {
  // -------------------------------------------------------------------------
  // actor pattern
  // -------------------------------------------------------------------------

  test("parses actor:<assistantId>:<actorPrincipalId>", () => {
    const result = parseSub("actor:self:principal-abc");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.principalType).toBe("actor");
      expect(result.assistantId).toBe("self");
      expect(result.actorPrincipalId).toBe("principal-abc");
      expect(result.sessionId).toBeUndefined();
    }
  });

  test("parses actor pattern with complex ids", () => {
    const result = parseSub("actor:asst-uuid-123:principal-uuid-456");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.principalType).toBe("actor");
      expect(result.assistantId).toBe("asst-uuid-123");
      expect(result.actorPrincipalId).toBe("principal-uuid-456");
    }
  });

  // -------------------------------------------------------------------------
  // svc:gateway pattern
  // -------------------------------------------------------------------------

  test("parses svc:gateway:<assistantId>", () => {
    const result = parseSub("svc:gateway:self");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.principalType).toBe("svc_gateway");
      expect(result.assistantId).toBe("self");
      expect(result.actorPrincipalId).toBeUndefined();
      expect(result.sessionId).toBeUndefined();
    }
  });

  // -------------------------------------------------------------------------
  // svc:daemon pattern
  // -------------------------------------------------------------------------

  test("parses svc:daemon:<identifier>", () => {
    const result = parseSub("svc:daemon:self");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.principalType).toBe("svc_daemon");
      expect(result.assistantId).toBe("self");
      expect(result.actorPrincipalId).toBeUndefined();
      expect(result.sessionId).toBeUndefined();
    }
  });

  test("parses svc:daemon with non-self identifier", () => {
    const result = parseSub("svc:daemon:pairing");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.principalType).toBe("svc_daemon");
      expect(result.assistantId).toBe("pairing");
    }
  });

  test("fails on svc:daemon with empty identifier", () => {
    const result = parseSub("svc:daemon:");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("empty");
    }
  });

  // -------------------------------------------------------------------------
  // local pattern
  // -------------------------------------------------------------------------

  test("parses local:<assistantId>:<sessionId>", () => {
    const result = parseSub("local:self:session-xyz");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.principalType).toBe("local");
      expect(result.assistantId).toBe("self");
      expect(result.sessionId).toBe("session-xyz");
      expect(result.actorPrincipalId).toBeUndefined();
    }
  });

  // -------------------------------------------------------------------------
  // Malformed input
  // -------------------------------------------------------------------------

  test("fails on empty string", () => {
    const result = parseSub("");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("empty");
    }
  });

  test("fails on unrecognized prefix", () => {
    const result = parseSub("unknown:self:id");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("unrecognized");
    }
  });

  test("fails on actor with too few parts", () => {
    const result = parseSub("actor:self");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("unrecognized");
    }
  });

  test("fails on actor with too many parts", () => {
    const result = parseSub("actor:self:principal:extra");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("unrecognized");
    }
  });

  test("fails on actor with empty assistantId", () => {
    const result = parseSub("actor::principal-abc");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("empty");
    }
  });

  test("fails on actor with empty actorPrincipalId", () => {
    const result = parseSub("actor:self:");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("empty");
    }
  });

  test("fails on svc:gateway with empty assistantId", () => {
    const result = parseSub("svc:gateway:");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("empty");
    }
  });

  test("fails on svc with wrong second part", () => {
    const result = parseSub("svc:other:self");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("unrecognized");
    }
  });

  test("fails on local with empty sessionId", () => {
    const result = parseSub("local:self:");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("empty");
    }
  });

  test("fails on local with empty assistantId", () => {
    const result = parseSub("local::session-abc");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("empty");
    }
  });

  test("fails on bare prefix with no colons", () => {
    const result = parseSub("actor");
    expect(result.ok).toBe(false);
  });
});
