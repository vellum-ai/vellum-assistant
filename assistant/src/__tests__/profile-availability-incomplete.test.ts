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

import { computeProfileAvailability } from "../providers/inference/connection-availability.js";

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

  test("the message points at where to finish setup", async () => {
    const availability = await computeProfileAvailability({});
    expect(availability?.message).toContain("Models & Services");
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
