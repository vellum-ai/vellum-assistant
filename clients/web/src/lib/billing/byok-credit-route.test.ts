/**
 * Tests for the pure BYOK credit-route derivation. Pure-data module (its
 * generated-type imports are type-only), so fixtures are plain objects and no
 * module mocking is involved. That is deliberate: the sibling hook module IS
 * `mock.module`-replaced by the billing-status suite and these functions
 * must stay importable un-mocked.
 */
import { describe, expect, test } from "bun:test";

import { MODELS_BY_PROVIDER } from "@/assistant/llm-model-catalog";
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

describe("mainAgent call-site tweak composition", () => {
  // Real catalog ids: the composition's serves-model check reads the client
  // model catalog, so fake ids would always look foreign.
  const ANTHROPIC_MODEL = MODELS_BY_PROVIDER.anthropic[0]?.id ?? "";
  const OPENAI_MODEL = MODELS_BY_PROVIDER.openai[0]?.id ?? "";

  const BYOK_WINNER_LLM = (
    callSites: NonNullable<LlmConfig>["callSites"],
  ): LlmConfig => ({
    activeProfile: "p",
    callSites,
    profiles: {
      p: {
        provider: "anthropic",
        model: ANTHROPIC_MODEL,
        provider_connection: "my-anthropic",
      },
    },
  });

  test("a model tweak served by the winner's provider keeps the BYOK verdict", () => {
    expect(
      classify({
        llm: BYOK_WINNER_LLM({ mainAgent: { model: ANTHROPIC_MODEL } }),
        connections: [BYOK_ANTHROPIC],
      }),
    ).toBe(false);
  });

  test("a model tweak owned by another provider voids the BYOK proof", () => {
    // The daemon stamps the model's catalog owner and drops the winner's
    // binding, so the availability proof no longer attests the dispatch
    // route and the verdict degrades to unknown (banners up).
    expect(
      classify({
        llm: BYOK_WINNER_LLM({ mainAgent: { model: OPENAI_MODEL } }),
        connections: [BYOK_ANTHROPIC],
      }),
    ).toBeNull();
  });

  test("a foreign model tweak classifies by the implied provider's connections", () => {
    // Unbound implied dispatch consults the implied provider's connections:
    // a platform-auth openai connection makes the route managed, while an
    // api-key one leaves a BYOK-looking route whose proof was voided.
    expect(
      classify({
        llm: BYOK_WINNER_LLM({ mainAgent: { model: OPENAI_MODEL } }),
        connections: [
          BYOK_ANTHROPIC,
          conn({
            name: "managed-openai",
            provider: "openai",
            auth: { type: "platform" },
          }),
        ],
      }),
    ).toBe(true);
    expect(
      classify({
        llm: BYOK_WINNER_LLM({ mainAgent: { model: OPENAI_MODEL } }),
        connections: [
          BYOK_ANTHROPIC,
          conn({ name: "my-openai", provider: "openai" }),
        ],
      }),
    ).toBeNull();
  });

  test("an explicit provider tweak voids the BYOK proof but keeps a managed binding decisive", () => {
    expect(
      classify({
        llm: BYOK_WINNER_LLM({ mainAgent: { provider: "openai" } }),
        connections: [BYOK_ANTHROPIC],
      }),
    ).toBeNull();
    expect(
      classify({
        llm: {
          activeProfile: "p",
          callSites: { mainAgent: { provider: "openai" } },
          profiles: {
            p: {
              provider: "anthropic",
              model: ANTHROPIC_MODEL,
              provider_connection: "managed-anthropic",
            },
          },
        },
        connections: [PLATFORM_ANTHROPIC],
      }),
    ).toBe(true);
  });

  test("a vellum winner keeps managed routing under a concrete provider tweak", () => {
    expect(
      classify({
        llm: {
          activeProfile: "p",
          callSites: { mainAgent: { provider: "anthropic" } },
          profiles: { p: { provider: "vellum", model: ANTHROPIC_MODEL } },
        },
      }),
    ).toBe(true);
  });
});

describe("stale managed default stubs", () => {
  // The wire marks managed-source code-default entries `invariant`; a stale
  // unusable stub of one is ignored by the daemon (`providerAwareEntry`) and
  // resolves the pure catalog body through `llm.defaultProvider`, so it must
  // classify as that route instead of falling through the chain.
  const STALE_BALANCED = {
    source: "managed",
    status: "disabled",
    invariant: true,
  } as const;

  test("a stale invariant stub classifies as the default-provider route, not the next rung", () => {
    expect(
      classify({
        llm: {
          activeProfile: "balanced",
          callSites: { mainAgent: { profile: "byok-pin" } },
          profiles: {
            balanced: STALE_BALANCED,
            "byok-pin": {
              provider: "anthropic",
              model: "claude",
              provider_connection: "my-anthropic",
            },
          },
          defaultProvider: { provider: "vellum" },
        },
        connections: [BYOK_ANTHROPIC],
      }),
    ).toBe(true);
  });

  test("a stale invariant stub with no default provider is managed (catalog vellum column)", () => {
    expect(
      classify({
        llm: {
          activeProfile: "balanced",
          profiles: { balanced: STALE_BALANCED },
        },
      }),
    ).toBe(true);
  });

  test("a stale invariant stub follows a BYOK default provider", () => {
    expect(
      classify({
        llm: {
          activeProfile: "balanced",
          profiles: { balanced: STALE_BALANCED },
          defaultProvider: {
            provider: "anthropic",
            connectionName: "my-anthropic",
          },
        },
        connections: [BYOK_ANTHROPIC],
      }),
    ).toBe(false);
  });

  test("a disabled user-owned shadow still falls through the chain", () => {
    expect(
      classify({
        llm: {
          activeProfile: "shadow",
          callSites: { mainAgent: { profile: "pinned" } },
          profiles: {
            shadow: {
              provider: "anthropic",
              model: "claude",
              status: "disabled",
              source: "user",
            },
            pinned: { provider: "vellum", model: "claude" },
          },
        },
      }),
    ).toBe(true);
  });

  test("a stale invariant stub named as a mix arm resolves the default-provider route", () => {
    expect(
      classify({
        llm: {
          activeProfile: "mixed",
          profiles: {
            mixed: { mix: [{ profile: "balanced", weight: 1 }] },
            balanced: STALE_BALANCED,
          },
          defaultProvider: { provider: "vellum" },
        },
      }),
    ).toBe(true);
  });
});

describe("anchor fallbacks", () => {
  test("the legacy top-level llm.default is never consulted", () => {
    // The daemon's mainAgent resolver no longer reads `llm.default`; a stale
    // managed value must not defeat a genuine BYOK default-provider verdict.
    expect(
      classify({
        llm: {
          default: { provider: "vellum", model: "claude" },
          defaultProvider: {
            provider: "anthropic",
            connectionName: "my-anthropic",
          },
        },
        connections: [BYOK_ANTHROPIC],
        defaultProviderAvailability: "ok",
      }),
    ).toBe(false);
    expect(
      classify({ llm: { default: { provider: "vellum", model: "claude" } } }),
    ).toBeNull();
  });

  test("an unset connectionName binds through the resolved conventional connection", () => {
    // The daemon stamps `resolveDefaultConnectionName` onto default bodies;
    // without it the anchor would misread as unbound and a coexisting
    // platform-auth row for the provider would classify the route managed.
    expect(
      classify({
        llm: { defaultProvider: { provider: "anthropic" } },
        connections: [BYOK_ANTHROPIC, PLATFORM_ANTHROPIC],
        defaultProviderAvailability: "ok",
        defaultProviderResolvedConnection: "my-anthropic",
      }),
    ).toBe(false);
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
