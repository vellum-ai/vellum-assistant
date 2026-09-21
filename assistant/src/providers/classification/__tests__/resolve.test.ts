import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

import type { AssistantConfig } from "../../../config/types.js";

let storedKeys: Record<string, string> = {};
let storedAccounts: Record<string, string> = {};
let managedContext = {
  enabled: false,
  platformBaseUrl: "",
  assistantApiKey: "",
};

// Spread the real modules so the overrides do not strip exports other test
// files in the same process depend on.
const actualSecureKeys = await import("../../../security/secure-keys.js");
mock.module("../../../security/secure-keys.js", () => ({
  ...actualSecureKeys,
  getProviderKeyAsync: async (provider: string) => storedKeys[provider],
  getSecureKeyAsync: async (account: string) => storedAccounts[account],
}));
const actualContext = await import("../../platform-proxy/context.js");
mock.module("../../platform-proxy/context.js", () => ({
  ...actualContext,
  resolveManagedProxyContext: async () => managedContext,
}));

const { resolveClassificationAvailability, resolveClassificationProvider } =
  await import("../resolve.js");

const PLATFORM_BASE = "https://platform.example.com";
const ASSISTANT_KEY = "ast-managed-key";

function configWith(
  classification: Partial<AssistantConfig["services"]["classification"]>,
): AssistantConfig {
  return {
    services: {
      classification: {
        mode: "your-own",
        provider: "typesafe",
        model: "jev-latest",
        ...classification,
      },
    },
  } as unknown as AssistantConfig;
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  storedKeys = {};
  storedAccounts = {};
  managedContext = { enabled: false, platformBaseUrl: "", assistantApiKey: "" };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

afterAll(() => {
  mock.restore();
});

describe("resolveClassificationProvider", () => {
  test("your-own mode dispatches on the stored TypeSafe key", async () => {
    storedKeys.typesafe = "sk-typesafe";

    const resolved = await resolveClassificationProvider(configWith({}));

    expect(resolved).not.toBeNull();
    expect(resolved?.provider.name).toBe("typesafe");
    expect(resolved?.source).toBe("user-key");
    expect(resolved?.model).toBe("jev-latest");
    expect(resolved?.maxInputTokens).toBe(32_000);
  });

  test("your-own mode without a stored key resolves nothing", async () => {
    expect(await resolveClassificationProvider(configWith({}))).toBeNull();
    expect(await resolveClassificationAvailability(configWith({}))).toEqual({
      available: false,
      mode: "your-own",
      providerId: "typesafe",
      model: "jev-latest",
      reason: "missing_credential",
    });
  });

  test("managed mode needs the platform connection", async () => {
    storedKeys.typesafe = "sk-typesafe";

    expect(
      await resolveClassificationProvider(configWith({ mode: "managed" })),
    ).toBeNull();
    expect(
      await resolveClassificationAvailability(configWith({ mode: "managed" })),
    ).toMatchObject({ available: false, reason: "platform_unavailable" });
  });

  test("managed mode sends System One through the typesafe runtime-proxy path with the assistant key", async () => {
    managedContext = {
      enabled: true,
      platformBaseUrl: PLATFORM_BASE,
      assistantApiKey: ASSISTANT_KEY,
    };
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      capturedUrl = String(input);
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      return new Response(
        JSON.stringify({
          model: "jev-latest",
          answers: { answer: { type: "noul", noul: 0.9 } },
          usage: { input_tokens: 1, output_tokens: 0 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const resolved = await resolveClassificationProvider(
      configWith({ mode: "managed" }),
    );
    expect(resolved?.source).toBe("managed-proxy");
    await resolved!.provider.sendMessage([
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ]);

    expect(capturedUrl).toBe(
      `${PLATFORM_BASE}/v1/runtime-proxy/typesafe/v1/systemone`,
    );
    expect(capturedHeaders.Authorization).toBe(`Bearer ${ASSISTANT_KEY}`);
    expect(
      await resolveClassificationAvailability(configWith({ mode: "managed" })),
    ).toEqual({
      available: true,
      mode: "managed",
      providerId: "typesafe",
      model: "jev-latest",
      source: "managed-proxy",
    });
  });

  test("your-own mode reads a credential override instead of the default slot", async () => {
    storedAccounts["credential/jev-work/api_key"] = "sk-custom";

    const resolved = await resolveClassificationProvider(
      configWith({ credential: "jev-work:api_key" }),
    );

    expect(resolved?.source).toBe("user-key");
    expect(
      await resolveClassificationAvailability(
        configWith({ credential: "jev-work:api_key" }),
      ),
    ).toMatchObject({ available: true, source: "user-key" });
    expect(
      await resolveClassificationProvider(
        configWith({ credential: "credential/missing/api_key" }),
      ),
    ).toBeNull();
  });

  test("a cleared (null) credential override falls back to the default slot", async () => {
    storedKeys.typesafe = "sk-typesafe";

    const resolved = await resolveClassificationProvider(
      configWith({ credential: null }),
    );

    expect(resolved?.source).toBe("user-key");
  });

  test("an unlisted model still resolves, with the default budget", async () => {
    storedKeys.typesafe = "sk-typesafe";

    const resolved = await resolveClassificationProvider(
      configWith({ model: "jev-2027-01-01" }),
    );

    expect(resolved?.model).toBe("jev-2027-01-01");
    expect(resolved?.maxInputTokens).toBe(32_000);
  });
});
