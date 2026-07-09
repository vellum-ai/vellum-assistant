import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

// ── Module mocks ─────────────────────────────────────────────────────

let fakeHttpAuthDisabled = false;

mock.module("../config/env.js", () => ({
  isHttpAuthDisabled: () => fakeHttpAuthDisabled,
  hasUngatedHttpAuthDisabled: () => false,
}));

// ── Real imports (after mocks) ───────────────────────────────────────

import {
  FALLBACK_TURN_TRUST,
  mapChatTypeToConversationType,
  resolveTrustClass,
} from "../daemon/trust-context.js";
import type { TrustContext } from "../daemon/trust-context-types.js";

afterAll(() => {
  mock.restore();
});

// ── Tests ────────────────────────────────────────────────────────────

describe("resolveTrustClass", () => {
  beforeEach(() => {
    fakeHttpAuthDisabled = false;
  });

  test("returns guardian context trust class when auth is enabled", () => {
    const ctx: Pick<TrustContext, "trustClass"> = {
      trustClass: "trusted_contact",
    };
    expect(resolveTrustClass(ctx as TrustContext)).toBe("trusted_contact");
  });

  test("returns 'unknown' when trustContext is undefined", () => {
    expect(resolveTrustClass(undefined)).toBe("unknown");
  });

  test("does not elevate a resolved non-guardian actor when HTTP auth is disabled", () => {
    // DISABLE_HTTP_AUTH is the standing config in platform-managed deployments,
    // so a resolved channel actor's class must survive it — otherwise a
    // non-guardian Slack/phone contact would be treated as the guardian
    // (LUM-2669). Only an unresolved (local/native) turn is elevated; see below.
    fakeHttpAuthDisabled = true;
    expect(
      resolveTrustClass({ trustClass: "trusted_contact" } as TrustContext),
    ).toBe("trusted_contact");
    expect(resolveTrustClass({ trustClass: "unknown" } as TrustContext)).toBe(
      "unknown",
    );
  });

  test("treats an unresolved (local/native) turn as guardian when HTTP auth is disabled", () => {
    // Local/native turns reach the daemon without a channel-resolved
    // trustContext; in an auth-disabled (local) deployment that actor is the
    // guardian, so control-plane gates don't block local development.
    fakeHttpAuthDisabled = true;
    expect(resolveTrustClass(undefined)).toBe("guardian");
  });

  test("does not elevate the FALLBACK_TURN_TRUST snapshot to guardian when HTTP auth is disabled", () => {
    // conversation-tool-setup substitutes FALLBACK_TURN_TRUST (a *present*,
    // unknown-class context) when no per-turn snapshot has been captured. Because
    // it is a resolved context -- not `undefined` -- the dev-bypass must not
    // elevate it: the fallback's documented bias-to-unknown has to survive
    // DISABLE_HTTP_AUTH so a missing snapshot can't grant guardian trust. This is
    // the fail-safe sibling to LUM-2665; see LUM-2669.
    fakeHttpAuthDisabled = true;
    expect(resolveTrustClass(FALLBACK_TURN_TRUST)).toBe("unknown");
  });
});

describe("mapChatTypeToConversationType", () => {
  test("maps DM-shaped chat types to dm", () => {
    expect(mapChatTypeToConversationType("im")).toBe("dm"); // Slack DM
    expect(mapChatTypeToConversationType("private")).toBe("dm"); // Telegram DM
  });

  test("maps closed-group chat types to private", () => {
    expect(mapChatTypeToConversationType("mpim")).toBe("private"); // Slack multi-party DM
    expect(mapChatTypeToConversationType("group")).toBe("private");
    expect(mapChatTypeToConversationType("supergroup")).toBe("private");
  });

  test("maps Slack 'channel' to undefined — public and private are indistinguishable", () => {
    // The gateway forwards every non-DM Slack conversation as "channel"
    // without a public/private distinction. Mapping it to "public" would let
    // a permissive public-channel matrix cell govern private channels, so
    // the channel-type tier must not match at all.
    expect(mapChatTypeToConversationType("channel")).toBeUndefined();
  });

  test("maps unknown or absent chat types to undefined", () => {
    expect(mapChatTypeToConversationType(undefined)).toBeUndefined();
    expect(mapChatTypeToConversationType("")).toBeUndefined();
    expect(mapChatTypeToConversationType("broadcast")).toBeUndefined();
  });
});
