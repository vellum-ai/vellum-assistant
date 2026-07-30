/**
 * A deferred wake resumes a conversation with nobody on the other end, so it
 * has no inbound actor to derive trust from. It runs under the target
 * conversation's reconstructed resting trust instead: guardian for the
 * guardian's own local conversation, nothing at all for one whose origin is a
 * remote channel.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import { recoverRestingTrustContext } from "../daemon/conversation-resting-trust.js";
import {
  FALLBACK_TURN_TRUST,
  INTERNAL_GUARDIAN_TRUST_CONTEXT,
  resolveTrustClass,
} from "../daemon/trust-context.js";
import {
  createConversation,
  setConversationOriginChannelIfUnset,
} from "../persistence/conversation-crud.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { resolveCapabilities } from "../runtime/capabilities.js";
import { buildWakeScheduleOptions } from "../schedule/wake-schedule-options.js";
import { resolveSensitiveToolDecision } from "../tools/tool-approval-handler.js";

await initializeDb();

const WAKE_JOB = { message: "Check back on this", inferenceProfile: null };

/**
 * The decision the sensitive-tool gate reaches for an invocation with the given
 * resting trust, with no channel approval cell to lift the floor. `null` trust
 * is what a wake with no `trustContext` resolves at tool-setup time
 * (`currentTurnTrustContext ?? trustContext ?? FALLBACK_TURN_TRUST`).
 */
function gateDecision(
  trustContext: ReturnType<typeof recoverRestingTrustContext>,
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

describe("deferred wake resting trust", () => {
  beforeEach(() => {
    getDb().run("DELETE FROM messages");
    getDb().run("DELETE FROM conversations");
  });

  test("a local conversation wakes under guardian trust", () => {
    createConversation({ id: "conv-local" });

    expect(buildWakeScheduleOptions(WAKE_JOB, "conv-local")).toEqual({
      conversationId: "conv-local",
      hint: "Check back on this",
      source: "defer",
      persistTriggerAsEvent: true,
      trustContext: INTERNAL_GUARDIAN_TRUST_CONTEXT,
    });
  });

  test("the internal vellum channel is a guardian-owned local conversation", () => {
    createConversation({ id: "conv-vellum" });
    setConversationOriginChannelIfUnset("conv-vellum", "vellum");

    expect(buildWakeScheduleOptions(WAKE_JOB, "conv-vellum")).toHaveProperty(
      "trustContext",
      INTERNAL_GUARDIAN_TRUST_CONTEXT,
    );
  });

  test("a remote-channel conversation wakes with no reconstructed trust", () => {
    createConversation({ id: "conv-remote" });
    setConversationOriginChannelIfUnset("conv-remote", "telegram");

    const options = buildWakeScheduleOptions(WAKE_JOB, "conv-remote");

    // Absent, not `undefined`: a fabricated context here would either hand a
    // remote-origin conversation the guardian's capabilities or bury the reply
    // under `unknown` provenance.
    expect(options).not.toHaveProperty("trustContext");
    expect(options).toEqual({
      conversationId: "conv-remote",
      hint: "Check back on this",
      source: "defer",
      persistTriggerAsEvent: true,
    });
  });

  test("the schedule's inference profile still rides along", () => {
    createConversation({ id: "conv-local" });

    expect(
      buildWakeScheduleOptions(
        { ...WAKE_JOB, inferenceProfile: "fast" },
        "conv-local",
      ),
    ).toHaveProperty("forceOverrideProfile", "fast");
  });

  test("guardian resting trust clears the sensitive-tool gate", () => {
    createConversation({ id: "conv-local" });
    const trust = recoverRestingTrustContext("conv-local");

    expect(trust).toEqual(INTERNAL_GUARDIAN_TRUST_CONTEXT);
    // Both reaches: `bash` in the workspace sandbox and a host-reaching
    // invocation. The guardian self-approves either, which is what makes a
    // resumed deferred wake able to keep using the tools it deferred mid-task.
    expect(gateDecision(trust, "sandbox")).toBe("proceed");
    expect(gateDecision(trust, "host")).toBe("proceed");
  });

  test("a remote-origin wake stays fail-closed on sensitive tools", () => {
    createConversation({ id: "conv-remote" });
    setConversationOriginChannelIfUnset("conv-remote", "telegram");
    const trust = recoverRestingTrustContext("conv-remote");

    expect(trust).toBeNull();
    // `deny`, not `escalate-and-wait`: this is the branch that produces the
    // "requires guardian approval from a verified channel identity" message,
    // and it must keep producing it for a wake whose trust cannot be recovered.
    expect(gateDecision(trust, "sandbox")).toBe("deny");
    expect(gateDecision(trust, "host")).toBe("deny");
  });
});
