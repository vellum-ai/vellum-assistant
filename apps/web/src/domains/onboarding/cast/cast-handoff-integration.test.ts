/**
 * Cast onboarding → research-send handoff coverage.
 *
 * The personal-page activation arm fires its research directive right after the
 * user finishes the name/occupation step: `buildEarlyResearchContext` builds a
 * minimal context (name + role + the directive), and `sendCastResearchMessage`
 * attaches it to the first message. This test proves the load-bearing contract
 * — the user's `role` reaches both the chat wire (as `onboarding.occupation`)
 * and the seeded profile file (as `- **Role:**`), and the research directive is
 * the message — by feeding the early context through the exact transforms the
 * send applies.
 *
 * It deliberately stops at the onboarding-owned boundary (no cross-domain
 * `chat` import — see `local/no-cross-domain-imports`): the wire normalization
 * (`normalizePreChatOnboardingContext`) and the seeded-profile section
 * (`buildOnboardingSection(preChatOnboardingProfileFields(...))`) are the same
 * onboarding-owned helpers `send-research-message.ts` (and `chat/api/messages`)
 * use. The send transport itself is covered in `chat/api/post-chat-message.test.ts`.
 */
import { describe, expect, test } from "bun:test";

import {
  buildEarlyResearchContext,
  CAST_RESEARCH_DIRECTIVE,
} from "@/domains/onboarding/cast/cast-prechat-mapping";
import {
  normalizePreChatOnboardingContext,
  preChatOnboardingProfileFields,
} from "@/domains/onboarding/prechat";
import { buildOnboardingSection } from "@/domains/onboarding/prechat-profile";

/** A representative early identity. Placeholder identity, no real person. */
const IDENTITY = {
  firstName: "Riverdance",
  lastName: "Placeholder",
  role: "Product Manager",
};

describe("cast early research send → wire + profile", () => {
  test("the directive is the message and occupation rides the context", () => {
    const context = buildEarlyResearchContext(IDENTITY);
    expect(context.initialMessage).toBe(CAST_RESEARCH_DIRECTIVE);
    expect(context.occupation).toBe("Product Manager");
    expect(context.userName).toBe("Riverdance Placeholder");
  });

  test("occupation reaches the wire onboarding payload", () => {
    const context = buildEarlyResearchContext(IDENTITY);
    // `send-research-message.ts` copies `normalizePreChatOnboardingContext(ctx)`
    // field-for-field onto the wire `onboarding` dict, including `occupation`.
    const wire = normalizePreChatOnboardingContext(context);
    expect(wire.occupation).toBe("Product Manager");
  });

  test("occupation seeds the profile Role line", () => {
    const context = buildEarlyResearchContext(IDENTITY);
    // `persistPreChatOnboardingProfile` writes
    // `buildOnboardingSection(preChatOnboardingProfileFields(ctx))` to the
    // seeded profile files (`users/default.md`).
    const section = buildOnboardingSection(
      preChatOnboardingProfileFields(context),
    );
    expect(section).toContain("- **Role:** Product Manager");
  });
});
