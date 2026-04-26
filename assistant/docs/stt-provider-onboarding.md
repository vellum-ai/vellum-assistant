# STT Provider Onboarding Checklist

Step-by-step guide for adding a new speech-to-text provider to the assistant. Follow each section in order; the parity tests (step 7) will fail CI if any side is out of sync.

## 1. Daemon provider catalog entry

**File:** `src/providers/speech-to-text/provider-catalog.ts`

Add a new entry to the `CATALOG` map with:

- `id` — a unique `SttProviderId` string (e.g. `"google-gemini"`).
- `credentialProvider` — the credential-store key name used by `getProviderKeyAsync` to retrieve the API key. If the provider shares an API key with another service (e.g. `openai-whisper` shares the `"openai"` key, or `google-gemini` shares the `"gemini"` key), reuse that name; otherwise use the provider's own name (e.g. `"deepgram"` maps to `"deepgram"`).
- `supportedBoundaries` — the set of `SttBoundaryId` values the provider supports. Valid values are `"daemon-batch"` (post-recording transcription) and `"daemon-streaming"` (real-time streaming transcription during conversation).
- `conversationStreamingMode` — how the provider handles streaming transcription in conversation mode: `"realtime-ws"` (provider supports real-time streaming natively via WebSocket), `"incremental-batch"` (streaming emulated via throttled polling), or `"none"` (no streaming support). Required for all providers.
- `telephonyMode` — how the provider participates in real-time telephony STT: `"realtime-ws"`, `"batch-only"`, or `"none"`.
- `telephonyRouting` — telephony routing metadata that drives Twilio call setup strategy selection. Declare `strategyKind` as `"conversation-relay-native"` or `"media-stream-custom"`. For native providers, include `twilioNativeMapping` with the Twilio `provider` name and `defaultSpeechModel`.

## 2. Type-system registration

**File:** `src/stt/types.ts`

- Append the new provider ID to the `SttProviderId` union type.

This ensures the exhaustive switch in `daemon-batch-transcriber.ts` produces a compile error until the adapter is wired.

## 3. Config schema touchpoints

**File:** `src/config/schemas/stt.ts`

- Append the new provider ID string to the `VALID_STT_PROVIDERS` tuple.

The `services.stt.providers` map uses a sparse `z.record(z.string(), ...)` schema, so adding a new provider does **not** require a workspace migration to seed a `services.stt.providers.<id>` entry. Users only need to set `services.stt.provider` to the new ID and supply credentials.

## 4. Adapter wiring

**File:** `src/stt/daemon-batch-transcriber.ts`

1. Create a new `BatchTranscriber` implementation class (e.g. `GoogleGeminiBatchTranscriber`) alongside `WhisperBatchTranscriber` and `DeepgramBatchTranscriber`.
2. Implement the `transcribe(request)` method using a lazy-imported provider module (follow the pattern in the existing adapters).
3. Add a `case` branch in `createDaemonBatchTranscriber()` for the new `SttProviderId`. The exhaustive `never` check at the bottom of the switch ensures a compile error if this step is skipped.

If the provider needs a new REST client module, add it under `src/providers/speech-to-text/` following the pattern of `openai-whisper.ts`, `deepgram.ts`, `google-gemini.ts`, and `xai.ts`.

## 5. Credential plumbing

**File:** `src/providers/provider-secret-catalog.ts`

If the new provider introduces a credential-store key that is not already present in `LLM_AND_SEARCH_API_KEY_PROVIDERS`, it is automatically included via `sttApiKeyProviderNames()` which reads from the STT provider catalog. Verify this by checking that `API_KEY_PROVIDERS` includes the new credential name at runtime.

If the new provider **shares** an existing credential name (e.g. reuses `"openai"`), the deduplication logic in `sttApiKeyProviderNames()` handles it — no changes needed.

## 6. Client display metadata

All client-facing metadata is part of the daemon's provider catalog entry (`src/providers/speech-to-text/provider-catalog.ts`). When adding a new provider, include these fields in the catalog entry:

| Field              | Description                                                               |
| ------------------ | ------------------------------------------------------------------------- |
| `displayName`      | Human-readable name shown in client settings UI.                          |
| `subtitle`         | Short description displayed below the provider selector.                  |
| `setupMode`        | `"api-key"` (inline key field) or `"cli"` (instructions-only).            |
| `setupHint`        | Brief guidance shown during setup.                                        |
| `credentialsGuide` | Object with `description`, `url`, and `linkLabel` for the key mgmt page.  |

Native clients fetch this metadata at launch via `GET /v1/stt/providers`. No separate client-side file updates are needed.

**Naming/mapping examples:**

| Provider ID      | `credentialProvider` | Key ownership |
| ---------------- | -------------------- | ------------- |
| `openai-whisper` | `openai`             | shared        |
| `deepgram`       | `deepgram`           | exclusive     |
| `google-gemini`  | `gemini`             | shared        |
| `xai`            | `xai`                | exclusive     |

When the provider ID differs from the credential provider name (e.g. `google-gemini` maps to `gemini`), the key is **shared** with other services that use the same credential. The `sttKeyIsExclusive` / `sttKeyIsShared` helpers in the macOS settings layer derive this automatically from the catalog.

### macOS settings key behavior

**File:** `clients/macos/vellum-assistant/Features/Settings/SettingsStore.swift`

The `sttKeyIsExclusive(for:)` / `sttKeyIsShared(for:)` helpers derive shared-vs-exclusive key behavior from the catalog automatically: if `apiKeyProviderName == id`, the key is exclusive; otherwise it is shared. No new conditionals are needed unless the provider has a non-standard key-ownership model.

## 7. Verify unified STT architecture

`services.stt.provider` is the single source of truth for all STT routing, including telephony. There is no separate telephony STT config path.

Before submitting the PR, verify that:

1. **No stale config references** — grep for any references to a separate telephony transcription config. The telephony routing module (`src/calls/telephony-stt-routing.ts`) reads `services.stt.provider` and maps it to the appropriate Twilio strategy (either `conversation-relay-native` for providers Twilio supports natively, or `media-stream-custom` for server-side transcription).

2. **Provider catalog `telephonyRouting` metadata** — the new provider's catalog entry (step 1) includes a `telephonyRouting` object that is the single source of truth for strategy selection in `telephony-stt-routing.ts`. This object declares the `strategyKind` (`"conversation-relay-native"` or `"media-stream-custom"`) and, for native providers, provides a `twilioNativeMapping` with the Twilio `provider` name and `defaultSpeechModel`. The routing module contains no hardcoded provider-to-Twilio maps — it reads these values directly from the catalog.

3. **No duplicate wiring** — a provider should appear only once in `services.stt`. The telephony routing layer consumes the same provider ID; there is no second registration step for telephony.
