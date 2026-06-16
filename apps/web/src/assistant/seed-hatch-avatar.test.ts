/**
 * Tests for `seedHatchAvatar` — the shared hatch-avatar seed used by both the
 * standalone hatching screen and the cast flow's background hatch.
 *
 * Pins:
 *   - Saves traits + invalidates the avatar query when no avatar exists yet.
 *   - Skips the save (but still invalidates) when an avatar already exists, so
 *     a returning user's uploaded/AI image is never clobbered.
 *   - Swallows transport failures (fire-and-forget).
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { CharacterTraits } from "@/types/avatar";

const fetchCharacterTraitsMock = mock(
  async (_id: string): Promise<CharacterTraits | null> => null,
);
const saveCharacterTraitsMock = mock(
  async (_id: string, _t: CharacterTraits): Promise<boolean> => true,
);
mock.module("@/assistant/avatar-api", () => ({
  fetchCharacterTraits: fetchCharacterTraitsMock,
  saveCharacterTraits: saveCharacterTraitsMock,
}));
mock.module("@/lib/sentry/capture-error", () => ({
  captureError: () => {},
}));
mock.module("@/lib/sync/query-tags", () => ({
  avatarQueryKey: (id: string) => ["avatar", id],
}));

const { seedHatchAvatar } = await import("./seed-hatch-avatar");

const TRAITS: CharacterTraits = {
  bodyShape: "round",
  eyeStyle: "happy",
  color: "#123456",
};

function makeQueryClient(): {
  invalidateQueries: ReturnType<typeof mock>;
} {
  return { invalidateQueries: mock(() => {}) };
}

beforeEach(() => {
  fetchCharacterTraitsMock.mockClear();
  saveCharacterTraitsMock.mockClear();
});

describe("seedHatchAvatar", () => {
  test("saves traits and invalidates when no avatar exists", async () => {
    fetchCharacterTraitsMock.mockResolvedValueOnce(null);
    const qc = makeQueryClient();

    await seedHatchAvatar("ast-1", TRAITS, qc as never);

    expect(saveCharacterTraitsMock).toHaveBeenCalledTimes(1);
    expect(saveCharacterTraitsMock.mock.calls[0]?.[0]).toBe("ast-1");
    expect(qc.invalidateQueries).toHaveBeenCalledTimes(1);
  });

  test("skips the save but still invalidates when an avatar already exists", async () => {
    fetchCharacterTraitsMock.mockResolvedValueOnce(TRAITS);
    const qc = makeQueryClient();

    await seedHatchAvatar("ast-1", TRAITS, qc as never);

    expect(saveCharacterTraitsMock).not.toHaveBeenCalled();
    expect(qc.invalidateQueries).toHaveBeenCalledTimes(1);
  });

  test("swallows transport failures", async () => {
    fetchCharacterTraitsMock.mockRejectedValueOnce(new Error("boom"));
    const qc = makeQueryClient();

    await seedHatchAvatar("ast-1", TRAITS, qc as never);

    expect(saveCharacterTraitsMock).not.toHaveBeenCalled();
    expect(qc.invalidateQueries).not.toHaveBeenCalled();
  });
});
