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
  type AvailabilityStatus,
  type ChatRouteEvidence,
  defaultChatRouteBurnsManagedCredits,
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

/**
 * Evidence builder: availability defaults every named profile to "ok" so
 * tests about routing stay noise-free; proof-standard tests override it.
 */
function evidence(
  overrides: Partial<ChatRouteEvidence> & { llm: LlmConfig },
): ChatRouteEvidence {
  const availability =
    overrides.profileAvailability ??
    new Map<string, AvailabilityStatus>(
      Object.keys(overrides.llm?.profiles ?? {}).map((name) => [name, "ok"]),
    );
  return {
    connections: [],
    defaultProviderAvailability: "ok",
    ...overrides,
    profileAvailability: availability,
  };
}

function classify(
  overrides: Partial<ChatRouteEvidence> & { llm: LlmConfig },
): boolean | null {
  return defaultChatRouteBurnsManagedCredits(evidence(overrides));
}

describe("route classification through the active profile", () => {
  test("vellum-provider profile burns credits regardless of connections", () => {
    expect(
      classify({
        llm: {
          activeProfile: "p",
          profiles: { p: { provider: "vellum", model: "claude" } },
        },
      }),
    ).toBe(true);
  });

  test("profile bound to the managed sentinel connection burns credits", () => {
    expect(
      classify({
        llm: {
          activeProfile: "p",
          profiles: {
            p: {
              provider: "anthropic",
              model: "claude",
              provider_connection: "vellum",
            },
          },
        },
        connections: [MANAGED_SENTINEL],
      }),
    ).toBe(true);
  });

  test("a binding to the canonical vellum name is managed even when a user-owned row claims it", () => {
    // The daemon ignores a user-owned row named "vellum" and routes through
    // platform auth regardless, so the row's BYOK auth must not win here.
    expect(
      classify({
        llm: {
          activeProfile: "p",
          profiles: {
            p: {
              provider: "anthropic",
              model: "claude",
              provider_connection: "vellum",
            },
          },
        },
        connections: [conn({ name: "vellum" })],
      }),
    ).toBe(true);
  });

  test("profile bound to a platform-auth connection burns credits", () => {
    expect(
      classify({
        llm: {
          activeProfile: "p",
          profiles: {
            p: {
              provider: "anthropic",
              model: "claude",
              provider_connection: "managed-anthropic",
            },
          },
        },
        connections: [PLATFORM_ANTHROPIC],
      }),
    ).toBe(true);
  });

  test("profile bound to an api-key connection is BYOK", () => {
    expect(
      classify({
        llm: {
          activeProfile: "p",
          profiles: {
            p: {
              provider: "anthropic",
              model: "claude",
              provider_connection: "my-anthropic",
            },
          },
        },
        connections: [BYOK_ANTHROPIC, MANAGED_SENTINEL],
      }),
    ).toBe(false);
  });

  test("bound connection missing from the list is unknown", () => {
    expect(
      classify({
        llm: {
          activeProfile: "p",
          profiles: {
            p: {
              provider: "anthropic",
              model: "claude",
              provider_connection: "gone",
            },
          },
        },
        connections: [BYOK_ANTHROPIC],
      }),
    ).toBeNull();
  });

  test("unbound profile burns credits when its provider has a platform-auth connection", () => {
    expect(
      classify({
        llm: {
          activeProfile: "p",
          profiles: { p: { provider: "anthropic", model: "claude" } },
        },
        connections: [BYOK_ANTHROPIC, PLATFORM_ANTHROPIC],
      }),
    ).toBe(true);
  });

  test("unbound profile is BYOK when its provider only has key connections", () => {
    // The managed sentinel carries provider "vellum", so it never matches an
    // unbound anthropic profile's provider-scoped fallback dispatch.
    expect(
      classify({
        llm: {
          activeProfile: "p",
          profiles: { p: { provider: "anthropic", model: "claude" } },
        },
        connections: [BYOK_ANTHROPIC, MANAGED_SENTINEL],
      }),
    ).toBe(false);
  });
});

describe("the BYOK proof standard (connection availability)", () => {
  const BYOK_LLM: LlmConfig = {
    activeProfile: "p",
    profiles: {
      p: {
        provider: "anthropic",
        model: "claude",
        provider_connection: "my-anthropic",
      },
    },
  };

  test("a BYOK verdict without an ok availability is unknown", () => {
    // A failing credential soft-falls back to the default transport at
    // dispatch, which can be platform-billed, so BYOK is only provable
    // through a dispatchable connection.
    for (const status of [
      "missing_credential",
      "unknown",
      "missing_connection",
    ] as const) {
      expect(
        classify({
          llm: BYOK_LLM,
          connections: [BYOK_ANTHROPIC],
          profileAvailability: new Map([["p", status]]),
        }),
      ).toBeNull();
    }
  });

  test("a BYOK verdict with no availability row at all is unknown", () => {
    expect(
      classify({
        llm: BYOK_LLM,
        connections: [BYOK_ANTHROPIC],
        profileAvailability: new Map(),
      }),
    ).toBeNull();
  });

  test("a managed verdict needs no availability proof", () => {
    expect(
      classify({
        llm: {
          activeProfile: "p",
          profiles: { p: { provider: "vellum", model: "claude" } },
        },
        profileAvailability: new Map(),
      }),
    ).toBe(true);
  });
});

describe("resolver-chain fallthrough", () => {
  test("a disabled active profile falls through to the mainAgent call-site pin", () => {
    expect(
      classify({
        llm: {
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
        },
        connections: [BYOK_ANTHROPIC],
      }),
    ).toBe(true);
  });

  test("the mainAgent call-site pin wins when no active profile is set", () => {
    expect(
      classify({
        llm: {
          callSites: { mainAgent: { profile: "pinned" } },
          profiles: {
            pinned: {
              provider: "anthropic",
              model: "claude",
              provider_connection: "my-anthropic",
            },
          },
          defaultProvider: { provider: "vellum" },
        },
        connections: [BYOK_ANTHROPIC],
      }),
    ).toBe(false);
  });

  test("an incomplete active profile (no model) falls through to the anchor", () => {
    // Mirrors the daemon's usability rule: a winner must carry its own
    // provider AND model, so a provider-only profile is skipped, not
    // classified.
    expect(
      classify({
        llm: {
          activeProfile: "incomplete",
          profiles: {
            incomplete: {
              provider: "anthropic",
              provider_connection: "my-anthropic",
            },
          },
          defaultProvider: { provider: "vellum" },
        },
        connections: [BYOK_ANTHROPIC],
      }),
    ).toBe(true);
  });

  test("a managed conversation override outranks a BYOK active profile", () => {
    expect(
      classify({
        llm: {
          activeProfile: "byok",
          profiles: {
            byok: {
              provider: "anthropic",
              model: "claude",
              provider_connection: "my-anthropic",
            },
            pinned: { provider: "vellum", model: "claude" },
          },
        },
        connections: [BYOK_ANTHROPIC],
        overrideProfile: "pinned",
      }),
    ).toBe(true);
  });

  test("an unusable conversation override falls through to the active profile", () => {
    expect(
      classify({
        llm: {
          activeProfile: "byok",
          profiles: {
            byok: {
              provider: "anthropic",
              model: "claude",
              provider_connection: "my-anthropic",
            },
          },
        },
        connections: [BYOK_ANTHROPIC],
        overrideProfile: "gone",
      }),
    ).toBe(false);
  });
});

describe("mix rungs (per-conversation seeded pick)", () => {
  test("mix burns credits when any usable arm does", () => {
    expect(
      classify({
        llm: {
          activeProfile: "mixed",
          profiles: {
            mixed: {
              mix: [
                { profile: "byok", weight: 1 },
                { profile: "managed", weight: 1 },
              ],
            },
            byok: {
              provider: "anthropic",
              model: "claude",
              provider_connection: "my-anthropic",
            },
            managed: { provider: "vellum", model: "claude" },
          },
        },
        connections: [BYOK_ANTHROPIC],
      }),
    ).toBe(true);
  });

  test("mix of only usable BYOK arms is BYOK", () => {
    expect(
      classify({
        llm: {
          activeProfile: "mixed",
          profiles: {
            mixed: { mix: [{ profile: "byok", weight: 1 }] },
            byok: {
              provider: "anthropic",
              model: "claude",
              provider_connection: "my-anthropic",
            },
          },
        },
        connections: [BYOK_ANTHROPIC],
      }),
    ).toBe(false);
  });

  test("an unusable arm stands for the chain below the mix rung", () => {
    // A conversation seeded to the disabled arm skips the whole rung
    // daemon-side and lands on the next rung (here a managed call-site pin),
    // so the mix must classify as managed even though its usable arm is
    // BYOK.
    expect(
      classify({
        llm: {
          activeProfile: "mixed",
          callSites: { mainAgent: { profile: "pinned" } },
          profiles: {
            mixed: {
              mix: [
                { profile: "byok", weight: 1 },
                { profile: "broken", weight: 1 },
              ],
            },
            byok: {
              provider: "anthropic",
              model: "claude",
              provider_connection: "my-anthropic",
            },
            broken: {
              provider: "anthropic",
              provider_connection: "my-anthropic",
              status: "disabled",
            },
            pinned: { provider: "vellum", model: "claude" },
          },
        },
        connections: [BYOK_ANTHROPIC],
      }),
    ).toBe(true);
  });

  test("a mix arm that is itself a mix counts as unusable, not a cycle", () => {
    expect(
      classify({
        llm: {
          activeProfile: "a",
          profiles: {
            a: { mix: [{ profile: "b", weight: 1 }] },
            b: { mix: [{ profile: "a", weight: 1 }] },
          },
        },
      }),
    ).toBeNull();
  });
});

describe("anchor fallbacks", () => {
  test("falls back to the legacy top-level default entry for a managed verdict", () => {
    expect(
      classify({ llm: { default: { provider: "vellum", model: "claude" } } }),
    ).toBe(true);
  });

  test("the legacy top-level default can never prove BYOK", () => {
    // No availability source exists for the legacy body, so a BYOK-looking
    // entry stays unknown and the banners stay up.
    expect(
      classify({
        llm: {
          default: {
            provider: "anthropic",
            model: "claude",
            provider_connection: "my-anthropic",
          },
        },
        connections: [BYOK_ANTHROPIC],
      }),
    ).toBeNull();
  });

  test("defaultProvider proves BYOK only with an ok availability", () => {
    const llm: LlmConfig = {
      defaultProvider: {
        provider: "anthropic",
        connectionName: "my-anthropic",
      },
    };
    expect(
      classify({
        llm,
        connections: [BYOK_ANTHROPIC],
        defaultProviderAvailability: "ok",
      }),
    ).toBe(false);
    expect(
      classify({
        llm,
        connections: [BYOK_ANTHROPIC],
        defaultProviderAvailability: "missing_credential",
      }),
    ).toBeNull();
  });

  test("no default route at all is unknown", () => {
    expect(classify({ llm: {} })).toBeNull();
    expect(classify({ llm: undefined })).toBeNull();
  });
});
