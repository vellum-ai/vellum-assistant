/**
 * Cast onboarding → chat handoff integration coverage.
 *
 * Proves the load-bearing contract for the personal-page activation arm
 * end-to-end: the user's collected `role` reaches both the chat wire (as the
 * `onboarding.occupation` field) and the seeded profile file (as `- **Role:**`),
 * and the cast research directive is the auto-sent first message.
 *
 * The handoff is exercised through the *real* flow + onboarding plumbing, but
 * deliberately stops at the onboarding-owned boundary so the test stays within
 * the `onboarding` domain (no cross-domain `chat` import — see
 * `local/no-cross-domain-imports`):
 *
 *   1. The flow's completion logic (`buildHandoffFromCompletion`) builds a
 *      context, `setPendingPreChatContext` stashes it, and
 *      `consumePendingPreChatContext` returns it with `occupation` set and
 *      `initialMessage === CAST_RESEARCH_DIRECTIVE`.
 *   2. The exact transforms the chat send applies to that context — wire
 *      normalization (`normalizePreChatOnboardingContext`, which
 *      `chat/api/messages.ts` copies field-for-field onto the wire
 *      `onboarding` dict) and the seeded-profile section
 *      (`buildOnboardingSection(preChatOnboardingProfileFields(...))`, which
 *      `chat/api/messages.ts` writes to the profile files) — both carry
 *      `occupation` through as `occupation` / `- **Role:**`.
 *
 * The wire-and-profile *transport* (the `postChatMessage` fetch + workspace
 * writes) is covered directly in `chat/api/post-chat-message.test.ts`; this
 * test proves the cast context feeds those transforms the right inputs.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";

import {
  buildHandoffFromCompletion,
  castToneToGroupId,
  type CastCompletionData,
} from "@/domains/onboarding/cast/cast-onboarding-flow";
import { CAST_RESEARCH_DIRECTIVE } from "@/domains/onboarding/cast/cast-prechat-mapping";
import {
  consumePendingPreChatContext,
  normalizePreChatOnboardingContext,
  preChatOnboardingProfileFields,
  setPendingPreChatContext,
} from "@/domains/onboarding/prechat";
import { buildOnboardingSection } from "@/domains/onboarding/prechat-profile";
import {
  DEFAULT_GROUP_ID,
  PERSONALITY_GROUPS,
} from "@/domains/onboarding/prechat-names";

/** A representative completed cast walk. Placeholder identity, no real person. */
function castCompletion(
  overrides: Partial<CastCompletionData> = {},
): CastCompletionData {
  return {
    firstName: "Riverdance",
    lastName: "Placeholder",
    role: "Product Manager",
    // `character` is not read by the handoff; a minimal stand-in satisfies the
    // type without pulling in the roster.
    character: {} as CastCompletionData["character"],
    name: "Vel",
    tone: "deep",
    connectedTools: ["linear", "slack"],
    style: {},
    credits: 0,
    ...overrides,
  };
}

describe("cast onboarding → chat handoff", () => {
  // `globalThis.sessionStorage` is a readonly getter under bun, so install the
  // shim via `defineProperty` and restore the prior descriptor — matches
  // `onboarding/prechat.test.ts` and avoids leaking across the bun process.
  let priorSessionStorage: PropertyDescriptor | undefined;

  beforeEach(() => {
    const store = new Map<string, string>();
    priorSessionStorage = Object.getOwnPropertyDescriptor(
      globalThis,
      "sessionStorage",
    );
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      value: {
        getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      },
    });
  });

  afterEach(() => {
    if (priorSessionStorage) {
      Object.defineProperty(globalThis, "sessionStorage", priorSessionStorage);
    } else {
      delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
    }
  });

  test("build → stash → consume round-trips occupation and the research directive", () => {
    const { context } = buildHandoffFromCompletion(castCompletion());
    setPendingPreChatContext(context);

    const consumed = consumePendingPreChatContext();
    expect(consumed).not.toBeNull();
    expect(consumed!.occupation).toBe("Product Manager");
    expect(consumed!.initialMessage).toBe(CAST_RESEARCH_DIRECTIVE);
    // `deep` tone → grounded group id (see `castToneToGroupId`).
    expect(consumed!.tone).toBe("grounded");

    // Consume-once: a second read returns null.
    expect(consumePendingPreChatContext()).toBeNull();
  });

  test("the consumed context carries occupation onto the wire payload shape", () => {
    const { context } = buildHandoffFromCompletion(castCompletion());
    setPendingPreChatContext(context);
    const consumed = consumePendingPreChatContext();
    expect(consumed).not.toBeNull();

    // `chat/api/messages.ts` copies `normalizePreChatOnboardingContext(ctx)`
    // field-for-field onto the wire `onboarding` dict, including `occupation`.
    const wireShape = normalizePreChatOnboardingContext(consumed!);
    expect(wireShape.occupation).toBe("Product Manager");
  });

  test("the consumed context seeds a profile section with the Role line", () => {
    const { context } = buildHandoffFromCompletion(castCompletion());
    setPendingPreChatContext(context);
    const consumed = consumePendingPreChatContext();
    expect(consumed).not.toBeNull();

    // `chat/api/messages.ts` writes
    // `buildOnboardingSection(preChatOnboardingProfileFields(ctx))` to the
    // seeded profile files (`users/default.md`, `users/guardian.md`).
    const section = buildOnboardingSection(
      preChatOnboardingProfileFields(consumed!),
    );
    expect(section).toContain("- **Role:** Product Manager");
  });

  test("the auto-sent first message is the research directive", () => {
    const { context } = buildHandoffFromCompletion(castCompletion());
    setPendingPreChatContext(context);
    const consumed = consumePendingPreChatContext();
    // ChatPage auto-sends `consumed.initialMessage` as the first message.
    expect(consumed!.initialMessage).toBe(CAST_RESEARCH_DIRECTIVE);
  });
});

describe("castToneToGroupId (finalized fast/deep → group mapping)", () => {
  const validGroupIds = new Set(PERSONALITY_GROUPS.map((g) => g.id));

  test("maps fast → energetic", () => {
    expect(castToneToGroupId("fast")).toBe("energetic");
  });

  test("maps deep → grounded", () => {
    expect(castToneToGroupId("deep")).toBe("grounded");
  });

  test("maps a skipped tone to the default group id", () => {
    expect(castToneToGroupId(null)).toBe(DEFAULT_GROUP_ID);
  });

  test("only ever yields a valid personality group id", () => {
    for (const tone of ["fast", "deep", null] as const) {
      expect(validGroupIds.has(castToneToGroupId(tone))).toBe(true);
    }
  });
});
