/**
 * What a deferred wake's row must prove before its turn can recover the target
 * conversation's resting trust.
 *
 * The scheduler's due-tick has no caller: it cannot re-derive who chose the
 * wake's target or its trigger text, so the row itself has to carry that proof
 * in fields no update path can rewrite. Two independent conditions must hold,
 * and this file covers both plus every way each one fails.
 *
 * Authorization of the firing ITSELF (who may edit, enable, or trigger a wake
 * schedule) is a route concern and lives in `wake-schedule-escalation.test.ts`.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import { recoverRestingTrustContext } from "../daemon/conversation-resting-trust.js";
import {
  FALLBACK_TURN_TRUST,
  INTERNAL_GUARDIAN_TRUST_CONTEXT,
  resolveTrustClass,
} from "../daemon/trust-context.js";
import type { TrustContext } from "../daemon/trust-context-types.js";
import {
  createConversation,
  setConversationOriginChannelIfUnset,
} from "../persistence/conversation-crud.js";
import { getDb, getSqliteFrom } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import type { WakeOptions } from "../runtime/agent-wake.js";
import { resolveCapabilities } from "../runtime/capabilities.js";
import {
  LEGACY_DEFER_CREATED_BY,
  OWNER_DEFER_CREATED_BY,
} from "../schedule/defer-provenance.js";
import { buildWakeScheduleOptions } from "../schedule/wake-schedule-options.js";
import { resolveSensitiveToolDecision } from "../tools/tool-approval-handler.js";

await initializeDb();

const TARGET = "conv-guardian-owned";

/**
 * A row as `createOwnerDeferredWake` writes it: owner provenance, and a
 * source-conversation binding equal to the wake target.
 */
const OWNER_WAKE_JOB = {
  message: "Check back on this",
  inferenceProfile: null,
  createdBy: OWNER_DEFER_CREATED_BY,
  createdFromConversationId: TARGET,
};

/** A defer carrying legacy provenance, which records no author. */
const LEGACY_WAKE_JOB = {
  ...OWNER_WAKE_JOB,
  createdBy: LEGACY_DEFER_CREATED_BY,
};

/**
 * Write a raw `origin_channel` the canonical channel set does not contain, the
 * way a row from a newer build, a renamed channel id, or corrupted data would
 * look. `setConversationOriginChannelIfUnset` only accepts a `ChannelId`, so
 * this has to go in under the type system.
 */
function writeRawOriginChannel(conversationId: string, raw: string): void {
  getSqliteFrom(getDb()).run(
    "UPDATE conversations SET origin_channel = ? WHERE id = ?",
    [raw, conversationId],
  );
}

/**
 * The decision the sensitive-tool gate reaches for an invocation with the given
 * resting trust, with no channel approval cell to lift the floor. Absent trust
 * is what a wake with no `trustContext` resolves at tool-setup time
 * (`currentTurnTrustContext ?? trustContext ?? FALLBACK_TURN_TRUST`).
 */
function gateDecision(
  trustContext: TrustContext | null | undefined,
  reach: "sandbox" | "host",
): string {
  const { sensitiveToolApproval } = resolveCapabilities(
    resolveTrustClass(trustContext ?? FALLBACK_TURN_TRUST),
  );
  return resolveSensitiveToolDecision({
    reach,
    cellThreshold: undefined,
    sensitiveToolApproval,
  });
}

/** The gate decision a wake built with these options would reach for `bash`. */
function wakeGateDecision(options: WakeOptions): string {
  return gateDecision(options.trustContext, "sandbox");
}

describe("an owner-authored defer on a guardian-owned conversation", () => {
  beforeEach(() => {
    getDb().run("DELETE FROM messages");
    getDb().run("DELETE FROM conversations");
    createConversation({ id: TARGET });
  });

  test("recovers the target's guardian resting trust", () => {
    expect(buildWakeScheduleOptions(OWNER_WAKE_JOB, TARGET)).toEqual({
      conversationId: TARGET,
      hint: "Check back on this",
      source: "defer",
      persistTriggerAsEvent: true,
      trustContext: INTERNAL_GUARDIAN_TRUST_CONTEXT,
    });
  });

  test("clears the sensitive-tool gate at both reaches", () => {
    const options = buildWakeScheduleOptions(OWNER_WAKE_JOB, TARGET);

    // `bash` in the workspace sandbox and a host-reaching invocation alike.
    // This is what lets a resumed deferral keep using the tools it was using
    // when it deferred.
    expect(gateDecision(options.trustContext, "sandbox")).toBe("proceed");
    expect(gateDecision(options.trustContext, "host")).toBe("proceed");
  });

  test("the internal vellum channel counts as guardian-owned", () => {
    createConversation({ id: "conv-vellum" });
    setConversationOriginChannelIfUnset("conv-vellum", "vellum");

    expect(
      buildWakeScheduleOptions(
        { ...OWNER_WAKE_JOB, createdFromConversationId: "conv-vellum" },
        "conv-vellum",
      ),
    ).toHaveProperty("trustContext", INTERNAL_GUARDIAN_TRUST_CONTEXT);
  });

  test("the schedule's inference profile still rides along", () => {
    expect(
      buildWakeScheduleOptions(
        { ...OWNER_WAKE_JOB, inferenceProfile: "fast" },
        TARGET,
      ),
    ).toHaveProperty("forceOverrideProfile", "fast");
  });
});

describe("a row without owner provenance recovers nothing", () => {
  beforeEach(() => {
    getDb().run("DELETE FROM messages");
    getDb().run("DELETE FROM conversations");
    createConversation({ id: TARGET });
  });

  test("a legacy defer fails closed even on a guardian-owned target", () => {
    // A legacy row records no author for its target or text, so a retargeted
    // one is indistinguishable from an untouched one. Such rows keep firing;
    // they never recover trust.
    const options = buildWakeScheduleOptions(LEGACY_WAKE_JOB, TARGET);

    expect(options).not.toHaveProperty("trustContext");
    expect(wakeGateDecision(options)).toBe("deny");
  });

  test("an unmarked schedule fails closed", () => {
    const options = buildWakeScheduleOptions(
      { ...OWNER_WAKE_JOB, createdBy: "agent" },
      TARGET,
    );

    expect(options).not.toHaveProperty("trustContext");
    expect(wakeGateDecision(options)).toBe("deny");
  });

  test("a marked row whose source binding was never set fails closed", () => {
    const options = buildWakeScheduleOptions(
      { ...OWNER_WAKE_JOB, createdFromConversationId: null },
      TARGET,
    );

    expect(options).not.toHaveProperty("trustContext");
    expect(wakeGateDecision(options)).toBe("deny");
  });

  test("a marked row retargeted away from its source binding fails closed", () => {
    // The second half of the proof, standing on its own: even if the marker
    // survived and the route guard were bypassed or regressed, moving
    // `wakeConversationId` breaks the equality with the write-once source
    // binding, so the retargeted row cannot elevate.
    const options = buildWakeScheduleOptions(
      { ...OWNER_WAKE_JOB, createdFromConversationId: "conv-somewhere-else" },
      TARGET,
    );

    expect(options).not.toHaveProperty("trustContext");
    expect(wakeGateDecision(options)).toBe("deny");
  });
});

describe("target provenance still bounds an owner-authored defer", () => {
  beforeEach(() => {
    getDb().run("DELETE FROM messages");
    getDb().run("DELETE FROM conversations");
  });

  /** An owner-marked row correctly bound to `conversationId`. */
  function ownerJobFor(conversationId: string) {
    return { ...OWNER_WAKE_JOB, createdFromConversationId: conversationId };
  }

  test("a remote-channel target recovers nothing", () => {
    createConversation({ id: "conv-remote" });
    setConversationOriginChannelIfUnset("conv-remote", "telegram");

    const options = buildWakeScheduleOptions(
      ownerJobFor("conv-remote"),
      "conv-remote",
    );

    // Absent, not `undefined`: a fabricated context would either hand a
    // remote-origin conversation the guardian's capabilities or bury the reply
    // under `unknown` provenance.
    expect(options).not.toHaveProperty("trustContext");
    expect(wakeGateDecision(options)).toBe("deny");
  });

  test("an unrecognized stored origin recovers nothing", () => {
    // `getConversationOriginChannel` would collapse an unparseable value into
    // the same `null` an unset column yields, which would read as local. A row
    // from a newer build, a renamed channel id, or corrupted data must land
    // where a remote channel lands.
    createConversation({ id: "conv-future" });
    writeRawOriginChannel("conv-future", "channel-from-a-newer-build");

    expect(recoverRestingTrustContext("conv-future")).toBeNull();
    expect(
      buildWakeScheduleOptions(ownerJobFor("conv-future"), "conv-future"),
    ).not.toHaveProperty("trustContext");
  });

  test("an empty-string origin recovers nothing", () => {
    createConversation({ id: "conv-blank" });
    writeRawOriginChannel("conv-blank", "");

    expect(recoverRestingTrustContext("conv-blank")).toBeNull();
  });

  test("a conversation that does not exist recovers nothing", () => {
    // Inert in practice (the wake rejects it as `not_found` before a turn
    // runs), but trust is granted on a positively recognized local origin, so
    // an absent row must never be one.
    expect(recoverRestingTrustContext("conv-missing")).toBeNull();
    expect(
      buildWakeScheduleOptions(ownerJobFor("conv-missing"), "conv-missing"),
    ).not.toHaveProperty("trustContext");
  });
});
