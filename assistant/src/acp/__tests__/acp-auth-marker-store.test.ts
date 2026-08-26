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

import { initializeDb } from "../../persistence/db-init.js";
import {
  acpAuthMarkerStillCurrent,
  claudeTokenDigest,
  claudeTokenRefusedByClaude,
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

  beforeEach(() => {
    clearHistory();
  });

  function refusalRow(overrides: Record<string, unknown> = {}) {
    insertHistoryRow({
      id: "run-refused",
      status: "failed",
      authErrorCode: "acp_claude_auth_required",
      authErrorCredential: claudeTokenDigest(CONFIG_TOKEN),
      ...overrides,
    });
  }

  test("reports a token Claude refused on some run", () => {
    refusalRow();

    expect(claudeTokenRefusedByClaude(CONFIG_TOKEN)).toBe(true);
  });

  test("reports nothing for a token no run was refused on", () => {
    refusalRow();

    expect(claudeTokenRefusedByClaude("sk-ant-oat-never-tried")).toBe(false);
  });

  test("one alias's refused token says nothing about another's", () => {
    // A global one-shot would let whichever alias prepared first consume the
    // record, discarding its own good token and re-trusting the bad one.
    refusalRow();

    expect(claudeTokenRefusedByClaude("sk-ant-oat-other-alias")).toBe(false);
  });

  test("survives a restart, because the record is the row not a cache", () => {
    // The refusal outlives the process that saw it. A configured token lives
    // in config, so a daemon restart would otherwise trust the revoked value
    // on sight again and reopen the Connect loop.
    refusalRow();

    expect(claudeTokenRefusedByClaude(CONFIG_TOKEN)).toBe(true);
    expect(claudeTokenRefusedByClaude(CONFIG_TOKEN)).toBe(true);
  });

  test("a row with a credential but no failure code is not a refusal", () => {
    refusalRow({ authErrorCode: null });

    expect(claudeTokenRefusedByClaude(CONFIG_TOKEN)).toBe(false);
  });
});
