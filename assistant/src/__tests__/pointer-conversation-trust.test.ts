import { describe, expect, test } from "bun:test";

import { elevatePointerConversationToGuardian } from "../daemon/pointer-conversation-trust.js";
import {
  INTERNAL_GUARDIAN_TRUST_CONTEXT,
  type TrustContext,
} from "../daemon/trust-context.js";
import { resolveCapabilities } from "../runtime/capabilities.js";

/**
 * Fake conversation that mirrors `Conversation.loadFromDb`'s trust gate: a
 * memory-capable (guardian) trust class sees the full guardian history; any
 * other class sees an empty (filtered) history. `ensureActorScopedHistory`
 * re-applies that gate against the current trust context, exactly like the real
 * reload path.
 */
class FakeConversation {
  trustContext: TrustContext | undefined;
  visibleHistory: string[] = [];
  setTrustContextCalls: Array<TrustContext | null> = [];
  ensureCalls = 0;
  private readonly guardianHistory: string[];
  private readonly processing: boolean;

  constructor(opts: {
    trustContext?: TrustContext;
    guardianHistory?: string[];
    processing?: boolean;
  }) {
    this.trustContext = opts.trustContext;
    this.guardianHistory = opts.guardianHistory ?? ["m1", "m2", "m3"];
    this.processing = opts.processing ?? false;
    this.applyHistoryForTrust();
  }

  private applyHistoryForTrust(): void {
    this.visibleHistory = resolveCapabilities(this.trustContext?.trustClass)
      .canAccessMemory
      ? [...this.guardianHistory]
      : [];
  }

  isProcessing(): boolean {
    return this.processing;
  }

  setTrustContext(ctx: TrustContext | null): void {
    this.setTrustContextCalls.push(ctx);
    this.trustContext = ctx ?? undefined;
  }

  async ensureActorScopedHistory(): Promise<void> {
    this.ensureCalls++;
    this.applyHistoryForTrust();
  }
}

const TRUSTED_CONTACT_CONTEXT: TrustContext = {
  sourceChannel: "vellum",
  trustClass: "trusted_contact",
};

const UNVERIFIED_CONTACT_CONTEXT: TrustContext = {
  sourceChannel: "vellum",
  trustClass: "unverified_contact",
};

const GUARDIAN_CONTEXT: TrustContext = {
  sourceChannel: "vellum",
  trustClass: "guardian",
};

describe("elevatePointerConversationToGuardian", () => {
  test("elevates a cold trust-less conversation and rehydrates guardian history", async () => {
    const conv = new FakeConversation({ trustContext: undefined });
    // A cold (trust-less) load filters guardian history to empty.
    expect(conv.visibleHistory).toEqual([]);

    const restore = await elevatePointerConversationToGuardian(conv);

    expect(conv.trustContext).toBe(INTERNAL_GUARDIAN_TRUST_CONTEXT);
    expect(conv.ensureCalls).toBe(1);
    // History is rehydrated rather than shipped empty.
    expect(conv.visibleHistory).toEqual(["m1", "m2", "m3"]);

    restore();
    expect(conv.trustContext).toBeUndefined();
  });

  test("does not elevate a trusted_contact context (no guardian history leak)", async () => {
    const conv = new FakeConversation({
      trustContext: TRUSTED_CONTACT_CONTEXT,
    });
    // A contact load filters guardian history to empty; it must stay empty.
    expect(conv.visibleHistory).toEqual([]);

    const restore = await elevatePointerConversationToGuardian(conv);

    // No elevation and no rehydration — guardian-only history is never
    // surfaced into a contact conversation.
    expect(conv.setTrustContextCalls).toEqual([]);
    expect(conv.ensureCalls).toBe(0);
    expect(conv.trustContext).toBe(TRUSTED_CONTACT_CONTEXT);
    expect(conv.visibleHistory).toEqual([]);

    restore();
    expect(conv.setTrustContextCalls).toEqual([]);
    expect(conv.trustContext).toBe(TRUSTED_CONTACT_CONTEXT);
  });

  test("does not elevate an unverified_contact context (no guardian history leak)", async () => {
    const conv = new FakeConversation({
      trustContext: UNVERIFIED_CONTACT_CONTEXT,
    });
    expect(conv.visibleHistory).toEqual([]);

    const restore = await elevatePointerConversationToGuardian(conv);

    expect(conv.setTrustContextCalls).toEqual([]);
    expect(conv.ensureCalls).toBe(0);
    expect(conv.trustContext).toBe(UNVERIFIED_CONTACT_CONTEXT);
    expect(conv.visibleHistory).toEqual([]);

    restore();
    expect(conv.setTrustContextCalls).toEqual([]);
    expect(conv.trustContext).toBe(UNVERIFIED_CONTACT_CONTEXT);
  });

  test("no-ops for a conversation that already has memory access", async () => {
    const conv = new FakeConversation({ trustContext: GUARDIAN_CONTEXT });
    expect(conv.visibleHistory).toEqual(["m1", "m2", "m3"]);

    const restore = await elevatePointerConversationToGuardian(conv);

    // No elevation, no redundant reload.
    expect(conv.setTrustContextCalls).toEqual([]);
    expect(conv.ensureCalls).toBe(0);
    expect(conv.trustContext).toBe(GUARDIAN_CONTEXT);

    restore();
    expect(conv.setTrustContextCalls).toEqual([]);
    expect(conv.trustContext).toBe(GUARDIAN_CONTEXT);
  });

  test("does not mutate trust while the conversation is processing", async () => {
    const conv = new FakeConversation({
      trustContext: undefined,
      processing: true,
    });

    const restore = await elevatePointerConversationToGuardian(conv);

    expect(conv.setTrustContextCalls).toEqual([]);
    expect(conv.ensureCalls).toBe(0);
    expect(conv.trustContext).toBeUndefined();

    restore();
    expect(conv.setTrustContextCalls).toEqual([]);
  });

  test("restore leaves trust alone when a later turn replaced it", async () => {
    const conv = new FakeConversation({ trustContext: undefined });
    const restore = await elevatePointerConversationToGuardian(conv);
    expect(conv.trustContext).toBe(INTERNAL_GUARDIAN_TRUST_CONTEXT);

    // Simulate a new turn legitimately replacing the trust context mid-flight.
    conv.setTrustContext(GUARDIAN_CONTEXT);
    restore();

    // The restorer must not clobber the new turn's context.
    expect(conv.trustContext).toBe(GUARDIAN_CONTEXT);
  });
});
