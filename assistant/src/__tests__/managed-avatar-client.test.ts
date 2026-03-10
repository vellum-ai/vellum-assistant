import { beforeEach, describe, expect, mock, test } from "bun:test";

import { createHash } from "crypto";

// ---------------------------------------------------------------------------
// Mock dependencies — must be before importing the module under test
// ---------------------------------------------------------------------------

let mockApiKey: string | undefined = "test-api-key-123";
let mockBaseUrl = "https://platform.vellum.ai";
let mockPlatformEnvUrl = "https://env.vellum.ai";

mock.module("../security/secure-keys.js", () => ({
  getSecureKey: (account: string) => {
    if (account === "credential:vellum:assistant_api_key") return mockApiKey;
    return undefined;
  },
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    platform: { baseUrl: mockBaseUrl },
  }),
}));

mock.module("../config/env.js", () => ({
  getPlatformBaseUrl: () => mockPlatformEnvUrl,
}));

mock.module("../util/logger.js", () => ({
  getLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

// Mock global fetch
let lastFetchArgs: [string, RequestInit] | null = null;
let fetchResponse: {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
} = {
  ok: true,
  status: 200,
  json: async () => ({}),
  text: async () => "",
};

globalThis.fetch = (async (url: string, init: RequestInit) => {
  lastFetchArgs = [url, init];
  return fetchResponse;
}) as typeof globalThis.fetch;

// Import after mocking
import {
  AVATAR_MAX_DECODED_BYTES,
  AVATAR_PROMPT_MAX_LENGTH,
  ManagedAvatarError,
  VERTEX_IMAGE_DEFAULT_MODEL,
} from "../media/avatar-types.js";
import {
  generateManagedAvatar,
  isManagedAvailable,
} from "../media/managed-avatar-client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SMALL_PNG_BASE64 = "iVBORw0KGgo=";

function successResponse() {
  return {
    predictions: [
      {
        bytesBase64Encoded: SMALL_PNG_BASE64,
        mimeType: "image/png",
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockApiKey = "test-api-key-123";
  mockBaseUrl = "https://platform.vellum.ai";
  mockPlatformEnvUrl = "https://env.vellum.ai";
  lastFetchArgs = null;
  fetchResponse = {
    ok: true,
    status: 200,
    json: async () => successResponse(),
    text: async () => JSON.stringify(successResponse()),
  };
});

describe("generateManagedAvatar", () => {
  test("successful generation returns parsed response", async () => {
    const result = await generateManagedAvatar("a friendly robot avatar");

    expect(result.image.mime_type).toBe("image/png");
    expect(result.image.data_base64).toBe(SMALL_PNG_BASE64);
    // bytes is computed from base64 length, not from the server response
    const padding = SMALL_PNG_BASE64.endsWith("==")
      ? 2
      : SMALL_PNG_BASE64.endsWith("=")
        ? 1
        : 0;
    const expectedBytes =
      Math.ceil((SMALL_PNG_BASE64.length * 3) / 4) - padding;
    expect(result.image.bytes).toBe(expectedBytes);
    const expectedSha256 = createHash("sha256")
      .update(Buffer.from(SMALL_PNG_BASE64, "base64"))
      .digest("hex");
    expect(result.image.sha256).toBe(expectedSha256);
    expect(result.generation_source).toBe("vertex");
    expect(result.profile).toBe(VERTEX_IMAGE_DEFAULT_MODEL);
    expect(result.usage.billable).toBe(true);
    expect(result.usage.class_name).toBe("image_generation");
    expect(result.correlation_id).toBeDefined();
  });

  test("fetch URL matches runtime proxy Vertex endpoint with default model", async () => {
    await generateManagedAvatar("test prompt");

    expect(lastFetchArgs).not.toBeNull();
    const url = lastFetchArgs![0];
    expect(url).toBe(
      `https://platform.vellum.ai/v1/runtime-proxy/vertex/v1/models/${VERTEX_IMAGE_DEFAULT_MODEL}:predict`,
    );
  });

  test("custom model is used in the URL path", async () => {
    const customModel = "imagen-3.0-fast-generate-001";
    await generateManagedAvatar("test prompt", { model: customModel });

    expect(lastFetchArgs).not.toBeNull();
    const url = lastFetchArgs![0];
    expect(url).toBe(
      `https://platform.vellum.ai/v1/runtime-proxy/vertex/v1/models/${customModel}:predict`,
    );
  });

  test("request body uses Vertex Imagen format", async () => {
    await generateManagedAvatar("a cool robot");

    expect(lastFetchArgs).not.toBeNull();
    const body = JSON.parse(lastFetchArgs![1].body as string);
    expect(body).toEqual({
      instances: [{ prompt: "a cool robot" }],
      parameters: {
        sampleCount: 1,
        aspectRatio: "1:1",
        outputOptions: { mimeType: "image/png" },
      },
    });
  });

  test("prompt exceeding max length throws ManagedAvatarError with code validation_error", async () => {
    const longPrompt = "x".repeat(AVATAR_PROMPT_MAX_LENGTH + 1);

    try {
      await generateManagedAvatar(longPrompt);
      expect(true).toBe(false); // should not reach here
    } catch (err) {
      expect(err).toBeInstanceOf(ManagedAvatarError);
      const avatarErr = err as ManagedAvatarError;
      expect(avatarErr.code).toBe("validation_error");
      expect(avatarErr.subcode).toBe("prompt_too_long");
    }
  });

  test("HTTP 429 response throws ManagedAvatarError with retryable true", async () => {
    fetchResponse = {
      ok: false,
      status: 429,
      json: async () => ({}),
      text: async () => "Rate limit exceeded",
    };

    try {
      await generateManagedAvatar("test prompt");
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(ManagedAvatarError);
      const avatarErr = err as ManagedAvatarError;
      expect(avatarErr.retryable).toBe(true);
      expect(avatarErr.statusCode).toBe(429);
      expect(avatarErr.code).toBe("upstream_error");
      expect(avatarErr.subcode).toBe("http_error");
    }
  });

  test("HTTP 500 response throws retryable ManagedAvatarError", async () => {
    fetchResponse = {
      ok: false,
      status: 500,
      json: async () => ({}),
      text: async () => "Internal server error",
    };

    try {
      await generateManagedAvatar("test prompt");
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(ManagedAvatarError);
      const avatarErr = err as ManagedAvatarError;
      expect(avatarErr.code).toBe("upstream_error");
      expect(avatarErr.subcode).toBe("http_error");
      expect(avatarErr.statusCode).toBe(500);
      expect(avatarErr.retryable).toBe(true);
    }
  });

  test("HTTP 400 response throws non-retryable ManagedAvatarError", async () => {
    fetchResponse = {
      ok: false,
      status: 400,
      json: async () => ({}),
      text: async () => "Model not allowed on this platform",
    };

    try {
      await generateManagedAvatar("test prompt");
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(ManagedAvatarError);
      const avatarErr = err as ManagedAvatarError;
      expect(avatarErr.code).toBe("upstream_error");
      expect(avatarErr.subcode).toBe("http_error");
      expect(avatarErr.statusCode).toBe(400);
      expect(avatarErr.retryable).toBe(false);
    }
  });

  test("response with disallowed MIME type throws validation error", async () => {
    fetchResponse = {
      ok: true,
      status: 200,
      json: async () => ({
        predictions: [
          {
            bytesBase64Encoded: SMALL_PNG_BASE64,
            mimeType: "image/gif",
          },
        ],
      }),
      text: async () => "",
    };

    try {
      await generateManagedAvatar("test prompt");
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(ManagedAvatarError);
      const avatarErr = err as ManagedAvatarError;
      expect(avatarErr.code).toBe("validation_error");
      expect(avatarErr.subcode).toBe("disallowed_mime_type");
    }
  });

  test("response with oversized image throws validation error", async () => {
    const oversizedBase64 = "A".repeat(
      Math.ceil(((AVATAR_MAX_DECODED_BYTES + 100) * 4) / 3),
    );
    fetchResponse = {
      ok: true,
      status: 200,
      json: async () => ({
        predictions: [
          {
            bytesBase64Encoded: oversizedBase64,
            mimeType: "image/png",
          },
        ],
      }),
      text: async () => "",
    };

    try {
      await generateManagedAvatar("test prompt");
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(ManagedAvatarError);
      const avatarErr = err as ManagedAvatarError;
      expect(avatarErr.code).toBe("validation_error");
      expect(avatarErr.subcode).toBe("oversized_image");
    }
  });

  test("Authorization header uses Api-Key prefix", async () => {
    await generateManagedAvatar("test prompt");

    expect(lastFetchArgs).not.toBeNull();
    const headers = lastFetchArgs![1].headers as Record<string, string>;
    expect(headers.Authorization).toBe("Api-Key test-api-key-123");
    expect(headers.Authorization).not.toContain("Bearer");
  });

  test("Idempotency-Key header is present on every request", async () => {
    await generateManagedAvatar("test prompt");

    expect(lastFetchArgs).not.toBeNull();
    const headers = lastFetchArgs![1].headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBeDefined();
    expect(headers["Idempotency-Key"].length).toBeGreaterThan(0);
  });

  test("caller-provided idempotencyKey is used in the request header", async () => {
    const customKey = "my-custom-idempotency-key-123";
    await generateManagedAvatar("test prompt", { idempotencyKey: customKey });

    expect(lastFetchArgs).not.toBeNull();
    const headers = lastFetchArgs![1].headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBe(customKey);
  });
});

describe("isManagedAvailable", () => {
  test("returns false when API key is missing", () => {
    mockApiKey = undefined;
    expect(isManagedAvailable()).toBe(false);
  });

  test("returns false when base URL is missing", () => {
    mockBaseUrl = "";
    mockPlatformEnvUrl = "";
    expect(isManagedAvailable()).toBe(false);
  });

  test("returns true when both API key and base URL are present", () => {
    expect(isManagedAvailable()).toBe(true);
  });
});
