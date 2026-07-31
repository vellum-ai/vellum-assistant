import { describe, expect, test } from "bun:test";

import type { AssistantEntry } from "../lib/assistant-config.js";
import {
  buildDirectLiveVoiceWebSocketUrl,
  buildManagedLiveVoiceWebSocketUrl,
  LiveVoiceConnectionError,
  preflightLiveVoice,
  resolveLiveVoiceConnection,
  type LiveVoiceConnectionDependencyOverrides,
} from "../lib/live-voice/connection.js";

const LOCAL_ENTRY: AssistantEntry = {
  assistantId: "assistant-123",
  name: "Example Assistant",
  cloud: "local",
  runtimeUrl: "http://localhost:7830",
  localUrl: "http://127.0.0.1:7830",
  species: "vellum",
};

const MANAGED_ENTRY: AssistantEntry = {
  assistantId: "assistant-456",
  name: "Managed Assistant",
  cloud: "vellum",
  runtimeUrl: "https://platform.vellum.ai",
  species: "vellum",
};

function makeDependencies(
  overrides: LiveVoiceConnectionDependencyOverrides = {},
): LiveVoiceConnectionDependencyOverrides {
  return {
    resolveTargetAssistant: () => LOCAL_ENTRY,
    loadGuardianSessionAccessToken: () => "guardian-secret",
    resolveGuardianSessionAuth: async ({ accessToken }) => ({
      ok: true,
      accessToken,
      refreshed: false,
    }),
    readPlatformToken: () => "platform-session-secret",
    getPlatformUrl: () => "https://platform.vellum.ai",
    mintLiveVoiceToken: async () => ({
      token: "single-use-secret",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
    fetch: async () => Response.json({ status: "ready" }),
    getVelayBaseUrl: () => undefined,
    ...overrides,
  };
}

describe("live-voice connection routing", () => {
  test("routes an explicit URL and assistant ID directly", async () => {
    const connection = await resolveLiveVoiceConnection(
      {
        url: "http://127.0.0.1:7830/",
        assistantId: "assistant-123",
      },
      makeDependencies(),
    );

    expect(connection).toMatchObject({
      topology: "direct",
      assistantId: "assistant-123",
      gatewayUrl: "http://127.0.0.1:7830/",
      webSocket: {
        url: "ws://127.0.0.1:7830/v1/live-voice",
        logSafeUrl: "ws://127.0.0.1:7830/v1/live-voice",
        headers: { Authorization: "Bearer guardian-secret" },
      },
    });
  });

  test("resolves a target name for an explicit direct URL", async () => {
    const connection = await resolveLiveVoiceConnection(
      {
        target: "Example Assistant",
        url: "http://localhost:7830",
      },
      makeDependencies({
        resolveTargetAssistant: (target) => {
          expect(target).toBe("Example Assistant");
          return LOCAL_ENTRY;
        },
      }),
    );

    expect(connection.assistantId).toBe("assistant-123");
    expect(connection.topology).toBe("direct");
  });

  test("requires an assistant ID with an unbound explicit URL", async () => {
    await expect(
      resolveLiveVoiceConnection(
        { url: "http://127.0.0.1:7830" },
        makeDependencies(),
      ),
    ).rejects.toMatchObject({
      name: "LiveVoiceConnectionError",
      code: "assistant_id_required",
    });
  });

  test("routes a standard local entry through its local gateway", async () => {
    const connection = await resolveLiveVoiceConnection({}, makeDependencies());

    expect(connection.topology).toBe("direct");
    if (connection.topology === "direct") {
      expect(connection.gatewayUrl).toBe("http://127.0.0.1:7830/");
      expect(connection.preflight).toEqual({ status: "ready" });
    }
  });

  test("keeps an IS_PLATFORM local assistant on the direct path", async () => {
    const previous = process.env.IS_PLATFORM;
    process.env.IS_PLATFORM = "1";
    try {
      const connection = await resolveLiveVoiceConnection(
        {},
        makeDependencies({
          resolveTargetAssistant: () => ({
            ...LOCAL_ENTRY,
            runtimeUrl: "http://127.0.0.1:7930",
            localUrl: undefined,
          }),
        }),
      );

      expect(connection.topology).toBe("direct");
      expect(connection.webSocket.url).toBe(
        "ws://127.0.0.1:7930/v1/live-voice",
      );
    } finally {
      if (previous === undefined) {
        delete process.env.IS_PLATFORM;
      } else {
        process.env.IS_PLATFORM = previous;
      }
    }
  });

  test("an explicit URL stays direct even for a managed lockfile target", async () => {
    let minted = false;
    const connection = await resolveLiveVoiceConnection(
      {
        url: "http://127.0.0.1:7830",
        target: "Managed Assistant",
      },
      makeDependencies({
        resolveTargetAssistant: () => MANAGED_ENTRY,
        mintLiveVoiceToken: async () => {
          minted = true;
          throw new Error("should not mint");
        },
      }),
    );

    expect(connection.topology).toBe("direct");
    expect(minted).toBe(false);
  });

  test("routes managed assistants through environment-correct Velay", async () => {
    const mintCalls: string[][] = [];
    const connection = await resolveLiveVoiceConnection(
      {},
      makeDependencies({
        resolveTargetAssistant: () => MANAGED_ENTRY,
        getPlatformUrl: () => "https://staging-platform.vellum.ai",
        mintLiveVoiceToken: async (sessionToken, assistantId, platformUrl) => {
          mintCalls.push([sessionToken, assistantId, platformUrl ?? ""]);
          return {
            token: "single-use-secret",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          };
        },
      }),
    );

    expect(connection.topology).toBe("vellum-managed");
    expect(connection.webSocket.url).toBe(
      "wss://velay-staging.vellum.ai/assistant-456/v1/live-voice?token=single-use-secret",
    );
    expect(connection.webSocket.logSafeUrl).toBe(
      "wss://velay-staging.vellum.ai/assistant-456/v1/live-voice?token=%5BREDACTED%5D",
    );
    expect(connection.webSocket.headers).toBeUndefined();
    expect(mintCalls).toEqual([
      [
        "platform-session-secret",
        "assistant-456",
        "https://staging-platform.vellum.ai",
      ],
    ]);
    expect(connection.webSocket.url).not.toContain("platform-session-secret");
  });

  test("uses plain ws only for an explicit loopback Velay endpoint", async () => {
    const connection = await resolveLiveVoiceConnection(
      {},
      makeDependencies({
        resolveTargetAssistant: () => MANAGED_ENTRY,
        getPlatformUrl: () => "http://127.0.0.1:8000",
        getVelayBaseUrl: () => "http://127.0.0.1:8501",
      }),
    );

    expect(connection.webSocket.url).toBe(
      "ws://127.0.0.1:8501/assistant-456/v1/live-voice?token=single-use-secret",
    );
  });

  test("permits a secure explicit remote Velay endpoint", () => {
    expect(
      buildManagedLiveVoiceWebSocketUrl({
        assistantId: "assistant-123",
        token: "single-use-secret",
        platformUrl: "https://platform.vellum.ai",
        velayBaseUrl: "https://voice.example.com",
      }),
    ).toBe(
      "wss://voice.example.com/assistant-123/v1/live-voice?token=single-use-secret",
    );
  });

  test("rejects insecure remote gateway and Velay endpoints", async () => {
    await expect(
      resolveLiveVoiceConnection(
        {
          url: "http://gateway.example.com",
          assistantId: "assistant-123",
        },
        makeDependencies(),
      ),
    ).rejects.toMatchObject({ code: "remote_tls_required" });

    expect(() =>
      buildManagedLiveVoiceWebSocketUrl({
        assistantId: "assistant-123",
        token: "single-use-secret",
        platformUrl: "https://platform.vellum.ai",
        velayBaseUrl: "ws://voice.example.com",
      }),
    ).toThrow("Remote live-voice endpoints must use TLS.");
  });

  test("requires guardian authentication for a remote direct gateway", async () => {
    await expect(
      resolveLiveVoiceConnection(
        {
          url: "https://gateway.example.com",
          assistantId: "assistant-123",
        },
        makeDependencies({
          loadGuardianSessionAccessToken: () => undefined,
        }),
      ),
    ).rejects.toMatchObject({
      code: "guardian_auth_required",
    });
  });

  test("allows an intentionally unauthenticated loopback gateway", async () => {
    const connection = await resolveLiveVoiceConnection(
      {
        url: "http://127.0.0.1:7830",
        assistantId: "assistant-123",
      },
      makeDependencies({
        loadGuardianSessionAccessToken: () => undefined,
      }),
    );

    expect(connection.topology).toBe("direct");
    expect(connection.webSocket.headers).toBeUndefined();
    expect(connection.webSocket.url).not.toContain("token=");
  });

  test("blocks an explicit not-ready preflight verdict", async () => {
    await expect(
      resolveLiveVoiceConnection(
        {
          url: "http://127.0.0.1:7830",
          assistantId: "assistant-123",
        },
        makeDependencies({
          fetch: async () =>
            Response.json({
              status: "not-ready",
              userMessage: "Connect speech providers.",
            }),
        }),
      ),
    ).rejects.toMatchObject({
      code: "not_ready",
      message:
        "Live voice is not ready. Configure speech-to-text and text-to-speech providers first.",
    });
  });

  test("fails open when direct preflight transport is unavailable", async () => {
    const connection = await resolveLiveVoiceConnection(
      {
        url: "http://127.0.0.1:7830",
        assistantId: "assistant-123",
      },
      makeDependencies({
        fetch: async () => {
          throw new Error("offline");
        },
      }),
    );

    expect(connection.topology).toBe("direct");
    if (connection.topology === "direct") {
      expect(connection.preflight).toEqual({ status: "unavailable" });
    }
  });

  test("passes guardian authentication in headers, never the URL", async () => {
    const preflightAuthorizations: (string | null)[] = [];
    const connection = await resolveLiveVoiceConnection(
      {
        url: "https://gateway.example.com",
        assistantId: "assistant-123",
        guardianToken: "ephemeral-guardian-secret",
      },
      makeDependencies({
        fetch: async (_input, init) => {
          preflightAuthorizations.push(
            new Headers(init?.headers).get("Authorization"),
          );
          return Response.json({ status: "ready" });
        },
      }),
    );

    expect(connection.webSocket.headers).toEqual({
      Authorization: "Bearer ephemeral-guardian-secret",
    });
    expect(connection.webSocket.url).toBe(
      "wss://gateway.example.com/v1/live-voice",
    );
    expect(connection.webSocket.url).not.toContain("ephemeral-guardian-secret");
    expect(preflightAuthorizations).toEqual([
      "Bearer ephemeral-guardian-secret",
    ]);
  });

  test("rejects Docker and paired targets before network access", async () => {
    let networkCalls = 0;
    const deps = makeDependencies({
      fetch: async () => {
        networkCalls += 1;
        return Response.json({ status: "ready" });
      },
      mintLiveVoiceToken: async () => {
        networkCalls += 1;
        return {
          token: "single-use-secret",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        };
      },
    });

    for (const cloud of ["docker", "paired"] as const) {
      await expect(
        resolveLiveVoiceConnection(
          {},
          {
            ...deps,
            resolveTargetAssistant: () => ({
              ...LOCAL_ENTRY,
              cloud,
            }),
          },
        ),
      ).rejects.toMatchObject({
        code: "unsupported_topology",
      });
    }
    expect(networkCalls).toBe(0);
  });

  test("requires a stored user session for managed assistants", async () => {
    await expect(
      resolveLiveVoiceConnection(
        {},
        makeDependencies({
          resolveTargetAssistant: () => MANAGED_ENTRY,
          readPlatformToken: () => null,
        }),
      ),
    ).rejects.toMatchObject({
      code: "platform_login_required",
    });
  });

  test("redacts credentials from routing errors and diagnostic URLs", async () => {
    const guardianToken = "guardian-secret-value";
    await expect(
      resolveLiveVoiceConnection(
        {
          url: "https://gateway.example.com",
          assistantId: "assistant-123",
          guardianToken,
        },
        makeDependencies({
          resolveGuardianSessionAuth: async () => ({
            ok: false,
            accessToken: guardianToken,
            error: Object.assign(new Error(`failed for ${guardianToken}`), {
              name: "GuardianSessionAuthError",
              code: "refresh_failed" as const,
            }),
          }),
        }),
      ),
    ).rejects.not.toThrow(guardianToken);

    await expect(
      resolveLiveVoiceConnection(
        {},
        makeDependencies({
          resolveTargetAssistant: () => MANAGED_ENTRY,
          mintLiveVoiceToken: async () => {
            throw new Error("platform-session-secret");
          },
        }),
      ),
    ).rejects.not.toThrow("platform-session-secret");
  });
});

describe("direct live-voice preflight", () => {
  test("returns ready and preserves assistant-scoped guardian auth", async () => {
    let requestUrl = "";
    const requestAuthorizations: (string | null)[] = [];
    const result = await preflightLiveVoice(
      "https://gateway.example.com",
      "guardian-secret",
      async (input, init) => {
        requestUrl = String(input);
        requestAuthorizations.push(
          new Headers(init?.headers).get("Authorization"),
        );
        return Response.json({ status: "ready" });
      },
    );

    expect(result).toEqual({ status: "ready" });
    expect(requestUrl).toBe(
      "https://gateway.example.com/v1/live-voice/preflight",
    );
    expect(requestAuthorizations).toEqual(["Bearer guardian-secret"]);
  });

  test("returns an explicit not-ready verdict", async () => {
    const result = await preflightLiveVoice(
      "http://127.0.0.1:7830",
      undefined,
      async () =>
        Response.json({
          status: "not-ready",
          missing: [
            {
              kind: "stt",
              providerId: "example-stt",
              reason: "not configured",
            },
          ],
          userMessage: "Configure speech providers.",
        }),
    );

    expect(result).toEqual({
      status: "not-ready",
      missing: [
        {
          kind: "stt",
          providerId: "example-stt",
          reason: "not configured",
        },
      ],
      userMessage: "Configure speech providers.",
    });
  });

  test("fails open on transport, HTTP, and malformed response failures", async () => {
    expect(
      await preflightLiveVoice("http://127.0.0.1:7830", undefined, async () => {
        throw new Error("offline");
      }),
    ).toEqual({ status: "unavailable" });

    expect(
      await preflightLiveVoice(
        "http://127.0.0.1:7830",
        undefined,
        async () => new Response("", { status: 503 }),
      ),
    ).toEqual({ status: "unavailable" });

    expect(
      await preflightLiveVoice("http://127.0.0.1:7830", undefined, async () =>
        Response.json({ status: "future-status" }),
      ),
    ).toEqual({ status: "unavailable" });
  });
});

describe("live-voice URL builders", () => {
  test("normalizes direct gateway origins and drops paths and queries", () => {
    expect(
      buildDirectLiveVoiceWebSocketUrl(
        "https://gateway.example.com/prefix?secret=value",
      ),
    ).toBe("wss://gateway.example.com/v1/live-voice");
  });

  test("encodes managed assistant IDs and the single-use token", () => {
    expect(
      buildManagedLiveVoiceWebSocketUrl({
        assistantId: "assistant/id",
        token: "token with spaces",
        platformUrl: "https://platform.vellum.ai",
      }),
    ).toBe(
      "wss://velay.vellum.ai/assistant%2Fid/v1/live-voice?token=token+with+spaces",
    );
  });

  test("uses generic URL errors without reflecting credentials", () => {
    const secret = "secret-value";
    try {
      buildDirectLiveVoiceWebSocketUrl(`not a URL?token=${secret}`);
      throw new Error("Expected URL validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(LiveVoiceConnectionError);
      expect(String(error)).not.toContain(secret);
    }
  });
});
