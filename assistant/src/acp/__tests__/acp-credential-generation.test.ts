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
  claudeCredentialStillCurrent,
  claudeTokenDigest,
  configClaudeCredentialStillCurrent,
  configClaudeTokenSuperseded,
  currentClaudeCredentialGeneration,
  noteConfigClaudeTokenRejected,
  retireAcpAuthRecovery,
  rollbackStoredClaudeTokenDigest,
  setStoredClaudeTokenDigest,
} from "../acp-auth-marker-store.js";

describe("claudeCredentialStillCurrent", () => {
  test("a run holding the stored token is current", () => {
    setStoredClaudeTokenDigest(claudeTokenDigest("sk-ant-oat-live"));

    expect(
      claudeCredentialStillCurrent(claudeTokenDigest("sk-ant-oat-live")),
    ).toBe(true);
  });

  test("a run holding a replaced token is superseded", () => {
    setStoredClaudeTokenDigest(claudeTokenDigest("sk-ant-oat-new"));

    expect(
      claudeCredentialStillCurrent(claudeTokenDigest("sk-ant-oat-old")),
    ).toBe(false);
  });

  test("a run with no recorded identity is treated as current", () => {
    // Proves nothing about supersession, and this path must fail toward
    // leaving the user a route back to auth.
    setStoredClaudeTokenDigest(claudeTokenDigest("sk-ant-oat-live"));

    expect(claudeCredentialStillCurrent(undefined)).toBe(true);
  });

  test("nothing written in this process means nothing is superseded", () => {
    setStoredClaudeTokenDigest(undefined);

    expect(
      claudeCredentialStillCurrent(claudeTokenDigest("sk-ant-oat-any")),
    ).toBe(true);
  });

  test("a restored digest describes the token that is actually published", () => {
    // A failed write puts back what the cache said before, so a run holding
    // the still-stored token is not misread as superseded.
    setStoredClaudeTokenDigest(claudeTokenDigest("sk-ant-oat-live"));
    const previous = setStoredClaudeTokenDigest(
      claudeTokenDigest("sk-ant-oat-never-published"),
    );
    setStoredClaudeTokenDigest(previous);

    expect(
      claudeCredentialStillCurrent(claudeTokenDigest("sk-ant-oat-live")),
    ).toBe(true);
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

describe("rollbackStoredClaudeTokenDigest", () => {
  test("undoes a claim whose write never landed", () => {
    setStoredClaudeTokenDigest(claudeTokenDigest("sk-ant-oat-live"));
    const claimed = claudeTokenDigest("sk-ant-oat-failed");
    const previous = setStoredClaudeTokenDigest(claimed);

    rollbackStoredClaudeTokenDigest(claimed, previous);

    expect(
      claudeCredentialStillCurrent(claudeTokenDigest("sk-ant-oat-live")),
    ).toBe(true);
  });

  test("a late rollback cannot clobber a newer successful claim", () => {
    // Write A claims, write B claims and publishes, then A fails. An
    // unconditional restore would leave the cache describing a token older
    // than what storage holds, so a run using B's token would read as
    // superseded and lose its recovery.
    setStoredClaudeTokenDigest(claudeTokenDigest("sk-ant-oat-original"));
    const claimedA = claudeTokenDigest("sk-ant-oat-a");
    const previousA = setStoredClaudeTokenDigest(claimedA);
    setStoredClaudeTokenDigest(claudeTokenDigest("sk-ant-oat-b"));

    rollbackStoredClaudeTokenDigest(claimedA, previousA);

    expect(
      claudeCredentialStillCurrent(claudeTokenDigest("sk-ant-oat-b")),
    ).toBe(true);
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
  /**
   * The claim-then-confirm pair `secure-keys` wraps each write in: the claim
   * runs before the token is published, the confirm in the continuation of the
   * `set()` that published it.
   */
  function claim(token: string) {
    const digest = claudeTokenDigest(token);
    setStoredClaudeTokenDigest(digest);
    return { digest, confirm: () => setStoredClaudeTokenDigest(digest) };
  }

  test("the write that lands last owns the cache", () => {
    // Both writes start, then B publishes before A. Storage ends up holding
    // A, so a run carrying A must not read as superseded. The claims record
    // only the order the writes started, which here is the reverse of the
    // order they landed; the confirms are what put the cache back in landing
    // order.
    const a = claim("sk-ant-oat-slow");
    const b = claim("sk-ant-oat-fast");

    b.confirm();
    a.confirm();

    expect(claudeCredentialStillCurrent(a.digest)).toBe(true);
    expect(claudeCredentialStillCurrent(b.digest)).toBe(false);
  });
});
