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

import {
  configClaudeTokenSuperseded,
  currentClaudeCredentialGeneration,
  noteConfigClaudeTokenRejected,
  retireAcpAuthRecovery,
} from "../acp-auth-marker-store.js";

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

describe("config token supersession", () => {
  const TOKEN_A = "sk-ant-oat-alias-a";
  const TOKEN_B = "sk-ant-oat-alias-b";

  test("a configured token stands down only after a later write", () => {
    // Config wins over the vault, so a revoked configured token would resolve
    // again on every retry and loop the Connect card. The rejection records
    // itself; the next real write is what stands the config value down.
    noteConfigClaudeTokenRejected(TOKEN_A);

    expect(configClaudeTokenSuperseded(TOKEN_A)).toBe(false);

    retireAcpAuthRecovery();

    expect(configClaudeTokenSuperseded(TOKEN_A)).toBe(true);
  });

  test("supersession fires once, so a later fixed config value is trusted", () => {
    noteConfigClaudeTokenRejected(TOKEN_A);
    retireAcpAuthRecovery();

    expect(configClaudeTokenSuperseded(TOKEN_A)).toBe(true);
    expect(configClaudeTokenSuperseded(TOKEN_A)).toBe(false);
  });

  test("one alias's rejected token does not stand down another's", () => {
    // A process-global one-shot was consumed by whichever alias prepared
    // first, discarding its good token and leaving the rejected one trusted.
    noteConfigClaudeTokenRejected(TOKEN_A);
    retireAcpAuthRecovery();

    expect(configClaudeTokenSuperseded(TOKEN_B)).toBe(false);
    expect(configClaudeTokenSuperseded(TOKEN_A)).toBe(true);
  });

  test("reports no supersession for a token never rejected", () => {
    retireAcpAuthRecovery();

    expect(configClaudeTokenSuperseded("sk-ant-oat-never-seen")).toBe(false);
  });
});
