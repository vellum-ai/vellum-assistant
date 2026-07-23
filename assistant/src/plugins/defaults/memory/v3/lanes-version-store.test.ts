/**
 * Tests for `lanes-version-store.ts` — the plugin-owned, cross-process
 * lanes-version token.
 *
 * The store's whole job is to carry an invalidation signal between the daemon
 * and the memory worker over the shared workspace volume, so the load-bearing
 * assertion is the round-trip: a token written through one call is observed by a
 * later read that resolves the same workspace dir (standing in for the other
 * process). Uses a real temp workspace — no mocks — so the atomic file write and
 * its absent/unreadable branches are exercised end-to-end.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { bumpLanesVersion, readLanesVersion } from "./lanes-version-store.js";

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "lanes-version-store-"));
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

describe("lanes-version-store", () => {
  test("read returns null when no token has been written", () => {
    // Absent file carries the same meaning an absent value did before: a
    // legitimate stable state, not a read failure.
    expect(readLanesVersion(workspaceDir)).toBeNull();
  });

  test("a bump is observed by a later read of the same workspace (cross-process round-trip)", () => {
    // The writer (memory worker) bumps; a reader (daemon) resolving the same
    // workspace dir sees the new token. `bumpLanesVersion` also creates the
    // `memory/.v2-state/` state dir on demand.
    const token = bumpLanesVersion(workspaceDir);
    expect(token).toBeTruthy();
    expect(readLanesVersion(workspaceDir)).toBe(token);
  });

  test("each bump writes a distinct token", () => {
    const first = bumpLanesVersion(workspaceDir);
    const second = bumpLanesVersion(workspaceDir);
    expect(second).not.toBe(first);
    expect(readLanesVersion(workspaceDir)).toBe(second);
  });

  test("read returns undefined when the token path is unreadable", () => {
    // A directory at the token path makes the read throw EISDIR (not ENOENT):
    // the "cannot judge staleness" signal, distinct from an absent token.
    mkdirSync(join(workspaceDir, "memory", ".v2-state", "lanes-version"), {
      recursive: true,
    });
    expect(readLanesVersion(workspaceDir)).toBeUndefined();
  });
});
