/**
 * Tests for the avatar→voice pairing. The pairing is a *preference* resolved
 * against whatever the platform actually serves, so what needs guarding is the
 * degradation: a delisted voice must cost the pairing, not the audition.
 */

import { describe, expect, test } from "bun:test";

import { AVATAR_POOL_SIZE } from "@/domains/onboarding/onboarding-avatar-pool-store";
import {
  AVATAR_VOICE_MODELS,
  resolveAvatarVoice,
} from "@/domains/onboarding/onboarding-avatar-voices";
import { type ManagedVoiceOption } from "@/lib/tts/use-managed-voices";

function voice(model: string): ManagedVoiceOption {
  return {
    model,
    label: model,
    description: "American · test",
    sampleUrl: `https://example.test/${model}.mp3`,
    source: "deepgram",
  };
}

describe("avatar voice pairing", () => {
  test("pairs every avatar in the cast, with no voice used twice", () => {
    expect(AVATAR_VOICE_MODELS.length).toBe(AVATAR_POOL_SIZE);
    // Cycling the carousel has to sound like meeting different characters.
    expect(new Set(AVATAR_VOICE_MODELS).size).toBe(AVATAR_VOICE_MODELS.length);
  });

  test("resolves each avatar's own voice from the catalog", () => {
    const catalog = AVATAR_VOICE_MODELS.map(voice);
    for (const [index, model] of AVATAR_VOICE_MODELS.entries()) {
      expect(resolveAvatarVoice(index, catalog)?.model).toBe(model);
    }
  });

  test("falls back to a catalog voice when the pairing is delisted", () => {
    const catalog = [voice("aura-2-orion-en"), voice("aura-2-vesta-en")];
    const resolved = resolveAvatarVoice(0, catalog);

    expect(resolved).not.toBeNull();
    // Stable across visits, and different from a neighbour's, so the step keeps
    // its shape even on a catalog the pairing predates.
    expect(resolveAvatarVoice(0, catalog)?.model).toBe(resolved!.model);
    expect(resolveAvatarVoice(1, catalog)?.model).not.toBe(resolved!.model);
  });

  test("resolves nothing without a catalog", () => {
    expect(resolveAvatarVoice(0, [])).toBeNull();
  });
});
