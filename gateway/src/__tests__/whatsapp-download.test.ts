import { describe, test, expect, mock, afterEach } from "bun:test";
import type { GatewayConfig } from "../config.js";
import type { CredentialCache } from "../credential-cache.js";
import type { ConfigFileCache } from "../config-file-cache.js";
import { credentialKey } from "../credential-key.js";

type FetchFn = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;
let fetchMock: ReturnType<typeof mock<FetchFn>> = mock(
  async () => new Response(),
);

mock.module("../fetch.js", () => ({
  fetchImpl: (...args: Parameters<FetchFn>) => fetchMock(...args),
}));

const { downloadWhatsAppFile } = await import("../whatsapp/download.js");
const { WhatsAppNonRetryableError } = await import("../whatsapp/api.js");

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    assistantRuntimeBaseUrl: "http://localhost:7821",
    routingEntries: [],
    defaultAssistantId: undefined,
    unmappedPolicy: "reject",
    port: 7830,
    runtimeProxyEnabled: false,
    runtimeProxyRequireAuth: true,
    shutdownDrainMs: 5000,
    runtimeTimeoutMs: 30000,
    runtimeMaxRetries: 2,
    runtimeInitialBackoffMs: 500,
    maxWebhookPayloadBytes: 1048576,
    logFile: { dir: undefined, retentionDays: 30 },
    maxAttachmentBytes: {
      telegram: 50 * 1024 * 1024,
      slack: 100 * 1024 * 1024,
      whatsapp: 16 * 1024 * 1024,
      default: 50 * 1024 * 1024,
    },
    maxAttachmentConcurrency: 3,
    gatewayInternalBaseUrl: "http://127.0.0.1:7830",
    trustProxy: false,
    ...overrides,
  };
}

/** Create a mock ConfigFileCache with fast retries (0 retries for test speed). */
function makeConfigFile(overrides?: { maxRetries?: number }): ConfigFileCache {
  return {
    getNumber: (_section: string, field: string) => {
      if (field === "maxRetries") return overrides?.maxRetries ?? 1;
      if (field === "initialBackoffMs") return 10;
      if (field === "timeoutMs") return 15000;
      return undefined;
    },
    getString: () => undefined,
    getBoolean: () => undefined,
    getRecord: () => undefined,
  } as unknown as ConfigFileCache;
}

/** Create a mock caches object that provides WhatsApp credentials. */
function makeCaches(opts?: { maxRetries?: number }) {
  const credentials = {
    get: async (key: string) => {
      if (key === credentialKey("whatsapp", "access_token"))
        return "test-access-token";
      if (key === credentialKey("whatsapp", "phone_number_id"))
        return "test-phone-id";
      return undefined;
    },
    invalidate: () => {},
  } as unknown as CredentialCache;
  return { credentials, configFile: makeConfigFile(opts) };
}

const MEDIA_ID = "1234567890";
const MEDIA_URL =
  "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1234567890";

// Minimal valid PNG: 1x1 pixel transparent
const PNG_BYTES = new Uint8Array([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a, // PNG signature
  0x00,
  0x00,
  0x00,
  0x0d,
  0x49,
  0x48,
  0x44,
  0x52, // IHDR chunk
  0x00,
  0x00,
  0x00,
  0x01,
  0x00,
  0x00,
  0x00,
  0x01, // 1x1
  0x08,
  0x06,
  0x00,
  0x00,
  0x00,
  0x1f,
  0x15,
  0xc4, // RGBA
  0x89,
  0x00,
  0x00,
  0x00,
  0x0a,
  0x49,
  0x44,
  0x41, // IDAT chunk
  0x54,
  0x78,
  0x9c,
  0x62,
  0x00,
  0x00,
  0x00,
  0x02,
  0x00,
  0x01,
  0xe5,
  0x27,
  0xde,
  0xfc,
  0x00,
  0x00,
  0x00,
  0x00,
  0x49,
  0x45,
  0x4e,
  0x44,
  0xae,
  0x42, // IEND chunk
  0x60,
  0x82,
]);

describe("downloadWhatsAppFile", () => {
  afterEach(() => {
    fetchMock = mock(async () => new Response());
  });

  test("successfully downloads media and returns filename, mimeType, data", async () => {
    const urls: string[] = [];

    fetchMock = mock(async (input: string | URL | Request) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      urls.push(url);

      // Metadata endpoint
      if (url.includes(MEDIA_ID) && url.includes("graph.facebook.com")) {
        return new Response(
          JSON.stringify({
            url: MEDIA_URL,
            mime_type: "image/png",
            sha256: "abc123",
            file_size: PNG_BYTES.length,
            id: MEDIA_ID,
          }),
        );
      }

      // Download endpoint
      if (url.includes("lookaside.fbsbx.com")) {
        return new Response(PNG_BYTES, {
          headers: { "Content-Type": "image/png" },
        });
      }

      return new Response("unexpected", { status: 500 });
    });

    const config = makeConfig();
    const result = await downloadWhatsAppFile(
      config,
      MEDIA_ID,
      undefined,
      makeCaches(),
    );

    expect(urls).toHaveLength(2);
    expect(result.mimeType).toBe("image/png");
    expect(result.filename).toBe("1234567890.png");
    expect(result.data).toBe(Buffer.from(PNG_BYTES).toString("base64"));
  });

  test("infers filename from MIME type when Meta omits it", async () => {
    fetchMock = mock(async (input: string | URL | Request) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;

      if (url.includes("graph.facebook.com")) {
        return new Response(
          JSON.stringify({
            url: MEDIA_URL,
            mime_type: "application/pdf",
            sha256: "def456",
            file_size: 4,
            id: MEDIA_ID,
          }),
        );
      }

      return new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), {
        headers: { "Content-Type": "application/pdf" },
      });
    });

    const result = await downloadWhatsAppFile(
      makeConfig(),
      MEDIA_ID,
      undefined,
      makeCaches(),
    );

    expect(result.filename).toBe("1234567890.pdf");
    expect(result.mimeType).toBe("application/pdf");
  });

  test("falls back to detected MIME when Meta metadata is empty", async () => {
    fetchMock = mock(async (input: string | URL | Request) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;

      if (url.includes("graph.facebook.com")) {
        return new Response(
          JSON.stringify({
            url: MEDIA_URL,
            mime_type: "",
            sha256: "abc",
            file_size: PNG_BYTES.length,
            id: MEDIA_ID,
          }),
        );
      }

      return new Response(PNG_BYTES, {
        headers: { "Content-Type": "image/png" },
      });
    });

    const result = await downloadWhatsAppFile(
      makeConfig(),
      MEDIA_ID,
      undefined,
      makeCaches(),
    );

    // file-type should detect PNG from magic bytes
    expect(result.mimeType).toBe("image/png");
    expect(result.filename).toBe("1234567890.png");
  });

  test("falls back to application/octet-stream for unknown MIME", async () => {
    fetchMock = mock(async (input: string | URL | Request) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;

      if (url.includes("graph.facebook.com")) {
        return new Response(
          JSON.stringify({
            url: MEDIA_URL,
            mime_type: "",
            sha256: "abc",
            file_size: 3,
            id: MEDIA_ID,
          }),
        );
      }

      // Unrecognizable bytes with no Content-Type
      return new Response(new Uint8Array([0x01, 0x02, 0x03]));
    });

    const result = await downloadWhatsAppFile(
      makeConfig(),
      MEDIA_ID,
      undefined,
      makeCaches(),
    );

    expect(result.mimeType).toBe("application/octet-stream");
    // No extension mapping for octet-stream, so filename is just the truncated ID
    expect(result.filename).toBe("1234567890");
  });

  test("throws WhatsAppNonRetryableError on non-retryable 4xx metadata response", async () => {
    fetchMock = mock(async (input: string | URL | Request) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;

      if (url.includes("graph.facebook.com")) {
        return new Response(
          JSON.stringify({
            error: {
              message: "Invalid media ID",
              type: "OAuthException",
              code: 100,
            },
          }),
          { status: 400 },
        );
      }
      return new Response("unexpected", { status: 500 });
    });

    const promise = downloadWhatsAppFile(
      makeConfig(),
      MEDIA_ID,
      undefined,
      makeCaches(),
    );
    await expect(promise).rejects.toThrow("Invalid media ID");
    await expect(promise).rejects.toBeInstanceOf(WhatsAppNonRetryableError);
  });

  test("throws WhatsAppNonRetryableError on non-retryable 4xx download response", async () => {
    fetchMock = mock(async (input: string | URL | Request) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;

      if (url.includes("graph.facebook.com")) {
        return new Response(
          JSON.stringify({
            url: MEDIA_URL,
            mime_type: "image/png",
            sha256: "abc",
            file_size: 100,
            id: MEDIA_ID,
          }),
        );
      }

      // Download returns 404
      return new Response("Not Found", { status: 404 });
    });

    const promise = downloadWhatsAppFile(
      makeConfig(),
      MEDIA_ID,
      undefined,
      makeCaches(),
    );
    await expect(promise).rejects.toThrow(
      "WhatsApp downloadMedia failed with status 404",
    );
    await expect(promise).rejects.toBeInstanceOf(WhatsAppNonRetryableError);
  });

  test("retries on 500 and eventually succeeds", async () => {
    let metadataAttempt = 0;

    fetchMock = mock(async (input: string | URL | Request) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;

      if (url.includes("graph.facebook.com")) {
        metadataAttempt++;
        if (metadataAttempt === 1) {
          return new Response(
            JSON.stringify({ error: { message: "Internal error" } }),
            { status: 500 },
          );
        }
        return new Response(
          JSON.stringify({
            url: MEDIA_URL,
            mime_type: "image/jpeg",
            sha256: "abc",
            file_size: 3,
            id: MEDIA_ID,
          }),
        );
      }

      return new Response(new Uint8Array([0xff, 0xd8, 0xff]), {
        headers: { "Content-Type": "image/jpeg" },
      });
    });

    // Allow 1 retry
    const config = makeConfig({});
    const result = await downloadWhatsAppFile(
      config,
      MEDIA_ID,
      undefined,
      makeCaches(),
    );

    expect(metadataAttempt).toBe(2);
    expect(result.mimeType).toBe("image/jpeg");
  });

  test("exhausts retries on persistent 500 and throws", async () => {
    fetchMock = mock(async () => {
      return new Response(
        JSON.stringify({ error: { message: "Service unavailable" } }),
        { status: 500 },
      );
    });

    const config = makeConfig();

    await expect(
      downloadWhatsAppFile(
        config,
        MEDIA_ID,
        undefined,
        makeCaches({ maxRetries: 1 }),
      ),
    ).rejects.toThrow("Service unavailable");
  });

  test("uses hint.fileName when provided instead of inferred name", async () => {
    fetchMock = mock(async (input: string | URL | Request) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;

      if (url.includes("graph.facebook.com")) {
        return new Response(
          JSON.stringify({
            url: MEDIA_URL,
            mime_type: "application/pdf",
            sha256: "abc",
            file_size: 4,
            id: MEDIA_ID,
          }),
        );
      }

      return new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), {
        headers: { "Content-Type": "application/pdf" },
      });
    });

    const result = await downloadWhatsAppFile(
      makeConfig(),
      MEDIA_ID,
      { fileName: "invoice.pdf" },
      makeCaches(),
    );

    expect(result.filename).toBe("invoice.pdf");
    expect(result.mimeType).toBe("application/pdf");
  });

  test("uses hint.mimeType when Meta metadata is empty", async () => {
    fetchMock = mock(async (input: string | URL | Request) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;

      if (url.includes("graph.facebook.com")) {
        return new Response(
          JSON.stringify({
            url: MEDIA_URL,
            mime_type: "",
            sha256: "abc",
            file_size: 3,
            id: MEDIA_ID,
          }),
        );
      }

      // Unrecognizable bytes so file-type detection fails
      return new Response(new Uint8Array([0x01, 0x02, 0x03]));
    });

    const result = await downloadWhatsAppFile(
      makeConfig(),
      MEDIA_ID,
      { mimeType: "application/pdf" },
      makeCaches(),
    );

    expect(result.mimeType).toBe("application/pdf");
    expect(result.filename).toBe("1234567890.pdf");
  });

  test("strips MIME parameters when inferring filename extension", async () => {
    fetchMock = mock(async (input: string | URL | Request) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;

      if (url.includes("graph.facebook.com")) {
        return new Response(
          JSON.stringify({
            url: MEDIA_URL,
            mime_type: "audio/ogg; codecs=opus",
            sha256: "abc",
            file_size: 3,
            id: MEDIA_ID,
          }),
        );
      }

      return new Response(new Uint8Array([0x01, 0x02, 0x03]), {
        headers: { "Content-Type": "audio/ogg; codecs=opus" },
      });
    });

    const result = await downloadWhatsAppFile(
      makeConfig(),
      MEDIA_ID,
      undefined,
      makeCaches(),
    );

    expect(result.mimeType).toBe("audio/ogg; codecs=opus");
    expect(result.filename).toBe("1234567890.ogg");
  });

  test("throws when WhatsApp credentials are not configured", async () => {
    const config = makeConfig({});

    await expect(downloadWhatsAppFile(config, MEDIA_ID)).rejects.toThrow(
      "WhatsApp credentials not configured",
    );
  });

  test("passes Authorization header to both metadata and download requests", async () => {
    const headers: Record<string, string | null>[] = [];

    fetchMock = mock(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;

        const authHeader =
          init?.headers instanceof Headers
            ? init.headers.get("Authorization")
            : Array.isArray(init?.headers)
              ? (init.headers.find(([k]) => k === "Authorization")?.[1] ?? null)
              : ((init?.headers as Record<string, string>)?.Authorization ??
                null);

        headers.push({ url: url.slice(0, 50), auth: authHeader });

        if (url.includes("graph.facebook.com")) {
          return new Response(
            JSON.stringify({
              url: MEDIA_URL,
              mime_type: "image/png",
              sha256: "abc",
              file_size: PNG_BYTES.length,
              id: MEDIA_ID,
            }),
          );
        }

        return new Response(PNG_BYTES);
      },
    );

    await downloadWhatsAppFile(makeConfig(), MEDIA_ID, undefined, makeCaches());

    expect(headers).toHaveLength(2);
    expect(headers[0].auth).toBe("Bearer test-access-token");
    expect(headers[1].auth).toBe("Bearer test-access-token");
  });
});
