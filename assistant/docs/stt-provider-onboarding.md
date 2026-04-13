# STT Provider Onboarding Checklist

Step-by-step guide for adding a new speech-to-text provider to the assistant. Follow each section in order; the parity tests (step 7) will fail CI if any side is out of sync.

## 1. Daemon provider catalog entry

**File:** `src/providers/speech-to-text/provider-catalog.ts`

Add a new entry to the `CATALOG` map with:

- `id` — a unique `SttProviderId` string (e.g. `"google-gemini"`).
- `credentialProvider` — the credential-store key name used by `getProviderKeyAsync` to retrieve the API key. If the provider shares an API key with another service (e.g. `openai-whisper` shares the `"openai"` key, or `google-gemini` shares the `"gemini"` key), reuse that name; otherwise use the provider's own name (e.g. `"deepgram"` maps to `"deepgram"`).
- `supportedBoundaries` — the set of `SttBoundaryId` values the provider supports (currently only `"daemon-batch"` exists).
- `telephonyMode` — how the provider participates in real-time telephony STT: `"realtime-ws"`, `"batch-only"`, or `"none"`.

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

If the provider needs a new REST client module, add it under `src/providers/speech-to-text/` following the pattern of `openai-whisper.ts`, `deepgram.ts`, and `google-gemini.ts`.

## 5. Credential plumbing

**File:** `src/providers/provider-secret-catalog.ts`

If the new provider introduces a credential-store key that is not already present in `LLM_AND_SEARCH_API_KEY_PROVIDERS`, it is automatically included via `sttApiKeyProviderNames()` which reads from the STT provider catalog. Verify this by checking that `API_KEY_PROVIDERS` includes the new credential name at runtime.

If the new provider **shares** an existing credential name (e.g. reuses `"openai"`), the deduplication logic in `sttApiKeyProviderNames()` handles it — no changes needed.

## 6. Client catalog entry

**File:** `meta/stt-provider-catalog.json`

Add a new entry to the `providers` array with the following fields:

| Field                | Description                                                              |
| -------------------- | ------------------------------------------------------------------------ |
| `id`                 | Must match the `SttProviderId` used in step 1.                           |
| `displayName`        | Human-readable name shown in client settings UI.                         |
| `subtitle`           | Short description displayed below the provider selector.                 |
| `setupMode`          | `"api-key"` (inline key field) or `"cli"` (instructions-only).           |
| `setupHint`          | Brief guidance shown during setup.                                       |
| `apiKeyProviderName` | Must match the `credentialProvider` value from the daemon catalog entry. |

**Naming/mapping examples:**

| Provider ID      | `credentialProvider` / `apiKeyProviderName` | Key ownership |
| ---------------- | ------------------------------------------- | ------------- |
| `openai-whisper` | `openai`                                    | shared        |
| `deepgram`       | `deepgram`                                  | exclusive     |
| `google-gemini`  | `gemini`                                    | shared        |

When the provider ID differs from the credential provider name (e.g. `google-gemini` maps to `gemini`), the key is **shared** with other services that use the same credential. The `sttKeyIsExclusive` / `sttKeyIsShared` helpers in the macOS settings layer derive this automatically from the catalog.

Insertion order in the JSON array must match the daemon catalog insertion order.

### Client-side code

**File:** `clients/shared/Utilities/STTProviderRegistry.swift`

Add a matching fallback entry in `fallbackRegistry` with the same `id`, `displayName`, `subtitle`, `setupMode`, `setupHint`, and `apiKeyProviderName` as the JSON catalog entry. The fallback keeps client startup resilient when the bundled JSON is missing.

### macOS settings key behavior

**File:** `clients/macos/vellum-assistant/Features/Settings/SettingsStore.swift`

The `sttKeyIsExclusive(for:)` / `sttKeyIsShared(for:)` helpers derive shared-vs-exclusive key behavior from the catalog automatically: if `apiKeyProviderName == id`, the key is exclusive; otherwise it is shared. No new conditionals are needed unless the provider has a non-standard key-ownership model.

## 7. Parity tests

**File:** `src/__tests__/stt-catalog-parity.test.ts`

The existing parity test suite enforces that:

- Daemon and client catalog provider IDs are identical and in the same order.
- Each entry's `apiKeyProviderName` matches the daemon's `credentialProvider`.
- The client catalog has all required fields populated.

Run the test after completing steps 1-6:

```bash
cd assistant && bun test src/__tests__/stt-catalog-parity.test.ts
```

If any assertion fails, the error message identifies which side is out of sync and what to fix.

## 8. Verify terminology separation

Before submitting the PR, grep for any accidental coupling between the two STT configuration surfaces:

- **`services.stt`** — controls daemon batch and client service-first STT provider selection. Configured under the Speech-to-Text section in Settings.
- **`calls.voice.transcriptionProvider`** — controls telephony-native STT (Twilio ConversationRelay). Configured separately under the Calls/Voice section.

These are independent config paths with different provider sets and runtime boundaries. A new `services.stt` provider should never modify `calls.voice` config or vice versa. For example, `google-gemini` is registered only under `services.stt` and has no effect on `calls.voice.transcriptionProvider`. The prepared dark path for telephony cutover (see ARCHITECTURE.md) is the designated seam for future unification — do not wire a new provider into both paths simultaneously.
