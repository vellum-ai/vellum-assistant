import { describe, expect, test } from "bun:test";

import {
  RESUMABLE_CLOSE_CODE,
  fatalCloseDiagnostic,
  isClientFaultCloseCode,
  recoveryActionForCloseCode,
} from "./close-codes.js";
import "../__tests__/test-preload.js";

describe("recoveryActionForCloseCode", () => {
  test("resumes on codes whose session survives", () => {
    for (const code of [4000, 4001, 4002, 4005, 4008]) {
      expect(recoveryActionForCloseCode(code)).toBe("resume");
    }
  });

  test("resumes on abnormal and absent closes", () => {
    // A dropped network closes without a code, which is the ordinary case.
    expect(recoveryActionForCloseCode(undefined)).toBe("resume");
    expect(recoveryActionForCloseCode(1006)).toBe("resume");
  });

  test("requires a fresh identify on 4003, 4007, and 4009", () => {
    // The official table marks these Reconnect: true, which reads as "you may
    // resume" and is not what it means — their session is gone, so a resume
    // returns op 9 and wastes a round trip.
    for (const code of [4003, 4007, 4009]) {
      expect(recoveryActionForCloseCode(code)).toBe("identify");
    }
  });

  test("never retries fatal codes", () => {
    // Each of these loops forever if retried, and a 4004 loop additionally
    // spends the identify budget toward a token reset.
    for (const code of [4004, 4010, 4011, 4012, 4013, 4014]) {
      expect(recoveryActionForCloseCode(code)).toBe("fatal");
    }
  });

  test("treats a normal close as session-invalidating", () => {
    // 1000/1001 tell Discord the client is finished with the session, so a
    // resume after one cannot succeed.
    expect(recoveryActionForCloseCode(1000)).toBe("identify");
    expect(recoveryActionForCloseCode(1001)).toBe("identify");
  });

  test("resumes on unknown codes rather than identifying", () => {
    // A resume against a dead session degrades safely to op 9 then IDENTIFY.
    // Identifying against a live session spends budget resuming would not.
    expect(recoveryActionForCloseCode(4999)).toBe("resume");
    expect(recoveryActionForCloseCode(1011)).toBe("resume");
  });

  test("the deliberate-close code is itself resumable", () => {
    // Zombie kills and clock-jump recoveries close with this code precisely so
    // the session survives; if it ever stopped being resumable those paths
    // would silently start costing an identify each.
    expect(recoveryActionForCloseCode(RESUMABLE_CLOSE_CODE)).toBe("resume");
    expect(RESUMABLE_CLOSE_CODE).not.toBe(1000);
    expect(RESUMABLE_CLOSE_CODE).not.toBe(1001);
  });
});

describe("isClientFaultCloseCode", () => {
  test("flags the codes that mean this client sent something wrong", () => {
    for (const code of [4001, 4002, 4005]) {
      expect(isClientFaultCloseCode(code)).toBe(true);
    }
  });

  test("does not flag ordinary or absent closes", () => {
    expect(isClientFaultCloseCode(4000)).toBe(false);
    expect(isClientFaultCloseCode(undefined)).toBe(false);
  });
});

describe("fatalCloseDiagnostic", () => {
  test("gives an operator action for every fatal code", () => {
    for (const code of [4004, 4010, 4011, 4012, 4013, 4014]) {
      expect(fatalCloseDiagnostic(code)).toBeTruthy();
    }
  });

  test("names the Portal toggle for a disallowed intent", () => {
    expect(fatalCloseDiagnostic(4014)).toContain("Developer Portal");
  });

  test("returns undefined for non-fatal codes", () => {
    expect(fatalCloseDiagnostic(4000)).toBeUndefined();
    expect(fatalCloseDiagnostic(undefined)).toBeUndefined();
  });
});
