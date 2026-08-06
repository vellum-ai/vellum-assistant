/**
 * `computeProfileAvailability` on profiles that carry no dispatchable pair.
 *
 * A rung only wins if its profile carries both a provider and a model
 * (`usableEntry` in config/llm-resolver.ts). A profile missing either is
 * skipped and the call site resolves elsewhere, so the profiles read has to
 * report that state rather than returning "nothing to judge", which clients
 * render as healthy.
 */

import { describe, expect, test } from "bun:test";

import {
  computeProfileAvailability,
  isUnavailable,
} from "../providers/inference/connection-availability.js";
import { describeUnavailableProfile } from "../runtime/routes/inference-profile-availability-guard.js";

describe("incomplete profiles", () => {
  test("no provider and no model reports both as missing", async () => {
    const availability = await computeProfileAvailability({});
    expect(availability?.status).toBe("incomplete");
    expect(availability?.message).toContain("a provider and a model");
  });

  test("a model with no provider names the provider", async () => {
    const availability = await computeProfileAvailability({
      model: "claude-opus-5",
    });
    expect(availability?.status).toBe("incomplete");
    expect(availability?.message).toContain("a provider");
    expect(availability?.message).not.toContain("a provider and a model");
  });

  test("a provider with no model names the model", async () => {
    const availability = await computeProfileAvailability({
      provider: "anthropic",
    });
    expect(availability?.status).toBe("incomplete");
    expect(availability?.message).toContain("a model");
  });

  // The destination is deliberately unnamed: which profile a call site falls
  // back to depends on the call site, so the message states the effect only.
  test("the message names the effect without naming a destination", async () => {
    const availability = await computeProfileAvailability({});
    expect(availability?.message).toContain("fall back to another profile");
  });
});

describe("mix profiles", () => {
  // A mix carries no provider or model of its own: the resolver expands it to
  // a seeded arm and judges that arm. Reporting a mix as incomplete would put
  // a warning on every working mix profile.
  test("a mix still reports nothing to judge", async () => {
    const availability = await computeProfileAvailability({
      mix: [
        { profile: "balanced", weight: 1 },
        { profile: "quality", weight: 1 },
      ],
    });
    expect(availability).toBeNull();
  });

  test("a mix that also names a provider and model is judged normally", async () => {
    const availability = await computeProfileAvailability({
      mix: [{ profile: "balanced", weight: 1 }],
      provider: "anthropic",
      model: "claude-opus-5",
    });
    expect(availability?.status).not.toBe("incomplete");
  });
});

describe("selection guards", () => {
  // The resolver skips an incomplete profile on every turn, so pinning one
  // means the user's selection is not what runs. Before `incomplete` existed,
  // a provider without a model reached the auto-resolve branch and could
  // return `missing_connection`, which these guards already rejected; the new
  // verdict has to keep that door shut rather than open it.
  test("an incomplete profile counts as unavailable", async () => {
    expect(isUnavailable(await computeProfileAvailability({}))).toBe(true);
    expect(
      isUnavailable(
        await computeProfileAvailability({ provider: "anthropic" }),
      ),
    ).toBe(true);
  });

  test("a mix is still not judged, so it is not blocked", async () => {
    expect(
      isUnavailable(
        await computeProfileAvailability({
          mix: [{ profile: "balanced", weight: 1 }],
        }),
      ),
    ).toBe(false);
  });

  // `describeUnavailableProfile` interpolates the provider, which an
  // incomplete profile may not have. Its guidance must not leak "undefined".
  test("the repair guidance names the fix without inventing a provider", async () => {
    const availability = await computeProfileAvailability({});
    const message = await describeUnavailableProfile({
      availability: availability!,
      provider: String(undefined),
      repair: { kind: "repoint", profileName: "half-made" },
      escapeHatch: false,
    });
    expect(message).not.toContain("undefined");
    expect(message).toContain("provider and a model");
  });
});
