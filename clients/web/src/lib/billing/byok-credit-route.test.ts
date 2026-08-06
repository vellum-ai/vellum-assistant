/**
 * Tests for the pure BYOK credit-route derivation. Pure-data module (its
 * generated-type imports are type-only), so fixtures are plain objects and no
 * module mocking is involved. That is deliberate: the sibling hook module IS
 * `mock.module`-replaced by the billing-status suite and these functions
 * must stay importable un-mocked.
 */
import { describe, expect, test } from "bun:test";

import type {
  ConfigGetResponse,
  ProviderConnection,
} from "@/generated/daemon/types.gen";

import {
  defaultChatRouteBurnsManagedCredits,
  profileBurnsManagedCredits,
} from "./byok-credit-route";

type LlmConfig = ConfigGetResponse["llm"];

function conn(overrides: Partial<ProviderConnection>): ProviderConnection {
  return {
    name: "conn",
    provider: "anthropic",
    auth: { type: "api_key", credential: "credential/anthropic/api_key" },
    label: null,
    baseUrl: null,
    models: null,
    createdAt: 0,
    updatedAt: 0,
    isManaged: false,
    ...overrides,
  };
}

const BYOK_ANTHROPIC = conn({ name: "my-anthropic" });
const MANAGED_SENTINEL = conn({
  name: "vellum",
  provider: "vellum",
  auth: { type: "platform" },
  isManaged: true,
});
const PLATFORM_ANTHROPIC = conn({
  name: "managed-anthropic",
  auth: { type: "platform" },
});

describe("profileBurnsManagedCredits", () => {
  test("vellum-provider profile burns credits regardless of connections", () => {
    const llm: LlmConfig = { profiles: { p: { provider: "vellum" } } };
    expect(profileBurnsManagedCredits(llm, "p", [])).toBe(true);
  });

  test("profile bound to the managed sentinel connection burns credits", () => {
    const llm: LlmConfig = {
      profiles: {
        p: { provider: "anthropic", provider_connection: "vellum" },
      },
    };
    expect(profileBurnsManagedCredits(llm, "p", [MANAGED_SENTINEL])).toBe(true);
  });

  test("profile bound to a platform-auth connection burns credits", () => {
    const llm: LlmConfig = {
      profiles: {
        p: { provider: "anthropic", provider_connection: "managed-anthropic" },
      },
    };
    expect(profileBurnsManagedCredits(llm, "p", [PLATFORM_ANTHROPIC])).toBe(
      true,
    );
  });

  test("profile bound to an api-key connection is BYOK", () => {
    const llm: LlmConfig = {
      profiles: {
        p: { provider: "anthropic", provider_connection: "my-anthropic" },
      },
    };
    expect(
      profileBurnsManagedCredits(llm, "p", [BYOK_ANTHROPIC, MANAGED_SENTINEL]),
    ).toBe(false);
  });

  test("bound connection missing from the list is unknown", () => {
    const llm: LlmConfig = {
      profiles: { p: { provider: "anthropic", provider_connection: "gone" } },
    };
    expect(profileBurnsManagedCredits(llm, "p", [BYOK_ANTHROPIC])).toBeNull();
  });

  test("unbound profile burns credits when its provider has a platform-auth connection", () => {
    const llm: LlmConfig = { profiles: { p: { provider: "anthropic" } } };
    expect(
      profileBurnsManagedCredits(llm, "p", [
        BYOK_ANTHROPIC,
        PLATFORM_ANTHROPIC,
      ]),
    ).toBe(true);
  });

  test("unbound profile is BYOK when its provider only has key connections", () => {
    // The managed sentinel carries provider "vellum", so it never matches an
    // unbound anthropic profile's provider-scoped fallback dispatch.
    const llm: LlmConfig = { profiles: { p: { provider: "anthropic" } } };
    expect(
      profileBurnsManagedCredits(llm, "p", [BYOK_ANTHROPIC, MANAGED_SENTINEL]),
    ).toBe(false);
  });

  test("unknown profile name is unknown", () => {
    expect(profileBurnsManagedCredits({ profiles: {} }, "p", [])).toBeNull();
  });

  test("mix burns credits when any arm does", () => {
    const llm: LlmConfig = {
      profiles: {
        mixed: {
          mix: [
            { profile: "byok", weight: 1 },
            { profile: "managed", weight: 1 },
          ],
        },
        byok: { provider: "anthropic", provider_connection: "my-anthropic" },
        managed: { provider: "vellum" },
      },
    };
    expect(profileBurnsManagedCredits(llm, "mixed", [BYOK_ANTHROPIC])).toBe(
      true,
    );
  });

  test("mix of only BYOK arms is BYOK", () => {
    const llm: LlmConfig = {
      profiles: {
        mixed: { mix: [{ profile: "byok", weight: 1 }] },
        byok: { provider: "anthropic", provider_connection: "my-anthropic" },
      },
    };
    expect(profileBurnsManagedCredits(llm, "mixed", [BYOK_ANTHROPIC])).toBe(
      false,
    );
  });

  test("mix with an unresolvable arm is unknown", () => {
    const llm: LlmConfig = {
      profiles: { mixed: { mix: [{ profile: "gone", weight: 1 }] } },
    };
    expect(profileBurnsManagedCredits(llm, "mixed", [])).toBeNull();
  });

  test("cyclic mix references terminate", () => {
    const llm: LlmConfig = {
      profiles: {
        a: { mix: [{ profile: "b", weight: 1 }] },
        b: { mix: [{ profile: "a", weight: 1 }] },
      },
    };
    expect(profileBurnsManagedCredits(llm, "a", [])).toBe(false);
  });
});

describe("defaultChatRouteBurnsManagedCredits", () => {
  test("resolves through a usable active profile", () => {
    const llm: LlmConfig = {
      activeProfile: "p",
      profiles: { p: { provider: "vellum", model: "claude" } },
    };
    expect(defaultChatRouteBurnsManagedCredits(llm, [])).toBe(true);
  });

  test("a disabled active profile falls through to the mainAgent call-site pin", () => {
    const llm: LlmConfig = {
      activeProfile: "off",
      callSites: { mainAgent: { profile: "pinned" } },
      profiles: {
        off: {
          provider: "anthropic",
          model: "claude",
          provider_connection: "my-anthropic",
          status: "disabled",
        },
        pinned: { provider: "vellum", model: "claude" },
      },
    };
    expect(defaultChatRouteBurnsManagedCredits(llm, [BYOK_ANTHROPIC])).toBe(
      true,
    );
  });

  test("the mainAgent call-site pin wins when no active profile is set", () => {
    const llm: LlmConfig = {
      callSites: { mainAgent: { profile: "pinned" } },
      profiles: {
        pinned: {
          provider: "anthropic",
          model: "claude",
          provider_connection: "my-anthropic",
        },
      },
      defaultProvider: { provider: "vellum" },
    };
    expect(defaultChatRouteBurnsManagedCredits(llm, [BYOK_ANTHROPIC])).toBe(
      false,
    );
  });

  test("an incomplete active profile (no model) falls through to the anchor", () => {
    // Mirrors the daemon's usability rule: a winner must carry its own
    // provider AND model, so a provider-only profile is skipped, not
    // classified.
    const llm: LlmConfig = {
      activeProfile: "incomplete",
      profiles: {
        incomplete: {
          provider: "anthropic",
          provider_connection: "my-anthropic",
        },
      },
      defaultProvider: { provider: "vellum" },
    };
    expect(defaultChatRouteBurnsManagedCredits(llm, [BYOK_ANTHROPIC])).toBe(
      true,
    );
  });

  test("falls back to the legacy top-level default entry", () => {
    const llm: LlmConfig = {
      default: { provider: "vellum", model: "claude" },
    };
    expect(defaultChatRouteBurnsManagedCredits(llm, [])).toBe(true);
  });

  test("falls back to defaultProvider with its connection binding", () => {
    const llm: LlmConfig = {
      defaultProvider: {
        provider: "anthropic",
        connectionName: "my-anthropic",
      },
    };
    expect(defaultChatRouteBurnsManagedCredits(llm, [BYOK_ANTHROPIC])).toBe(
      false,
    );
  });

  test("no default route at all is unknown", () => {
    expect(defaultChatRouteBurnsManagedCredits({}, [])).toBeNull();
    expect(defaultChatRouteBurnsManagedCredits(undefined, [])).toBeNull();
  });
});
