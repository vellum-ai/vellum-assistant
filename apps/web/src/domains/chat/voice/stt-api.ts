import {
  configPatch,
  secretsPost,
  sttTranscribePost,
} from "@/generated/daemon/sdk.gen";
import { isNativeDictationSupported } from "@/runtime/native-dictation-partials";
import {
  getLocalSetting,
  removeLocalSetting,
} from "@/utils/local-settings";

export interface SttTranscribeOk {
  status: "ok";
  text: string;
  providerId: string;
  boundaryId?: string;
}

/**
 * Reasons the daemon's STT pipeline can fail. Mirrors the categories returned
 * by `normalizeSttError` in `assistant/src/stt/daemon-batch-transcriber.ts`,
 * with the addition of `network` for transport-level failures that never
 * reached the daemon.
 */
export type SttFailureReason =
  | "config-missing"
  | "audio-rejected"
  | "auth-failed"
  | "rate-limited"
  | "provider-error"
  | "unavailable"
  | "timeout"
  | "network"
  | "aborted"
  | "unknown";

export interface SttTranscribeFailure {
  status: "error";
  reason: SttFailureReason;
  /** HTTP status code, when the request reached the daemon. */
  httpStatus?: number;
  /** Daemon-supplied error detail, when present. */
  message?: string;
}

export type SttTranscribeOutcome = SttTranscribeOk | SttTranscribeFailure;

const LS_STT_PROVIDER = "vellum:voice:sttProvider";
const LS_STT_API_KEY_PREFIX = "vellum:voice:sttApiKey:";
const DEFAULT_STT_PROVIDER_ID = "deepgram";

/**
 * Provider id for the explicit "macOS Native Dictation" settings choice.
 * Not a daemon provider: when selected, dictation routes through the mac
 * helper's `SFSpeechRecognizer` and never calls `/v1/stt/transcribe`.
 * Mirrors `MACOS_NATIVE_STT_PROVIDER_ID` in
 * `@/domains/settings/ai/provider-catalogs.ts` — cross-domain constants stay
 * duplicated here, like the `LS_STT_*` keys above.
 */
const MACOS_NATIVE_STT_PROVIDER_ID = "macos-native";

/**
 * True when the user explicitly chose macOS native dictation as the STT
 * provider in Settings → AI AND this renderer can honor it (the helper's
 * dictation bridge is present). Callers should then skip the daemon
 * streaming and batch STT paths entirely and rely on the helper recognizer.
 *
 * The capability gate matters: a persisted choice can outlive the bridge
 * (older Electron preload, web/iOS) — suppressing the daemon paths there
 * would leave dictation with no transcript source at all.
 */
export function prefersMacosNativeStt(): boolean {
  return (
    isNativeDictationSupported() &&
    getLocalSetting(LS_STT_PROVIDER, DEFAULT_STT_PROVIDER_ID) ===
      MACOS_NATIVE_STT_PROVIDER_ID
  );
}

function normalizeSttProviderId(provider: string): string {
  if (provider === "openai" || provider === "whisper") return "openai-whisper";
  return provider;
}

function credentialProviderForSttProvider(provider: string): string {
  switch (normalizeSttProviderId(provider)) {
    case "openai-whisper":
      return "openai";
    case "google-gemini":
      return "gemini";
    default:
      return normalizeSttProviderId(provider);
  }
}

function legacyKeyAliases(provider: string): string[] {
  const normalized = normalizeSttProviderId(provider);
  const aliases = [normalized];
  if (normalized === "openai-whisper") {
    aliases.push("openai", "whisper");
  }
  return aliases;
}

function readLegacyLocalSttKey(provider: string): string {
  for (const alias of legacyKeyAliases(provider)) {
    const value = getLocalSetting(LS_STT_API_KEY_PREFIX + alias, "");
    if (value.trim()) return value;
  }
  return "";
}

function clearLegacyLocalSttKey(provider: string): void {
  for (const alias of legacyKeyAliases(provider)) {
    removeLocalSetting(LS_STT_API_KEY_PREFIX + alias);
  }
}

async function migrateLegacyLocalSttSettings(
  assistantId: string,
): Promise<boolean> {
  const provider = normalizeSttProviderId(
    getLocalSetting(LS_STT_PROVIDER, DEFAULT_STT_PROVIDER_ID),
  );
  const credentialValue = readLegacyLocalSttKey(provider).trim();
  if (!credentialValue) return false;

  const credentialProvider = credentialProviderForSttProvider(provider);
  try {
    const secretResult = await secretsPost({
      path: { assistant_id: assistantId },
      body: {
        type: "api_key",
        name: credentialProvider,
        value: credentialValue,
      },
      throwOnError: true,
    });
    const secretData = secretResult.data;
    if (
      secretData &&
      typeof secretData === "object" &&
      "success" in secretData &&
      secretData.success === false
    ) {
      return false;
    }

    await configPatch({
      path: { assistant_id: assistantId },
      body: {
        services: {
          stt: {
            mode: "your-own",
            provider,
            providers: {},
          },
        },
      },
      throwOnError: true,
    });
  } catch (err) {
    console.warn("postSttTranscribe: legacy STT settings migration failed", err);
    return false;
  }

  clearLegacyLocalSttKey(provider);
  return true;
}

/**
 * Map a daemon HTTP response to a structured failure reason. The daemon's
 * route handler maps `SttErrorCategory` → `RouteError` subclasses with
 * specific HTTP statuses (see `assistant/src/runtime/routes/stt-routes.ts`),
 * so the inverse mapping is well-defined.
 *
 * 503 has two distinguishable sub-cases that the user can act on differently:
 * `"No speech-to-text provider is configured"` (the assistant owner needs to
 * pick a provider in Settings) vs `"STT provider is not available"`
 * (transient — retry).
 */
function reasonFromHttp(
  status: number,
  message: string | undefined,
): SttFailureReason {
  switch (status) {
    case 400:
      return "audio-rejected";
    case 401:
    case 403:
      return "auth-failed";
    case 429:
      return "rate-limited";
    case 502:
      return "provider-error";
    case 503: {
      const text = (message ?? "").toLowerCase();
      if (text.includes("not configured") || text.includes("no speech-to-text"))
        return "config-missing";
      return "unavailable";
    }
    case 504:
      return "timeout";
    default:
      return "unknown";
  }
}

/** Best-effort extraction of the daemon's textual error detail.
 *
 * The daemon's `httpError()` wraps errors in `{ error: { code, message } }`.
 * Some proxy layers (e.g. Django DRF) use `{ detail: "..." }` instead.
 * This function handles both shapes.
 */
function extractMessage(data: unknown): string | undefined {
  if (typeof data === "string") return data;
  if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    for (const key of ["detail", "message"] as const) {
      const value = record[key];
      if (typeof value === "string" && value.length > 0) return value;
    }
    // Recurse into `{ error: { message: "..." } }` envelope from httpError().
    if (record.error && typeof record.error === "object") {
      return extractMessage(record.error);
    }
  }
  return undefined;
}

/**
 * POST /v1/stt/transcribe
 *
 * Sends a recorded audio blob to the daemon's STT provider for transcription
 * and returns a discriminated outcome so callers can surface category-specific
 * UI (`config-missing` → "set up STT in Settings", `audio-rejected` → "try
 * again", `rate-limited` → "wait and retry", etc.) instead of a single
 * opaque failure code.
 *
 * Uses the same session auth (cookies + Vellum-Organization-Id header) as all
 * other /v1/ routes — no special JWT required.
 *
 * TODO(atlas): Once the Velay WebSocket service supports browser WS upgrades
 * through the managed gateway, replace this batch call with a streaming
 * connection to WS /v1/stt/stream for live interim transcript feedback.
 */
export async function postSttTranscribe(
  audioBlob: Blob,
  assistantId: string,
  signal?: AbortSignal,
): Promise<SttTranscribeOutcome> {
  // Convert Blob → base64. Using a manual loop avoids the call-stack
  // overflow that btoa(String.fromCharCode(...spread)) can hit on large buffers.
  const arrayBuffer = await audioBlob.arrayBuffer();
  const uint8 = new Uint8Array(arrayBuffer);
  let binary = "";
  const chunkSize = 8192;
  for (let i = 0; i < uint8.length; i += chunkSize) {
    binary += String.fromCharCode(...uint8.subarray(i, i + chunkSize));
  }
  const audioBase64 = btoa(binary);

  const send = async (): Promise<SttTranscribeOutcome> => {
    // The HeyAPI client with `throwOnError: false` does NOT throw on transport
    // failures (AbortError, DNS, offline, CORS) — it resolves with
    // `{ error, request, response: undefined }`. We must inspect
    // `result.error` and `result.response` directly to categorise these; the
    // surrounding try/catch only fires on developer errors thrown
    // synchronously inside the request setup. See
    // `@/generated/daemon/client.gen`.
    let result: Awaited<ReturnType<typeof sttTranscribePost>>;
    try {
      result = await sttTranscribePost({
        path: { assistant_id: assistantId },
        body: {
          audioBase64,
          mimeType: audioBlob.type,
          source: "dictation",
        },
        throwOnError: false,
        signal,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        return { status: "error", reason: "aborted" };
      }
      console.warn("postSttTranscribe: client error", err);
      return { status: "error", reason: "network" };
    }

    const response: Response | undefined = result.response;

    if (!response) {
      const err = result.error;
      if (err instanceof DOMException && err.name === "AbortError") {
        return { status: "error", reason: "aborted" };
      }
      // Some browsers / abort polyfills surface aborts as plain objects with
      // `.name === "AbortError"` rather than `DOMException` instances.
      if (
        typeof err === "object" &&
        err !== null &&
        (err as { name?: unknown }).name === "AbortError"
      ) {
        return { status: "error", reason: "aborted" };
      }
      console.warn("postSttTranscribe: transport error (no response)", err);
      return { status: "error", reason: "network" };
    }

    if (response.ok) {
      const ok = result.data;
      return {
        status: "ok",
        text: ok?.text ?? "",
        providerId: ok?.providerId ?? "",
        boundaryId: ok?.boundaryId,
      };
    }

    // On non-ok responses the heyapi client parses the error body and puts it
    // on `result.error` — `result.data` is undefined. The daemon distinguishes
    // 503 sub-cases via the body text ("No speech-to-text provider is
    // configured" → config-missing vs the generic "STT provider is not
    // available" → unavailable), so we must read the message from `error`.
    const message = extractMessage(result.error);
    const reason = reasonFromHttp(response.status, message);
    console.warn(
      `postSttTranscribe: HTTP ${response.status} (${reason})${
        message ? `: ${message}` : ""
      }`,
    );
    return { status: "error", reason, httpStatus: response.status, message };
  };

  const migratedBeforeSend = await migrateLegacyLocalSttSettings(assistantId);
  const firstAttempt = await send();
  if (migratedBeforeSend) {
    return firstAttempt;
  }

  if (
    firstAttempt.status !== "error" ||
    firstAttempt.reason !== "config-missing"
  ) {
    return firstAttempt;
  }

  const migratedAfterFailure = await migrateLegacyLocalSttSettings(assistantId);
  if (!migratedAfterFailure) return firstAttempt;
  return send();
}
