import { afterEach, describe, expect, mock, test } from "bun:test";

import {
  extractModelIds,
  isModelListed,
  type ModelAccessProbeRequest,
  probeModelAccess,
} from "../model-access-probe.js";

const STORED_KEY = "AIzaSyStoredKeyFromMay2026";

const GEMINI_REQUEST: ModelAccessProbeRequest = {
  account: "credential/gemini/api_key",
  request: {
    url: "https://generativelanguage.googleapis.com/v1beta/models",
    credentialInjection: { kind: "header", name: "x-goog-api-key" },
  },
  models: ["gemini-3.1-flash-lite"],
};

const storeWith = (value: string | undefined) => ({
  get: async () => value,
});

const originalFetch = globalThis.fetch;

function mockFetch(
  handler: (input: URL | RequestInfo, init?: RequestInit) => Response,
): void {
  globalThis.fetch = mock(
    async (input: URL | RequestInfo, init?: RequestInit) =>
      handler(input, init),
  ) as unknown as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("extractModelIds", () => {
  test("GIVEN a Gemini listing WHEN extracting THEN it reads models[].name", () => {
    expect(
      extractModelIds({
        models: [
          { name: "models/gemini-2.5-flash" },
          { name: "models/gemini-2.5-pro" },
        ],
      }),
    ).toEqual(["models/gemini-2.5-flash", "models/gemini-2.5-pro"]);
  });

  test("GIVEN an OpenAI listing WHEN extracting THEN it reads data[].id", () => {
    expect(extractModelIds({ data: [{ id: "gpt-5" }] })).toEqual(["gpt-5"]);
  });

  test("GIVEN an unexpected shape WHEN extracting THEN it yields no ids", () => {
    expect(extractModelIds({ error: { message: "nope" } })).toEqual([]);
  });
});

describe("isModelListed", () => {
  test("GIVEN a Gemini-prefixed listing WHEN matching a bare id THEN it matches", () => {
    expect(isModelListed("gemini-2.5-flash", ["models/gemini-2.5-flash"])).toBe(
      true,
    );
  });

  test("GIVEN a namespaced listing WHEN matching a bare id THEN it matches", () => {
    expect(isModelListed("gemini-2.5-flash", ["google/gemini-2.5-flash"])).toBe(
      true,
    );
  });

  test("GIVEN an absent model WHEN matching THEN it does not match", () => {
    expect(
      isModelListed("gemini-3.1-flash-lite", ["models/gemini-2.5-flash"]),
    ).toBe(false);
  });
});

describe("probeModelAccess", () => {
  /**
   * The ATL-1096 case: the key authenticates, but its project cannot see
   * the model a profile is configured with.
   */
  test("GIVEN a valid key without access to the model WHEN probing THEN the model reads not_accessible", async () => {
    // GIVEN a provider listing that omits the requested model
    mockFetch(
      () =>
        new Response(
          JSON.stringify({
            models: [
              { name: "models/gemini-2.5-flash" },
              { name: "models/gemini-2.5-pro" },
            ],
          }),
          { status: 200 },
        ),
    );

    // WHEN the stored credential is probed
    const result = await probeModelAccess(
      GEMINI_REQUEST,
      storeWith(STORED_KEY),
    );

    // THEN the credential is sound but the model is out of reach
    expect(result.outcome).toBe("valid");
    expect(result.models).toEqual([
      { model: "gemini-3.1-flash-lite", access: "not_accessible" },
    ]);
  });

  /** A listing that includes the model resolves the opposite way. */
  test("GIVEN a key with access WHEN probing THEN the model reads accessible", async () => {
    // GIVEN a provider listing containing the requested model
    mockFetch(
      () =>
        new Response(
          JSON.stringify({
            models: [{ name: "models/gemini-3.1-flash-lite" }],
          }),
          { status: 200 },
        ),
    );

    // WHEN the stored credential is probed
    const result = await probeModelAccess(
      GEMINI_REQUEST,
      storeWith(STORED_KEY),
    );

    // THEN the model is reported as reachable
    expect(result.outcome).toBe("valid");
    expect(result.models[0]?.access).toBe("accessible");
    expect(result.accessibleModels).toEqual(["models/gemini-3.1-flash-lite"]);
  });

  /** The secret reaches the provider and nothing else. */
  test("GIVEN the stored credential WHEN probing THEN it is injected into the named header and never returned", async () => {
    // GIVEN a provider that rejects the key and echoes it back in the error
    let seenHeader: string | undefined;
    mockFetch((_input, init) => {
      seenHeader = (init?.headers as Record<string, string> | undefined)?.[
        "x-goog-api-key"
      ];
      return new Response(
        JSON.stringify({ error: { message: `bad key ${STORED_KEY}` } }),
        { status: 403 },
      );
    });

    // WHEN the stored credential is probed
    const result = await probeModelAccess(
      GEMINI_REQUEST,
      storeWith(STORED_KEY),
    );

    // THEN the provider saw the key and the caller sees only a redaction
    expect(seenHeader).toBe(STORED_KEY);
    expect(result.outcome).toBe("invalid");
    expect(JSON.stringify(result)).not.toContain(STORED_KEY);
    expect(result.detail).toContain("[REDACTED]");
  });

  test("GIVEN a bearer injection WHEN probing THEN the prefix is applied", async () => {
    let seenHeader: string | undefined;
    mockFetch((_input, init) => {
      seenHeader = (init?.headers as Record<string, string> | undefined)?.[
        "authorization"
      ];
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    });

    await probeModelAccess(
      {
        account: "credential/openai/api_key",
        request: {
          url: "https://api.openai.com/v1/models",
          credentialInjection: {
            kind: "header",
            name: "authorization",
            prefix: "Bearer ",
          },
        },
        models: [],
      },
      storeWith("sk-stored"),
    );

    expect(seenHeader).toBe("Bearer sk-stored");
  });

  test("GIVEN a query injection WHEN probing THEN the credential rides the named parameter", async () => {
    let seenUrl: string | undefined;
    mockFetch((input) => {
      seenUrl = String(input);
      return new Response(JSON.stringify({ models: [] }), { status: 200 });
    });

    await probeModelAccess(
      {
        ...GEMINI_REQUEST,
        request: {
          ...GEMINI_REQUEST.request,
          credentialInjection: { kind: "query", name: "key" },
        },
      },
      storeWith(STORED_KEY),
    );

    expect(seenUrl).toContain(`key=${STORED_KEY}`);
  });

  /** An empty slot is a distinct diagnosis from a rejected key. */
  test("GIVEN no stored credential WHEN probing THEN the outcome is missing_credential and no request is made", async () => {
    // GIVEN an empty credential slot
    const fetchMock = mock(async () => new Response("", { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    // WHEN the account is probed
    const result = await probeModelAccess(GEMINI_REQUEST, storeWith(undefined));

    // THEN nothing is sent upstream and the gap is named
    expect(result.outcome).toBe("missing_credential");
    expect(result.models[0]?.access).toBe("unknown");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("GIVEN an unreadable listing shape WHEN probing THEN models read unknown rather than not_accessible", async () => {
    mockFetch(
      () => new Response(JSON.stringify({ items: ["x"] }), { status: 200 }),
    );

    const result = await probeModelAccess(
      GEMINI_REQUEST,
      storeWith(STORED_KEY),
    );

    expect(result.outcome).toBe("valid");
    expect(result.models[0]?.access).toBe("unknown");
  });

  test("GIVEN a provider outage WHEN probing THEN the outcome is inconclusive rather than invalid", async () => {
    mockFetch(() => new Response("upstream exploded", { status: 503 }));

    const result = await probeModelAccess(
      GEMINI_REQUEST,
      storeWith(STORED_KEY),
    );

    expect(result.outcome).toBe("inconclusive");
    expect(result.status).toBe(503);
    expect(result.models[0]?.access).toBe("unknown");
  });

  test("GIVEN a network failure WHEN probing THEN the outcome is inconclusive", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    }) as unknown as typeof fetch;

    const result = await probeModelAccess(
      GEMINI_REQUEST,
      storeWith(STORED_KEY),
    );

    expect(result.outcome).toBe("inconclusive");
    expect(result.detail).toContain("ENOTFOUND");
  });

  test("GIVEN a non-http URL WHEN probing THEN no request is made", async () => {
    const fetchMock = mock(async () => new Response("", { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await probeModelAccess(
      {
        ...GEMINI_REQUEST,
        request: { ...GEMINI_REQUEST.request, url: "file:///etc/passwd" },
      },
      storeWith(STORED_KEY),
    );

    expect(result.outcome).toBe("inconclusive");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
