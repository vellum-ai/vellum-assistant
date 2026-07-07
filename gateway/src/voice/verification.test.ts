import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initGatewayDb, resetGatewayDb } from "../db/connection.js";
import { createInboundSession, getSessionById } from "../db/session-store.js";
import {
  findPendingPhoneSession,
  validateVerificationCode,
} from "./verification.js";

type PendingSession = Parameters<typeof validateVerificationCode>[0];

// ---------------------------------------------------------------------------
// Fixture setup
// ---------------------------------------------------------------------------

let testRoot: string;

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

async function setupTestDirs(): Promise<void> {
  testRoot = mkdtempSync(join(tmpdir(), "voice-verify-test-"));
  const securityDir = join(testRoot, "protected");
  mkdirSync(securityDir, { recursive: true });

  process.env.VELLUM_WORKSPACE_DIR = testRoot;
  process.env.GATEWAY_SECURITY_DIR = securityDir;

  await initGatewayDb();
}

function seedPendingSession(id: string, code: string): PendingSession {
  return createInboundSession({
    id,
    channel: "phone",
    challengeHash: hashSecret(code),
    expiresAt: Date.now() + 5 * 60 * 1000,
  });
}

function sessionStatus(id: string): string | undefined {
  return getSessionById(id)?.status;
}

beforeEach(async () => {
  await setupTestDirs();
});

afterEach(() => {
  resetGatewayDb();
  try {
    rmSync(testRoot, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

// ---------------------------------------------------------------------------
// findPendingPhoneSession — gateway DB read
// ---------------------------------------------------------------------------

describe("findPendingPhoneSession", () => {
  test("returns a gateway-seeded pending phone session", async () => {
    seedPendingSession("sess-lookup", "123456");

    const found = await findPendingPhoneSession();
    expect(found?.id).toBe("sess-lookup");
    expect(found?.status).toBe("pending");
    expect(found?.codeDigits).toBe(6);
  });

  test("returns null when no pending session exists", async () => {
    expect(await findPendingPhoneSession()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// validateVerificationCode — one-time-code consume semantics
// ---------------------------------------------------------------------------

describe("validateVerificationCode consume path", () => {
  const CODE = "123456";
  const FROM = "+15555550100";

  test("concurrent double-consume yields exactly one success", async () => {
    const session = seedPendingSession("sess-race", CODE);

    const [a, b] = await Promise.all([
      validateVerificationCode(session, CODE, FROM, 0),
      validateVerificationCode(session, CODE, FROM, 0),
    ]);

    const successes = [a, b].filter((r) => r.success);
    expect(successes).toHaveLength(1);
    expect(successes[0]!.verificationType).toBe("guardian");

    // The losing consumer must report failure — never a second success.
    const failure = [a, b].find((r) => !r.success);
    expect(failure).toBeDefined();

    expect(sessionStatus("sess-race")).toBe("consumed");
  });

  test("already-consumed session fails DTMF verification", async () => {
    const session = seedPendingSession("sess-consumed", CODE);

    const first = await validateVerificationCode(session, CODE, FROM, 0);
    expect(first.success).toBe(true);

    // Re-entering the correct code against an already-consumed session must
    // fail — the status guard means the consume returns 0 rows changed.
    const second = await validateVerificationCode(session, CODE, FROM, 0);
    expect(second.success).toBe(false);

    expect(sessionStatus("sess-consumed")).toBe("consumed");
  });
});
