# STT Provider Onboarding Checklist

Step-by-step guide for adding a new speech-to-text provider to the assistant. Follow each section in order; the parity tests (step 7) will fail CI if any side is out of sync.

## 1. Daemon provider catalog entry

**File:** `src/providers/speech-to-text/provider-catalog.ts`

Add a new entry to the `CATALOG` map with:

- `id` — a unique `SttProviderId` string (e.g. `"google-gemini"`).
- `credentialProvider` — the credential-store key name used by `getProviderKeyAsync` to retrieve the API key. If the provider shares an API key with another service (e.g. `openai-whisper` shares the `"openai"` key, or `google-gemini` shares the `"gemini"` key), reuse that name; otherwise use the provider's own name (e.g. `"deepgram"` maps to `"deepgram"`).
- `supportedBoundaries` — the set of `SttBoundaryId` values the provider supports. Valid values are `"daemon-batch"` (post-recording transcription) and `"daemon-streaming"` (real-time streaming transcription during conversation).
- `conversationStreamingMode` — how the provider handles streaming transcription in conversation mode: `"realtime-ws"` (provider supports real-time streaming natively via WebSocket), `"incremental-batch"` (streaming emulated via throttled polling), or `"none"` (no streaming support). Required for all providers.
- `telephonyMode` — how the provider participates in real-time telephony STT: `"realtime-ws"`, `"batch-only"`, or `"none"`. The telephony capability resolver (`resolveTelephonySttCapability()` in `src/providers/speech-to-text/resolve.ts`) reads this field plus credential availability to decide whether phone calls can run with the provider.
- `turnDetection`: whether the provider decides end-of-turn itself, `"provider"` or `"none"`. Use `"provider"` only when the adapter emits `turn-start` / `turn-end` on its transcript stream; a live-voice session reads this via `supportsProviderTurnDetection()` to decide whether to arm its provider turn-end path. Default to `"none"`: a provider that declares `"provider"` but never emits the events makes every turn wait out the fail-open deadline before falling back to the silence boundary. A provider declaring `"provider"` should also number its turns, because the staleness check prefers the turn index on the event and degrades to the session's VAD generation counter without one.

## 2. Type-system registration

**File:** `src/stt/types.ts`

- Append the new provider ID to the `SttProviderId` union type.

This ensures the exhaustive switch in `daemon-batch-transcriber.ts` produces a compile error until the adapter is wired.

## 3. Config schema touchpoints

**File:** `src/config/schemas/stt.ts`

- Append the new provider ID string to the `VALID_STT_PROVIDERS` tuple.

The `services.stt.providers` map uses a sparse `z.record(z.string(), ...)` schema, so adding a new provider does **not** require a workspace migration to seed a `services.stt.providers.<id>` entry. Users only need to set `services.stt.provider` (or a single consumer's `services.stt.roles.<role>`, see step 7) to the new ID and supply credentials.

**Language handling.** `services.stt.language` is resolved centrally in `resolveStreamingTranscriber()` (and in `resolveBatchTranscriber()` for the daemon-batch boundary), so a new adapter inherits it for free: accept a `language` option in the adapter's constructor and forward it to the provider. If the provider auto-detects natively and has no language parameter (as Gemini and Whisper do), accept nothing and let the resolver's value be ignored; document that choice in the adapter, because "no language param" means auto-detect for some providers and _English_ for others (Deepgram), and that difference is an easy source of silent wrong-language transcription. A provider that supports both batch and streaming must forward the language on **both** paths, not just the streaming one.

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

| Field               | Description                                                                                                                                                             |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `displayName`       | Human-readable name shown in client settings UI.                                                                                                                        |
| `subtitle`          | Short description displayed below the provider selector.                                                                                                                |
| `setupMode`         | `"api-key"` (inline key field) or `"cli"` (instructions-only).                                                                                                          |
| `setupHint`         | Brief guidance shown during setup.                                                                                                                                      |
| `languageSelection` | `"manual"` (provider takes a language parameter, clients show a picker) or `"auto"` (native detection, picker hidden). See the "Language handling" paragraph in step 3. |
| `credentialsGuide`  | Object with `description`, `url`, and `linkLabel` for the key mgmt page.                                                                                                |

Native clients fetch this metadata at launch via `GET /v1/stt/providers`. No separate client-side file updates are needed.

**Naming/mapping examples:**

| Provider ID      | `credentialProvider` | Key ownership |
| ---------------- | -------------------- | ------------- |
| `openai-whisper` | `openai`             | shared        |
| `deepgram`       | `deepgram`           | exclusive     |
| `deepgram-flux`  | `deepgram`           | shared        |
| `google-gemini`  | `gemini`             | shared        |
| `xai`            | `xai`                | exclusive     |

When the provider ID differs from the credential provider name (e.g. `google-gemini` maps to `gemini`), the key is **shared** with other services that use the same credential. Two STT providers may also name the same credential: `deepgram-flux` is a model on the same Deepgram account as `deepgram`, so it reads that key rather than introducing one of its own. Reuse an existing `credentialProvider` whenever the new provider authenticates against an account the catalog already covers, and keep the `credentialsGuide` text identical across them (`DEEPGRAM_CREDENTIALS_GUIDE` is shared by both entries for that reason).

### Client settings key behavior

Clients derive shared-vs-exclusive key behavior from the catalog automatically: if `apiKeyProviderName == id`, the key is exclusive; otherwise it is shared. No new conditionals are needed unless the provider has a non-standard key-ownership model. The web settings UI lives in `clients/web/src/domains/settings/ai/speech-to-text-card.tsx`.

## 7. Verify unified STT architecture

The `services.stt` block is the single source of truth for all STT routing, including telephony. There is no separate telephony STT config path.

Routing has two levels. `services.stt.provider`, plus that provider's `services.stt.providers.<id>.model` family, is the global selection every consumer falls back to. `services.stt.roles.<role>` overrides it for one consumer, naming a `{provider, model?}` pair. The roles are `liveVoice`, `telephony`, `dictation`, `watch` and `batch`; `src/stt/roles.ts` maps each to the boundaries its call sites resolve on, and `ARCHITECTURE.md` lists the consumers per role. A new provider needs no per-role registration: a role may name any provider in the catalog whose row covers the boundaries that role requires.

Before submitting the PR, verify that:

1. **No stale config references**: grep for any references to a separate telephony transcription config. Telephony transcription runs daemon-side over the Twilio media-stream transport (`src/calls/media-stream-stt-session.ts`), which resolves through `resolveStreamingTranscriber()`/`resolveBatchTranscriber()` under the `telephony` role like every other boundary resolves under its own.

2. **Provider catalog telephony metadata** — the new provider's catalog entry (step 1) declares `telephonyMode` and `supportedBoundaries`; these are the single source of truth for the telephony capability check (`resolveTelephonySttCapability()`) and for streaming-vs-batch mode selection in the media-stream STT session. No per-provider routing maps exist.

3. **Role capability follows the catalog row**: `sttRoleCapabilityGap()` reads `supportedBoundaries` and `telephonyMode` from the row the pair resolves to (`sttCatalogKeyFor(provider, model)`), so a model family that drops a boundary must be its own catalog row. Get the row right and config validation rejects incapable role pairs on its own; nothing per-role needs writing.

4. **No duplicate wiring**: a provider should appear only once in `services.stt`. The telephony layer consumes the same catalog, and a role selects from it; there is no second registration step for telephony or for any role.
