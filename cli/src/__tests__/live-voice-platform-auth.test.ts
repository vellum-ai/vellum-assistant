import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  LiveVoiceTokenMintError,
  mintLiveVoiceToken,
} from "../lib/live-voice/platform-auth.js";
import { authHeaders, invalidateOrgIdCache } from "../lib/platform-client.js";

const SESSION_TOKEN = "session-token-value";
const ASSISTANT_ID = "11111111-2222-3333-4444-555555555555";
const PLATFORM_URL = "https://platform.example.com";
const ORIGINAL_FETCH = globalThis.fetch;

describe("managed live-voice authentication", () => {
  beforeEach(() => {
    invalidateOrgIdCache(SESSION_TOKEN, PLATFORM_URL);
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    invalidateOrgIdCache(SESSION_TOKEN, PLATFORM_URL);
  });

  test("mints with session and organization headers", async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    globalThis.fetch = mock(
      async (url: RequestInfo | URL, init?: RequestInit) => {
        requests.push({ url: String(url), init });
        if (String(url).endsWith("/v1/organizations/")) {
          return Response.json({
            results: [{ id: "org-abc", name: "Example Organization" }],
          });
        }
        return Response.json({ token: "minted-token", expiresAt });
      },
    ) as unknown as typeof globalThis.fetch;

    const result = await mintLiveVoiceToken(
      SESSION_TOKEN,
      ASSISTANT_ID,
      PLATFORM_URL,
    );

    expect(result).toEqual({ token: "minted-token", expiresAt });
    expect(requests).toHaveLength(2);
    expect(requests[1]?.url).toBe(`${PLATFORM_URL}/v1/auth/live-voice-token/`);
    expect(requests[1]?.init?.method).toBe("POST");
    const headers = new Headers(requests[1]?.init?.headers);
    expect(headers.get("X-Session-Token")).toBe(SESSION_TOKEN);
    expect(headers.get("Vellum-Organization-Id")).toBe("org-abc");
    expect(headers.get("Authorization")).toBeNull();
    expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({
      assistantId: ASSISTANT_ID,
    });
  });

  test("retries once with a fresh organization after a cached-org 401", async () => {
    const organizationIds: string[] = [];
    let organizationLookup = 0;
    let mintRequest = 0;
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    globalThis.fetch = mock(
      async (url: RequestInfo | URL, init?: RequestInit) => {
        if (String(url).endsWith("/v1/organizations/")) {
          organizationLookup += 1;
          return Response.json({
            results: [
              {
                id: organizationLookup === 1 ? "org-old" : "org-new",
                name: "Example Organization",
              },
            ],
          });
        }

        mintRequest += 1;
        organizationIds.push(
          new Headers(init?.headers).get("Vellum-Organization-Id") ?? "",
        );
        return mintRequest === 1
          ? Response.json({}, { status: 401 })
          : Response.json({ token: "minted-token", expiresAt });
      },
    ) as unknown as typeof globalThis.fetch;

    await authHeaders(SESSION_TOKEN, PLATFORM_URL);
    const result = await mintLiveVoiceToken(
      SESSION_TOKEN,
      ASSISTANT_ID,
      PLATFORM_URL,
    );

    expect(result).toEqual({ token: "minted-token", expiresAt });
    expect(organizationLookup).toBe(2);
    expect(mintRequest).toBe(2);
    expect(organizationIds).toEqual(["org-old", "org-new"]);
  });

  test("rejects platform API keys before making a request", async () => {
    const fetchMock = mock(async () => Response.json({}));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    await expect(
      mintLiveVoiceToken("vak_example", ASSISTANT_ID, PLATFORM_URL),
    ).rejects.toMatchObject({
      name: "LiveVoiceTokenMintError",
      code: "api_key_unsupported",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("rejects malformed token responses without exposing the token", async () => {
    globalThis.fetch = mock(async (url: RequestInfo | URL) => {
      if (String(url).endsWith("/v1/organizations/")) {
        return Response.json({
          results: [{ id: "org-abc", name: "Example Organization" }],
        });
      }
      return Response.json({
        token: "secret-minted-token",
        expiresAt: 123,
      });
    }) as unknown as typeof globalThis.fetch;

    try {
      await mintLiveVoiceToken(SESSION_TOKEN, ASSISTANT_ID, PLATFORM_URL);
      throw new Error("Expected token minting to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(LiveVoiceTokenMintError);
      expect((error as LiveVoiceTokenMintError).code).toBe(
        "malformed_response",
      );
      expect(String(error)).not.toContain("secret-minted-token");
      expect(String(error)).not.toContain(SESSION_TOKEN);
    }
  });

  test("does not include platform error bodies or credentials in errors", async () => {
    globalThis.fetch = mock(async (url: RequestInfo | URL) => {
      if (String(url).endsWith("/v1/organizations/")) {
        return Response.json({
          results: [{ id: "org-abc", name: "Example Organization" }],
        });
      }
      return Response.json(
        { detail: "secret-response-value" },
        { status: 503 },
      );
    }) as unknown as typeof globalThis.fetch;

    try {
      await mintLiveVoiceToken(SESSION_TOKEN, ASSISTANT_ID, PLATFORM_URL);
      throw new Error("Expected token minting to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(LiveVoiceTokenMintError);
      expect((error as LiveVoiceTokenMintError).status).toBe(503);
      expect(String(error)).not.toContain("secret-response-value");
      expect(String(error)).not.toContain(SESSION_TOKEN);
    }
  });
});
