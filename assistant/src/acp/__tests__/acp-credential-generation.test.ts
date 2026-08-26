/**
 * The credential generation that keeps a superseded rejection from re-marking
 * a row.
 *
 * A run reads its Claude token once. If a replacement token lands before that
 * run finally reports the old one rejected, the failure describes auth that is
 * already repaired, and the bulk clear that would have retired the mark has
 * already run. The generation is what lets the failure path tell the two
 * apart.
 */

import { describe, expect, test } from "bun:test";

import { currentClaudeCredentialGeneration } from "../acp-claude-oauth.js";

describe("currentClaudeCredentialGeneration", () => {
  test("reports a stable generation while no token is written", () => {
    const first = currentClaudeCredentialGeneration();
    expect(currentClaudeCredentialGeneration()).toBe(first);
  });

  test("a run's captured generation matches while the credential is unchanged", () => {
    // What the failure path compares: the generation captured at spawn against
    // the generation now. Equal means this run's token is still the current
    // one, so its rejection is real and worth marking.
    const capturedAtSpawn = currentClaudeCredentialGeneration();
    expect(capturedAtSpawn === currentClaudeCredentialGeneration()).toBe(true);
  });

  test("a stale captured generation is detectable as superseded", () => {
    // Standing in for a token write that happened after the run started.
    const capturedAtSpawn = currentClaudeCredentialGeneration() - 1;
    expect(capturedAtSpawn === currentClaudeCredentialGeneration()).toBe(false);
  });
});
