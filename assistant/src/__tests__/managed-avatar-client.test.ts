import { beforeEach, describe, expect, mock, test } from "bun:test";

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
} = {
  ok: true,
  status: 200,
  json: async () => ({}),
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
} from "../media/avatar-types.js";
import {
  generateManagedAvatar,
  isManagedAvailable,
} from "../media/managed-avatar-client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function successResponse() {
  return {
    image: {
      mime_type: "image/png",
      data_base64: "iVBORw0KGgo=",
      bytes: 1024,
      sha256: "abc123",
    },
    usage: { billable: true, class_name: "avatar" },
    generation_source: "managed",
    profile: "default",
    correlation_id: "test-corr-id",
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
  };
});

describe("generateManagedAvatar", () => {
  test("successful generation returns parsed response", async () => {
    const result = await generateManagedAvatar("a friendly robot avatar");

    expect(result.image.mime_type).toBe("image/png");
    expect(result.image.data_base64).toBe("iVBORw0KGgo=");
    expect(result.image.bytes).toBe(1024);
    expect(result.generation_source).toBe("managed");
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
      json: async () => ({
        code: "rate_limit",
        subcode: "too_many_requests",
        detail: "Rate limit exceeded",
        retryable: true,
        correlation_id: "corr-429",
      }),
    };

    try {
      await generateManagedAvatar("test prompt");
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(ManagedAvatarError);
      const avatarErr = err as ManagedAvatarError;
      expect(avatarErr.retryable).toBe(true);
      expect(avatarErr.statusCode).toBe(429);
    }
  });

  test("HTTP 500 response throws ManagedAvatarError with upstream error details", async () => {
    fetchResponse = {
      ok: false,
      status: 500,
      json: async () => ({
        code: "internal_error",
        subcode: "server_fault",
        detail: "Internal server error",
        retryable: true,
        correlation_id: "corr-500",
      }),
    };

    try {
      await generateManagedAvatar("test prompt");
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(ManagedAvatarError);
      const avatarErr = err as ManagedAvatarError;
      expect(avatarErr.code).toBe("internal_error");
      expect(avatarErr.subcode).toBe("server_fault");
      expect(avatarErr.statusCode).toBe(500);
    }
  });

  test("response with disallowed MIME type throws validation error", async () => {
    fetchResponse = {
      ok: true,
      status: 200,
      json: async () => ({
        ...successResponse(),
        image: { ...successResponse().image, mime_type: "image/gif" },
      }),
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

  test("response with oversized bytes throws validation error", async () => {
    fetchResponse = {
      ok: true,
      status: 200,
      json: async () => ({
        ...successResponse(),
        image: {
          ...successResponse().image,
          bytes: AVATAR_MAX_DECODED_BYTES + 1,
        },
      }),
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

  test("response with oversized base64 estimated decoded size throws validation error", async () => {
    // Create a base64 string whose estimated decoded size exceeds the limit,
    // even though the server-reported bytes field is under the limit
    const oversizedBase64 = "A".repeat(
      Math.ceil(((AVATAR_MAX_DECODED_BYTES + 100) * 4) / 3),
    );
    fetchResponse = {
      ok: true,
      status: 200,
      json: async () => ({
        ...successResponse(),
        image: {
          ...successResponse().image,
          data_base64: oversizedBase64,
          bytes: 1024,
        },
      }),
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
