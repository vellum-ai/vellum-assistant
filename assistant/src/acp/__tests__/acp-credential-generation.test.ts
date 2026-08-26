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
  claimPendingClaudeTokenDigest,
  claudeCredentialStillCurrent,
  claudeTokenDigest,
  configClaudeCredentialStillCurrent,
  configClaudeTokenSuperseded,
  currentClaudeCredentialGeneration,
  dropPendingClaudeTokenDigest,
  noteConfigClaudeTokenRejected,
  publishClaudeTokenDigest,
  retireAcpAuthRecovery,
} from "../acp-auth-marker-store.js";

describe("claudeCredentialStillCurrent", () => {
  test("a run holding the published token is current", () => {
    publishClaudeTokenDigest(claudeTokenDigest("sk-ant-oat-live"));

    expect(
      claudeCredentialStillCurrent(claudeTokenDigest("sk-ant-oat-live")),
    ).toBe(true);
  });

  test("a run holding a replaced token is superseded", () => {
    publishClaudeTokenDigest(claudeTokenDigest("sk-ant-oat-new"));

    expect(
      claudeCredentialStillCurrent(claudeTokenDigest("sk-ant-oat-old")),
    ).toBe(false);
  });

  test("a run with no recorded identity is treated as current", () => {
    // Proves nothing about supersession, and this path must fail toward
    // leaving the user a route back to auth.
    publishClaudeTokenDigest(claudeTokenDigest("sk-ant-oat-live"));

    expect(claudeCredentialStillCurrent(undefined)).toBe(true);
  });
});

describe("claudeCredentialStillCurrent while a write is in flight", () => {
  test("a run that read the incoming token is current before the write returns", () => {
    // The claim is what covers this. Storage may already hold the incoming
    // token, and without the claim the run carrying it would not match the
    // published digest and would read as superseded.
    publishClaudeTokenDigest(claudeTokenDigest("sk-ant-oat-outgoing"));
    const incoming = claudeTokenDigest("sk-ant-oat-incoming");
    claimPendingClaudeTokenDigest(incoming);

    expect(claudeCredentialStillCurrent(incoming)).toBe(true);
  });

  test("a run holding the outgoing token is current until the write lands", () => {
    // The write has not returned, so storage may still hold the outgoing
    // token. Suppressing here and then failing the write would leave the user
    // holding a rejected credential with no card and no later event to raise
    // one.
    const outgoing = claudeTokenDigest("sk-ant-oat-outgoing");
    publishClaudeTokenDigest(outgoing);
    claimPendingClaudeTokenDigest(claudeTokenDigest("sk-ant-oat-incoming"));

    expect(claudeCredentialStillCurrent(outgoing)).toBe(true);
  });

  test("a failed write leaves the published answer untouched", () => {
    const outgoing = claudeTokenDigest("sk-ant-oat-outgoing");
    publishClaudeTokenDigest(outgoing);
    const neverLanded = claudeTokenDigest("sk-ant-oat-never-landed");
    claimPendingClaudeTokenDigest(neverLanded);

    dropPendingClaudeTokenDigest(neverLanded);

    expect(claudeCredentialStillCurrent(outgoing)).toBe(true);
    expect(claudeCredentialStillCurrent(neverLanded)).toBe(false);
  });

  test("two writers of the same token do not drop each other's claim", () => {
    publishClaudeTokenDigest(claudeTokenDigest("sk-ant-oat-outgoing"));
    const shared = claudeTokenDigest("sk-ant-oat-shared");
    claimPendingClaudeTokenDigest(shared);
    claimPendingClaudeTokenDigest(shared);

    dropPendingClaudeTokenDigest(shared);

    expect(claudeCredentialStillCurrent(shared)).toBe(true);
  });
});

describe("config token supersession", () => {
  const TOKEN_A = "sk-ant-oat-alias-a";
  const TOKEN_B = "sk-ant-oat-alias-b";

  test("a configured token stands down only after a later write", () => {
    // Config wins over the vault, so a revoked configured token would resolve
    // again on every retry and loop the Connect card. The rejection records
    // itself; the next real write is what stands the config value down.
    noteConfigClaudeTokenRejected(TOKEN_A, currentClaudeCredentialGeneration());

    expect(configClaudeTokenSuperseded(TOKEN_A)).toBe(false);

    retireAcpAuthRecovery();

    expect(configClaudeTokenSuperseded(TOKEN_A)).toBe(true);
  });

  test("stays superseded across later spawns, not just the first", () => {
    // A revoked value the user never removes from config is resolved by every
    // later spawn too, so consuming the record would spare only the first and
    // let the next reopen the Connect loop.
    noteConfigClaudeTokenRejected(TOKEN_A, currentClaudeCredentialGeneration());
    retireAcpAuthRecovery();

    expect(configClaudeTokenSuperseded(TOKEN_A)).toBe(true);
    expect(configClaudeTokenSuperseded(TOKEN_A)).toBe(true);
    expect(configClaudeTokenSuperseded(TOKEN_A)).toBe(true);
  });

  test("a config value the user actually fixes is trusted on sight", () => {
    // Retention is safe because the key is the token: a different value hashes
    // differently and was never recorded.
    noteConfigClaudeTokenRejected(TOKEN_A, currentClaudeCredentialGeneration());
    retireAcpAuthRecovery();

    expect(configClaudeTokenSuperseded("sk-ant-oat-alias-a-fixed")).toBe(false);
  });

  test("one alias's rejected token does not stand down another's", () => {
    // A process-global one-shot was consumed by whichever alias prepared
    // first, discarding its good token and leaving the rejected one trusted.
    noteConfigClaudeTokenRejected(TOKEN_A, currentClaudeCredentialGeneration());
    retireAcpAuthRecovery();

    expect(configClaudeTokenSuperseded(TOKEN_B)).toBe(false);
    expect(configClaudeTokenSuperseded(TOKEN_A)).toBe(true);
  });

  test("reports no supersession for a token never rejected", () => {
    retireAcpAuthRecovery();

    expect(configClaudeTokenSuperseded("sk-ant-oat-never-seen")).toBe(false);
  });
});

describe("config rejection recorded against the injection generation", () => {
  test("a write between injection and rejection counts as the replacement", () => {
    // The run took the configured value at generation G. A replacement landed
    // while it was still running. Recording the rejection at the failure's own
    // generation would compare G+1 against G+1 and call the revoked value
    // trustworthy.
    const atInjection = currentClaudeCredentialGeneration();
    retireAcpAuthRecovery();
    noteConfigClaudeTokenRejected("sk-ant-oat-config-raced", atInjection);

    expect(configClaudeTokenSuperseded("sk-ant-oat-config-raced")).toBe(true);
  });
});

describe("a claim never displaces the published answer", () => {
  test("a write still in flight cannot suppress a rejection of the stored token", () => {
    // The window this closes: the claim used to overwrite the answer outright,
    // so a run rejecting the token storage still held read as superseded. If
    // the write then failed there was no second rejection to raise the card
    // from, and rolling the answer back afterwards could not recreate it.
    const stored = claudeTokenDigest("sk-ant-oat-stored");
    publishClaudeTokenDigest(stored);
    const inFlight = claudeTokenDigest("sk-ant-oat-in-flight");
    claimPendingClaudeTokenDigest(inFlight);

    expect(claudeCredentialStillCurrent(stored)).toBe(true);

    dropPendingClaudeTokenDigest(inFlight);

    expect(claudeCredentialStillCurrent(stored)).toBe(true);
  });

  test("a late discard cannot clobber a newer successful write", () => {
    // Write A claims, write B claims and publishes, then A fails. A discard
    // has nothing to restore, so B's published answer stands and a run using
    // B's token keeps its recovery.
    publishClaudeTokenDigest(claudeTokenDigest("sk-ant-oat-original"));
    const claimedA = claudeTokenDigest("sk-ant-oat-a");
    const claimedB = claudeTokenDigest("sk-ant-oat-b");
    claimPendingClaudeTokenDigest(claimedA);
    claimPendingClaudeTokenDigest(claimedB);
    publishClaudeTokenDigest(claimedB);

    dropPendingClaudeTokenDigest(claimedA);

    expect(claudeCredentialStillCurrent(claimedB)).toBe(true);
    expect(
      claudeCredentialStillCurrent(claudeTokenDigest("sk-ant-oat-original")),
    ).toBe(false);
  });
});

describe("configClaudeCredentialStillCurrent", () => {
  test("a config run is current while nothing has been written since", () => {
    const atInjection = currentClaudeCredentialGeneration();

    expect(configClaudeCredentialStillCurrent(atInjection)).toBe(true);
  });

  test("a config run whose value a later write replaced is superseded", () => {
    // The user completed Connect while this run was still going. The write
    // already swept the cards and markers and stood the config value down for
    // the next spawn, so recreating a card from this rejection reopens the
    // loop the write just closed.
    const atInjection = currentClaudeCredentialGeneration();
    retireAcpAuthRecovery();

    expect(configClaudeCredentialStillCurrent(atInjection)).toBe(false);
  });

  test("no captured generation is treated as current", () => {
    retireAcpAuthRecovery();

    expect(configClaudeCredentialStillCurrent(undefined)).toBe(true);
  });

  test("agrees with the supersession the same rejection records", () => {
    // The recovery guard and the next spawn's source choice must not disagree:
    // suppressing the card while still trusting the configured token would
    // leave the run failing with no route back to auth.
    const atInjection = currentClaudeCredentialGeneration();
    noteConfigClaudeTokenRejected("sk-ant-oat-config-agree", atInjection);
    retireAcpAuthRecovery();

    expect(configClaudeCredentialStillCurrent(atInjection)).toBe(
      !configClaudeTokenSuperseded("sk-ant-oat-config-agree"),
    );
  });
});

describe("overlapping writes settle in resolution order", () => {
  test("the write that lands last owns the answer", () => {
    // Both writes start, then B publishes before A. Storage ends up holding
    // A, so a run carrying A must not read as superseded. The claims record
    // only the order the writes started, which here is the reverse of the
    // order they landed; publishing in the continuation of each `set()` is
    // what puts the answer back in landing order.
    const slow = claudeTokenDigest("sk-ant-oat-slow");
    const fast = claudeTokenDigest("sk-ant-oat-fast");
    claimPendingClaudeTokenDigest(slow);
    claimPendingClaudeTokenDigest(fast);

    publishClaudeTokenDigest(fast);
    publishClaudeTokenDigest(slow);

    expect(claudeCredentialStillCurrent(slow)).toBe(true);
    expect(claudeCredentialStillCurrent(fast)).toBe(false);
  });
});
