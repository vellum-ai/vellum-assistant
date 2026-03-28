/**
 * Tests that PairingStore.register() rejects a second pairing registration
 * while one is already in progress (status: registered or pending).
 *
 * The /pair slash command generates a fresh pairingRequestId each time and
 * calls PairingStore.register(). The store should reject the second
 * registration when an active (non-terminal) pairing request already exists.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";

import { PairingStore } from "../daemon/pairing-store.js";

// ── Helpers ──────────────────────────────────────────────────────────────

const GATEWAY_URL = "https://gateway.test";

function buildRegisterParams() {
  return {
    pairingRequestId: randomUUID(),
    pairingSecret: randomBytes(32).toString("hex"),
    gatewayUrl: GATEWAY_URL,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("PairingStore.register — concurrent pairing guard", () => {
  let store: PairingStore;
  let tmpBase: string;
  let origWorkspaceDir: string | undefined;

  beforeAll(() => {
    // Isolate disk writes to a temp directory so this test does not
    // pollute ~/.vellum or interfere with other test files.
    tmpBase = mkdtempSync(join(tmpdir(), "pairing-test-"));
    origWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR;
    process.env.VELLUM_WORKSPACE_DIR = tmpBase;
  });

  afterAll(() => {
    if (origWorkspaceDir === undefined) {
      delete process.env.VELLUM_WORKSPACE_DIR;
    } else {
      process.env.VELLUM_WORKSPACE_DIR = origWorkspaceDir;
    }
    rmSync(tmpBase, { recursive: true, force: true });
  });

  beforeEach(() => {
    store = new PairingStore();
  });

  test("rejects a second registration while one is already in progress", () => {
    /**
     * Tests that the store rejects a second pairing registration when
     * an active (registered/pending) pairing request already exists.
     */

    // GIVEN a first /pair command has registered a pairing request
    const firstParams = buildRegisterParams();
    const firstResult = store.register(firstParams);
    expect(firstResult.ok).toBe(true);

    // WHEN a second /pair command is issued (different pairingRequestId,
    // as each /pair invocation generates a fresh UUID)
    const secondParams = buildRegisterParams();
    const secondResult = store.register(secondParams);

    // THEN the second registration should be rejected because one is already active
    expect(secondResult.ok).toBe(false);
  });
});
