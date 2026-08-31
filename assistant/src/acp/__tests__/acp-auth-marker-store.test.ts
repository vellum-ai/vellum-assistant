/**
 * A credential-failure marker answers for itself whether it is still worth
 * showing a Connect card for.
 *
 * The question is always the same: is the credential this failure names still
 * the one a spawn would resolve? Nothing is remembered between the failure and
 * the read, and nothing has to run at the right moment for a repaired failure
 * to stop rendering, which is what a retirement sweep needed and what a daemon
 * restart used to lose.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import { getSqlite } from "../../persistence/db-connection.js";
import { initializeDb } from "../../persistence/db-init.js";
import {
  acpAuthMarkerStillCurrent,
  claudeTokenDigest,
  claudeTokenRefusedByClaude,
  conversationHasCurrentAcpMarker,
  noteClaudeTokenRefused,
} from "../acp-auth-marker-store.js";
import { clearHistory, insertHistoryRow } from "./helpers/acp-history-db.js";

await initializeDb();

describe("acpAuthMarkerStillCurrent", () => {
  const REFUSED = claudeTokenDigest("sk-ant-oat-refused");
  const REPLACEMENT = claudeTokenDigest("sk-ant-oat-replacement");

  test("a marker naming the credential still in use is served", () => {
    expect(acpAuthMarkerStillCurrent(REFUSED, REFUSED)).toBe(true);
  });

  test("a marker naming a credential since replaced is withheld", () => {
    // The user completed Connect. The card exists to send them there, so it
    // has nothing left to say.
    expect(acpAuthMarkerStillCurrent(REFUSED, REPLACEMENT)).toBe(false);
  });

  test("a marker with no credential named is served", () => {
    // Predates the column, or came from a path that had no token to name. An
    // unknown credential is no evidence the failure was repaired, and this
    // path fails toward leaving the user a route back to auth.
    expect(acpAuthMarkerStillCurrent(null, REPLACEMENT)).toBe(true);
    expect(acpAuthMarkerStillCurrent(undefined, REPLACEMENT)).toBe(true);
  });

  test("an empty vault serves the marker rather than hiding it", () => {
    // Nothing replaced the refused token, so the failure it names still
    // stands.
    expect(acpAuthMarkerStillCurrent(REFUSED, undefined)).toBe(true);
  });

  test("the same answer however many times it is asked", () => {
    // No state advances on a read, so a second client asking gets what the
    // first did. The sweep this replaced could only be run once.
    expect(acpAuthMarkerStillCurrent(REFUSED, REPLACEMENT)).toBe(false);
    expect(acpAuthMarkerStillCurrent(REFUSED, REPLACEMENT)).toBe(false);
    expect(acpAuthMarkerStillCurrent(REFUSED, REFUSED)).toBe(true);
  });
});

describe("claudeTokenDigest", () => {
  test("is stable and does not carry the token", () => {
    const token = "sk-ant-oat-example";
    const digest = claudeTokenDigest(token);

    expect(digest).toBe(claudeTokenDigest(token));
    expect(digest).not.toContain(token);
    expect(digest).toHaveLength(32);
  });

  test("separates one alias's token from another's", () => {
    expect(claudeTokenDigest("sk-ant-oat-a")).not.toBe(
      claudeTokenDigest("sk-ant-oat-b"),
    );
  });
});

describe("claudeTokenRefusedByClaude", () => {
  const CONFIG_TOKEN = "sk-ant-oat-from-config";
  const DIGEST = claudeTokenDigest(CONFIG_TOKEN);

  beforeEach(() => {
    clearHistory();
    getSqlite().run("DELETE FROM acp_refused_credentials");
  });

  test("reports a token Claude refused", () => {
    noteClaudeTokenRefused(DIGEST, 1000);

    expect(claudeTokenRefusedByClaude(CONFIG_TOKEN)).toBe(true);
  });

  test("reports nothing for a token never refused", () => {
    noteClaudeTokenRefused(DIGEST, 1000);

    expect(claudeTokenRefusedByClaude("sk-ant-oat-never-tried")).toBe(false);
  });

  test("one alias's refused token says nothing about another's", () => {
    // A global one-shot would let whichever alias prepared first consume the
    // record, discarding its own good token and re-trusting the bad one.
    noteClaudeTokenRefused(DIGEST, 1000);

    expect(claudeTokenRefusedByClaude("sk-ant-oat-other-alias")).toBe(false);
  });

  test("survives clearing ACP session history", () => {
    // Deleting a run must not change which credential the next spawn picks.
    // Held on the run row, a bulk clear (which sweeps failed rows too) would
    // put the revoked configured token back in play against the vault
    // replacement the user just connected.
    noteClaudeTokenRefused(DIGEST, 1000);
    insertHistoryRow({
      id: "run-refused",
      status: "failed",
      authErrorCode: "acp_claude_auth_required",
      authErrorCredential: DIGEST,
    });

    clearHistory();

    expect(claudeTokenRefusedByClaude(CONFIG_TOKEN)).toBe(true);
  });

  test("recording the same refusal twice is not an error", () => {
    // Every retry of a revoked configured token refuses the same digest.
    noteClaudeTokenRefused(DIGEST, 1000);
    noteClaudeTokenRefused(DIGEST, 2000);

    expect(claudeTokenRefusedByClaude(CONFIG_TOKEN)).toBe(true);
  });

  test("a run that carried no credential records nothing", () => {
    noteClaudeTokenRefused(undefined, 1000);

    expect(claudeTokenRefusedByClaude(CONFIG_TOKEN)).toBe(false);
  });
});

describe("conversationHasCurrentAcpMarker", () => {
  const REFUSED = claudeTokenDigest("sk-ant-oat-refused");

  beforeEach(() => {
    clearHistory();
  });

  test("false for a conversation that has never failed", async () => {
    expect(await conversationHasCurrentAcpMarker("conv-clean")).toBe(false);
  });

  test("true while a marker names the credential a spawn would resolve", async () => {
    // No vault token in this suite, so the resolver reports none and the
    // comparison treats an unknown as no evidence of repair.
    insertHistoryRow({
      id: "run-marked",
      parentConversationId: "conv-marked",
      status: "failed",
      authErrorCode: "acp_claude_auth_required",
      authErrorCredential: REFUSED,
    });

    expect(await conversationHasCurrentAcpMarker("conv-marked")).toBe(true);
  });

  test("false for a conversation whose rows carry no marker", async () => {
    insertHistoryRow({
      id: "run-plain",
      parentConversationId: "conv-plain",
      status: "completed",
    });

    expect(await conversationHasCurrentAcpMarker("conv-plain")).toBe(false);
  });

  test("scoped to its own conversation", async () => {
    insertHistoryRow({
      id: "run-elsewhere",
      parentConversationId: "conv-other",
      status: "failed",
      authErrorCode: "acp_claude_auth_required",
      authErrorCredential: REFUSED,
    });

    expect(await conversationHasCurrentAcpMarker("conv-asked-about")).toBe(
      false,
    );
  });
});
