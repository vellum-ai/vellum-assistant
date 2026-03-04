import { getPlatformBaseUrl } from "../config/env.js";
import { getConfig } from "../config/loader.js";
import { getSecureKey } from "../security/secure-keys.js";
import { getLogger } from "../util/logger.js";
import {
  AVATAR_MAX_DECODED_BYTES,
  AVATAR_MIME_ALLOWLIST,
  AVATAR_PROMPT_MAX_LENGTH,
  ManagedAvatarError,
  type ManagedAvatarErrorResponse,
  type ManagedAvatarResponse,
} from "./avatar-types.js";

const log = getLogger("managed-avatar-client");

export function getAssistantApiKey(): string | undefined {
  return getSecureKey("credential:vellum:assistant_api_key");
}

export function getManagedAvatarBaseUrl(): string {
  const baseUrl = getConfig().platform.baseUrl || getPlatformBaseUrl();
  return baseUrl.replace(/\/+$/, "");
}

export function isManagedAvailable(): boolean {
  const apiKey = getAssistantApiKey();
  const baseUrl = getManagedAvatarBaseUrl();
  return !!apiKey && apiKey.length > 0 && !!baseUrl && baseUrl.length > 0;
}

export async function generateManagedAvatar(
  prompt: string,
  options?: { correlationId?: string; idempotencyKey?: string },
): Promise<ManagedAvatarResponse> {
  if (prompt.length > AVATAR_PROMPT_MAX_LENGTH) {
    throw new ManagedAvatarError({
      code: "validation_error",
      subcode: "prompt_too_long",
      detail: `Prompt exceeds maximum length of ${AVATAR_PROMPT_MAX_LENGTH} characters`,
      retryable: false,
      correlationId: options?.correlationId ?? crypto.randomUUID(),
      statusCode: 0,
    });
  }

  const apiKey = getAssistantApiKey();
  if (!apiKey) {
    throw new ManagedAvatarError({
      code: "configuration_error",
      subcode: "missing_api_key",
      detail: "Assistant API key is not configured",
      retryable: false,
      correlationId: options?.correlationId ?? crypto.randomUUID(),
      statusCode: 0,
    });
  }

  const baseUrl = getManagedAvatarBaseUrl();
  if (!baseUrl) {
    throw new ManagedAvatarError({
      code: "configuration_error",
      subcode: "missing_base_url",
      detail:
        "Platform base URL is not configured. Set platform.baseUrl in config or PLATFORM_BASE_URL environment variable.",
      retryable: false,
      correlationId: options?.correlationId ?? crypto.randomUUID(),
      statusCode: 0,
    });
  }

  const url = `${baseUrl}/v1/assistants/avatar/generate/`;
  const idempotencyKey = options?.idempotencyKey ?? crypto.randomUUID();
  const correlationId = options?.correlationId ?? crypto.randomUUID();

  const headers: Record<string, string> = {
    Authorization: `Api-Key ${apiKey}`,
    "Content-Type": "application/json",
    "Idempotency-Key": idempotencyKey,
    "X-Correlation-Id": correlationId,
  };

  log.debug({ url, correlationId }, "Requesting managed avatar generation");

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      body: JSON.stringify({ prompt }),
      signal: AbortSignal.timeout(60_000),
      headers,
    });
  } catch (err) {
    const isTimeout =
      err instanceof DOMException && err.name === "TimeoutError";
    throw new ManagedAvatarError({
      code: "avatar_generation_failed",
      subcode: isTimeout ? "upstream_timeout" : "network_error",
      detail: isTimeout
        ? "Request to avatar generation service timed out"
        : `Network error: ${err instanceof Error ? err.message : String(err)}`,
      retryable: true,
      correlationId,
      statusCode: 0,
    });
  }

  if (!response.ok) {
    let errorBody: ManagedAvatarErrorResponse;
    try {
      errorBody = (await response.json()) as ManagedAvatarErrorResponse;
    } catch {
      throw new ManagedAvatarError({
        code: "upstream_error",
        subcode: "unparseable_response",
        detail: `HTTP ${response.status}: unable to parse error response`,
        retryable: response.status >= 500 || response.status === 429,
        correlationId,
        statusCode: response.status,
      });
    }

    throw new ManagedAvatarError({
      code: errorBody.code ?? "upstream_error",
      subcode: errorBody.subcode ?? "unknown",
      detail: errorBody.detail ?? `HTTP ${response.status}`,
      retryable:
        errorBody.retryable ??
        (response.status >= 500 || response.status === 429),
      correlationId: errorBody.correlation_id ?? correlationId,
      statusCode: response.status,
    });
  }

  let body: ManagedAvatarResponse;
  try {
    body = (await response.json()) as ManagedAvatarResponse;

    if (!AVATAR_MIME_ALLOWLIST.has(body.image.mime_type)) {
      throw new ManagedAvatarError({
        code: "validation_error",
        subcode: "disallowed_mime_type",
        detail: `Response MIME type "${body.image.mime_type}" is not in the allowlist`,
        retryable: false,
        correlationId,
        statusCode: 0,
      });
    }

    const b64 = body.image.data_base64;
    const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
    const estimatedDecodedBytes = Math.ceil((b64.length * 3) / 4) - padding;
    if (
      estimatedDecodedBytes > AVATAR_MAX_DECODED_BYTES ||
      body.image.bytes > AVATAR_MAX_DECODED_BYTES
    ) {
      throw new ManagedAvatarError({
        code: "validation_error",
        subcode: "oversized_image",
        detail: `Response image size ${Math.max(estimatedDecodedBytes, body.image.bytes)} exceeds maximum of ${AVATAR_MAX_DECODED_BYTES} bytes`,
        retryable: false,
        correlationId,
        statusCode: 0,
      });
    }

    log.debug(
      {
        correlationId,
        mimeType: body.image.mime_type,
        bytes: body.image.bytes,
      },
      "Managed avatar generation succeeded",
    );

    return body;
  } catch (err) {
    if (err instanceof ManagedAvatarError) {
      throw err;
    }
    throw new ManagedAvatarError({
      code: "upstream_error",
      subcode: "unparseable_response",
      detail: `Failed to parse avatar generation response: ${err instanceof Error ? err.message : String(err)}`,
      retryable: false,
      correlationId,
      statusCode: 0,
    });
  }
}
