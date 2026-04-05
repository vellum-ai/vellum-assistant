# Daemon Handler Test Plan

> Test plan for `assistant/src/daemon/handlers/` — the transport-agnostic business logic layer of the Vellum Assistant daemon.

---

## 1. Daemon Handler Coverage Audit

### 1a. Existing Direct Coverage

These handler functions are imported and called as the primary test subject in existing test files:

| Function | Test File | Tests | Coverage Quality |
|----------|-----------|-------|-----------------|
| `parseIdentityFields` | `parse-identity-fields.test.ts` | 7 | Good — parsing, field extraction |
| `isTemplatePlaceholder` | `parse-identity-fields.test.ts` | 5 | Good — positive + negative cases |
| `detectDictationModeHeuristic` | `dictation-mode-detection.test.ts` | 5 | Moderate — covers 3 modes, no edge cases (empty input, case sensitivity) |
| `renderHistoryContent` | `server-history-render.test.ts` | 23 | Very good — text, files, images, tool calls, surfaces, thinking, interleaving |
| `compareSemver` | `daemon/handlers/shared.test.ts` | 20 | Very good — numeric, prefix stripping, pre-release, edge cases, sort integration |
| `handleRecordingStart` | `recording-handler.test.ts` | 4 | Good — basic start, options passthrough, duplicate rejection, global guard |
| `handleRecordingStop` | `recording-handler.test.ts` | 4 | Good — basic stop, no-recording, global fallback, broadcast |
| `handleRecordingStatusCore` | `recording-handler.test.ts` | 11 | Good — started/stopped/failed statuses, file validation, path traversal, attachments |
| `handleConfirmationResponse` | `handlers-user-message-approval-consumption.test.ts` | 1 | Minimal — only tests canonical status sync, not core requestId routing or no-match case |
| `getTelegramConfig` | `telegram-config.test.ts` | 1 | Minimal — only tests bot username backfill. No set/clear/commands/setup coverage. |
| `getSlackChannelConfig` | `slack-channel-config.test.ts` | 5 | Good — unconfigured, connected, backfill, per-field presence, metadata from config |
| `setSlackChannelConfig` | `slack-channel-config.test.ts` | 3 | Good — xapp prefix validation, valid app token, bot token via Slack API |
| `clearSlackChannelConfig` | `slack-channel-config.test.ts` | 2 | Moderate — basic clear + metadata cleanup |
| `installSkill` | `install-skill-routing.test.ts` | 7 | Good — routing between clawhub/skillssh/bundled/catalog, auto-enable |
| `searchSkills` | `search-skills-unified.test.ts` | 7 | Good — multi-registry, deduplication, fallback on registry failure |
| `handleChannelVerificationSession` | `channel-guardian.test.ts` | 164 | Extremely comprehensive — verification lifecycle, rate limiting, voice, outbound, all actions |

**Total: 15 functions with direct tests, 269 test cases.**

### 1b. Mocked Only (Not Actually Tested)

These handler functions appear in test files but are **mocked to no-ops** — the test exercises a different module's behavior, not the handler logic itself:

| Function | Where Mocked | What This Means |
|----------|-------------|----------------|
| `cancelGeneration` | `conversation-clear-safety.test.ts`, `conversation-fork-route.test.ts`, `cancel-resolves-conversation-key.test.ts` | Mocked as `() => true`. The HTTP route dispatch is tested, but the handler's actual abort + subagent termination logic is not. |
| `regenerateResponse` | `conversation-clear-safety.test.ts`, `conversation-fork-route.test.ts` | Mocked as `async () => null`. The re-run-agent-loop logic is untested. |
| `undoLastMessage` | `conversation-clear-safety.test.ts`, `conversation-fork-route.test.ts` | Mocked as `async () => null`. The conversation-key resolution + undo logic is untested. |
| `handleSecretResponse` | `send-endpoint-busy.test.ts`, `approval-routes-http.test.ts`, `voice-session-bridge.test.ts`, 6 others | Mocked as `() => {}`. The standalone-vs-conversation routing logic is untested. |
| `handleIngressConfig` | `call-domain.test.ts`, `twilio-routes.test.ts` | Mocked as `async () => {}`. The config save + Twilio webhook reconciliation is untested. |
| `syncTwilioWebhooks` | `call-domain.test.ts`, `twilio-routes.test.ts` | Mocked as `async () => ({ success: true })`. |
| `getIngressConfigResult` | `permission-mode-sse.test.ts` | Mocked as `() => ({})`. |
| `normalizeActivationKey` | `permission-mode-sse.test.ts` | Mocked as `() => ({ ok: true, value: "" })`. The comprehensive validation logic is untested. |
| `clearAllConversations` | `conversation-clear-safety.test.ts`, `recording-handler.test.ts`, 5 others | Mocked as `() => 0` in HandlerContext. The in-memory + DB clear logic is untested. |
| `makeEventSender` | `acp-session.test.ts` (mentioned in comment) | Referenced but never called with real logic. |
| `ensureSkillEntry` | `install-skill-routing.test.ts`, `search-skills-unified.test.ts` | Mocked as `() => ({ enabled: false })`. The self-healing guard logic is untested. |
| `backfillSlackInjectionTemplates` | `credential-vault-unit.test.ts` | Mocked to noop. |

### 1c. Completely Untested

Organized by handler source file. Every exported function listed below has zero direct test coverage.

**`conversations.ts`** (16 untested functions):
- `handleConversationCreate` — creates conversation, sets up host proxies, processes initial message
- `handleConversationSwitch` — loads/restores conversation, sends conversation_info
- `handleConversationRename` — updates title in DB, sends update event
- `handleUsageRequest` — reads token counts, sends usage_response
- `handleDeleteQueuedMessage` — removes queued message, sends confirmation
- `handleReorderConversations` — batch updates display order in DB
- `handleUndo` — undoes last message, sends undo_complete
- `handleSecretResponse` — routes secret to standalone or conversation (routing logic untested; mocked elsewhere)
- `switchConversation` — transport-agnostic switch logic
- `renameConversation` — transport-agnostic rename logic
- `deleteQueuedMessage` — transport-agnostic queue deletion
- `clearAllConversations` — clears in-memory + DB (logic untested; mocked elsewhere)
- `cancelGeneration` — aborts agent loop + subagents (logic untested; mocked elsewhere)
- `undoLastMessage` — resolves key, calls undo (logic untested; mocked elsewhere)
- `regenerateResponse` — re-runs agent loop with trace events (logic untested; mocked elsewhere)
- `makeEventSender` — creates event callback with pending interaction registration

**`config-model.ts`** (7 untested functions):
- `getModelInfo` — returns current model, provider, configured providers
- `setModel` — validates provider, saves config, reinitializes providers, evicts conversations
- `setImageGenModel` — saves image gen model to config
- `handleModelGet` — sends model_info via ctx.send
- `handleModelSet` — delegates to setModel, sends result
- `handleImageGenModelSet` — delegates to setImageGenModel
- `MODEL_TO_PROVIDER` — reverse lookup constant

**`config-embeddings.ts`** (2 untested functions):
- `getEmbeddingConfigInfo` — returns provider, model, backend status, available providers
- `setEmbeddingConfig` — validates provider, saves config, clears backend cache

**`config-voice.ts`** (3 untested functions):
- `handleVoiceConfigUpdate` — validates key, broadcasts client_settings_update
- `normalizeActivationKey` — comprehensive input validation (logic untested; mocked elsewhere)
- `broadcastClientSettingsUpdate` — sends settings update to all clients

**`config-ingress.ts`** (4 untested functions):
- `handleIngressConfig` — get/set ingress config, Twilio reconciliation (logic untested; mocked elsewhere)
- `getIngressConfigResult` — reads raw config (logic untested; mocked elsewhere)
- `syncTwilioWebhooks` — pushes webhook URLs to Twilio API (logic untested; mocked elsewhere)
- `computeGatewayTarget` — returns gateway base URL

**`config-telegram.ts`** (6 untested functions):
- `setTelegramConfig` — validates via Telegram getMe API, stores token + webhook secret, rollback on failure
- `clearTelegramConfig` — deregisters webhook, deletes credentials
- `setTelegramCommands` — calls Telegram setMyCommands API
- `setupTelegram` — composite set + commands
- `handleTelegramConfig` — action dispatcher (get/set/clear/set_commands/setup)
- `summarizeTelegramError` — error formatting with token redaction

**`config-vercel.ts`** (3 untested functions):
- `getVercelConfig` — checks secure storage for API token
- `setVercelConfig` — stores token with credential metadata
- `deleteVercelConfig` — deletes token and metadata

**`config-channels.ts`** (4 untested standalone functions):
- `createInboundChallenge` — creates verification session (tested indirectly via handleChannelVerificationSession, but not independently)
- `getVerificationStatus` — returns binding status and guardian details
- `revokeVerificationForChannel` — full teardown of verification binding
- `verifyTrustedContact` — multi-channel verification with rate limiting

**`skills.ts`** (14 untested functions):
- `listSkills` — loads catalog, resolves states, converts to SlimSkillResponse
- `listSkillsWithCatalog` — merges installed with remote catalog
- `getSkill` — single skill lookup with origin-specific enrichment
- `getSkillFiles` — recursive directory listing with security checks
- `enableSkill` — enables skill in config, broadcasts, seeds memory
- `disableSkill` — disables skill in config, broadcasts
- `configureSkill` — updates skill env/apiKey/config
- `uninstallSkill` — deletes skill, cleans config, broadcasts
- `updateSkill` — delegates to clawhubUpdate
- `checkSkillUpdates` — delegates to clawhubCheckUpdates
- `inspectSkill` — delegates to clawhubInspect
- `draftSkill` — LLM-powered metadata generation with heuristic fallback
- `createSkill` — creates managed skill, auto-enables, seeds memory
- `postInstallSkill` — shared post-install logic

**`conversation-history.ts`** (2 untested functions):
- `performConversationSearch` — searches conversations, wildcard support
- `getMessageContent` — returns parsed message content by ID

**`recording.ts`** (5 untested functions):
- `handleRecordingRestart` — stop→start orchestration with operation tokens
- `handleRecordingPause` — broadcasts pause event
- `handleRecordingResume` — broadcasts resume event
- `isRecordingIdle` — state query combining maps
- `getActiveRestartToken` — returns current restart token

**`shared.ts`** (3 untested utility functions):
- `requestSecretStandalone` — sends secret_request, awaits response with timeout
- `createSigningCallback` — sends sign_bundle_payload, awaits response
- `formatBytes` — byte size formatting

### 1d. Summary

**15 of ~100 exported handler functions have direct tests (269 test cases). ~12 are mocked but their actual logic is untested. ~75 have zero coverage.**

---

## 2. Contribution Strategy

Fill coverage gaps for the ~75 untested handler functions and extend existing tests where coverage is thin. New tests follow established codebase patterns: `recording-handler.test.ts` for HandlerContext construction and sent-array assertions, `slack-channel-config.test.ts` for external API mocking via `globalThis.fetch`, and `install-skill-routing.test.ts` for `mock.module` setup with captured mocks.

Tests are organized by complexity tier so that partial completion still delivers value — pure function tests (Tier 1) are trivially mergeable, and each subsequent tier builds on patterns established in the previous one. Every new test file is independently runnable.

### File Placement: CI Discovery Constraint

The CI test runner (`assistant/scripts/test.sh` line 55) uses `find src/__tests__ -maxdepth 1 -type f -name '*.test.ts'` — it only discovers test files at the **top level** of `src/__tests__/`, not in subdirectories. All 620+ existing test files follow this convention.

Therefore: new test files go at `assistant/src/__tests__/handler-*.test.ts` (with a `handler-` prefix), not in a `handlers/` subdirectory. The shared helper module stays at `assistant/src/__tests__/handlers/handler-test-helpers.ts` (it's not a test file and doesn't need CI discovery). Test files import it as `./handlers/handler-test-helpers.js`.

---

## 3. Shared Infrastructure

### `assistant/src/__tests__/handlers/handler-test-helpers.ts`

Reusable factories consumed by all handler test files. Not a test file itself. Test files import as `./handlers/handler-test-helpers.js`.

```typescript
import { mock } from "bun:test";
import type { HandlerContext } from "../../daemon/handlers/shared.js";
import { DebouncerMap } from "../../util/debounce.js";

const noop = () => {};

export function createTestHandlerContext(): {
  ctx: HandlerContext;
  sent: Array<{ type: string; [k: string]: unknown }>;
} {
  const sent: Array<{ type: string; [k: string]: unknown }> = [];
  const ctx: HandlerContext = {
    conversations: new Map(),
    sharedRequestTimestamps: [],
    debounceTimers: new DebouncerMap({ defaultDelayMs: 200 }),
    suppressConfigReload: false,
    setSuppressConfigReload: noop,
    updateConfigFingerprint: noop,
    send: (msg) => { sent.push(msg as { type: string; [k: string]: unknown }); },
    broadcast: (msg) => { sent.push(msg as { type: string; [k: string]: unknown }); },
    clearAllConversations: () => 0,
    getOrCreateConversation: async () => { throw new Error("not implemented"); },
    touchConversation: noop,
  };
  return { ctx, sent };
}

export function createMockConversation(overrides: Record<string, unknown> = {}) {
  return {
    setPreactivatedSkillIds: noop,
    setTurnChannelContext: noop,
    setTurnInterfaceContext: noop,
    setHostBashProxy: noop,
    setHostFileProxy: noop,
    setHostCuProxy: noop,
    addPreactivatedSkillId: noop,
    updateClient: noop,
    processMessage: mock(async () => {}),
    hasPendingConfirmation: () => false,
    hasPendingSecret: () => false,
    handleConfirmationResponse: mock(() => {}),
    handleSecretResponse: mock(() => {}),
    abort: mock(() => {}),
    undo: mock(() => 2),
    removeQueuedMessage: mock(() => true),
    isProcessing: () => false,
    dispose: mock(() => {}),
    markStale: mock(() => {}),
    headlessLock: false,
    trustContext: undefined,
    ...overrides,
  };
}

export const noopLogger = {
  info: noop, warn: noop, error: noop, debug: noop,
  trace: noop, fatal: noop, child: () => noopLogger,
};
```

---

## 4. New Test Files

### Tier 1: Pure Functions (no mocks needed)

#### `assistant/src/__tests__/handler-config-voice-pure.test.ts`

**Why**: `normalizeActivationKey` has zero test coverage. It is mocked to a stub in `permission-mode-sse.test.ts`. The function has 200 lines of validation logic covering legacy enums, natural language mappings, and PTTActivator JSON with field-level validation.

**Functions**: `normalizeActivationKey`

**Test cases** (20):
- Legacy enum values: `"fn"` → ok/fn, `"ctrl"` → ok/ctrl, `"fn_shift"` → ok/fn_shift, `"none"` → ok/none
- Case insensitive: `"Fn"` → ok/fn, `"CTRL"` → ok/ctrl
- Natural language: `"globe"` → fn, `"control"` → ctrl, `"fn+shift"` → fn_shift, `"off"` → none, `"disabled"` → none
- PTTActivator JSON valid: modifierOnly, key, modifierKey, mouseButton, none
- PTTActivator invalid: bad kind, missing required fields, keyCode out of range, reserved mouseButton, non-numeric keyCode
- Malformed JSON, invalid string, whitespace handling

---

### Tier 2: Simple Handlers

#### `assistant/src/__tests__/handler-config-vercel.test.ts`

**Why**: `getVercelConfig`, `setVercelConfig`, `deleteVercelConfig` have zero test coverage. They are simple credential CRUD operations that follow the same pattern as the tested Slack/Telegram handlers.

**Functions**: `getVercelConfig`, `setVercelConfig`, `deleteVercelConfig`

**Mock modules** (2): `util/logger`, `tools/credentials/metadata-store`
**Real modules**: `security/secure-keys` (uses real encrypted store in temp dir)

**Test cases** (7):
- GET when no token → `{ hasToken: false, success: true }`
- GET when token exists → `{ hasToken: true, success: true }`
- SET with valid token → stores, returns `{ hasToken: true, success: true }`
- SET with undefined token → `{ success: false, error }`
- SET writes metadata with `allowedTools: ["deploy", "publish_page"]`
- DELETE when token exists → deletes, returns `{ hasToken: false }`
- DELETE when no token → `{ hasToken: false, success: true }`

#### `assistant/src/__tests__/handler-conversation-history.test.ts`

**Why**: `performConversationSearch` and `getMessageContent` have zero test coverage. These are the query layer for conversation search and message content retrieval.

**Functions**: `performConversationSearch`, `getMessageContent`

**Mock modules** (3): `util/logger`, `memory/conversation-crud`, `memory/conversation-queries`

**Test cases** (11):
- Search with query → delegates to `searchConversations`
- Search with `"*"` wildcard → delegates to `listConversations`
- Search with limit → passes limit through
- Empty results → returns `[]`
- getMessageContent with text blocks → returns `{ text, messageId }`
- getMessageContent with tool calls → returns `{ toolCalls: [...] }`
- getMessageContent not found → returns `null`
- getMessageContent with raw string (not JSON) → returns `{ text: rawString }`
- getMessageContent with null content → returns empty text
- getMessageContent with mixed text + tool calls → returns both
- getMessageContent with conversationId → passes to lookup

#### `assistant/src/__tests__/handler-conversations-simple.test.ts`

**Why**: `handleConversationRename`, `handleUsageRequest`, `handleReorderConversations`, `handleDeleteQueuedMessage`, `clearAllConversations` have zero test coverage. These are simple validate-call-respond handlers.

**Functions**: `handleConversationRename`, `handleUsageRequest`, `handleReorderConversations`, `handleDeleteQueuedMessage`, `clearAllConversations`

**Mock modules** (7): `util/logger`, `config/loader`, `memory/conversation-crud`, `memory/conversation-key-store`, `memory/conversation-title-service`, `runtime/pending-interactions`, `security/secret-scanner`

**Test cases** (14):
- Rename existing → sends `conversation_title_updated`
- Rename non-existent → sends `error`
- Rename with empty string → still succeeds (no content validation)
- Usage existing → sends `usage_response` with token counts + cost
- Usage non-existent → sends `error`
- Usage zero → sends response with zeros
- Reorder valid array → calls `batchSetDisplayOrders`
- Reorder non-array → no-op
- Reorder empty array → calls with `[]`
- Delete queued found → sends `message_queued_deleted`
- Delete queued conversation not found → no sent message
- Delete queued message not found → no sent message
- clearAllConversations → returns count, calls DB clearAll
- clearAllConversations empty → returns 0

---

### Tier 3: Medium Handlers

#### `assistant/src/__tests__/handler-config-model.test.ts`

**Why**: All 7 config-model functions have zero test coverage. `setModel` is particularly important — it reinitializes providers and evicts/marks-stale conversations on model change.

**Functions**: `getModelInfo`, `setModel`, `setImageGenModel`, `handleModelGet`, `handleModelSet`, `handleImageGenModelSet`

**Mock modules** (7): `util/logger`, `config/loader`, `config/raw-config-utils`, `config/schemas/services` (for `VALID_INFERENCE_PROVIDERS`), `providers/model-catalog`, `providers/model-intents`, `providers/provider-availability`, `providers/registry`

**Test cases** (16):
- getModelInfo → returns model, provider, configuredProviders, availableModels, allProviders
- setModel success → saves config, reinitializes providers, returns updated info
- setModel with explicit provider → uses explicit provider over auto-detection
- setModel invalid provider → throws
- setModel provider change → auto-resets model to new provider's default
- setModel unavailable provider → returns current info unchanged
- setModel no-op (same model+provider) → skips reinitialization
- setModel evicts idle conversations → calls `dispose()`, deletes from Map
- setModel marks busy conversations stale → calls `markStale()`
- setModel suppresses config reload → calls `setSuppressConfigReload(true)`
- setImageGenModel → calls `setServiceField` with `"image-generation"`, updates fingerprint
- setImageGenModel suppresses reload
- handleModelGet → sends `model_info`
- handleModelSet success → sends `model_info`
- handleModelSet failure → sends `error`
- handleImageGenModelSet → delegates to setImageGenModel

#### `assistant/src/__tests__/handler-config-embeddings.test.ts`

**Why**: Both `getEmbeddingConfigInfo` and `setEmbeddingConfig` have zero test coverage. The embedding system supports 5 providers with per-provider model fields.

**Functions**: `getEmbeddingConfigInfo`, `setEmbeddingConfig`

**Mock modules** (4): `util/logger`, `config/loader`, `config/raw-config-utils`, `memory/embedding-backend`

**Test cases** (8):
- getInfo returns current provider, model, active backend status, available providers
- getInfo with provider lacking model field → `model: null`
- getInfo with degraded backend → `status.degraded: true`
- setConfig valid provider → saves, clears cache, updates fingerprint
- setConfig invalid provider → throws with valid provider list
- setConfig with model → sets provider-specific model field
- setConfig with empty model → deletes model field override
- setConfig without model → only sets provider

#### `assistant/src/__tests__/handler-config-voice.test.ts`

**Why**: `handleVoiceConfigUpdate` and `broadcastClientSettingsUpdate` have zero test coverage. The handler connects normalizeActivationKey to the broadcast system.

**Functions**: `handleVoiceConfigUpdate`, `broadcastClientSettingsUpdate`

**Mock modules** (1): `util/logger`

**Test cases** (7):
- handleVoiceConfigUpdate valid `"fn"` → broadcasts `client_settings_update` with `key: "activationKey"`, `value: "fn"`
- handleVoiceConfigUpdate natural language `"globe"` → broadcasts with `value: "fn"`
- handleVoiceConfigUpdate PTTActivator JSON → broadcasts with JSON string value
- handleVoiceConfigUpdate invalid key → warns, no broadcast
- handleVoiceConfigUpdate empty string → no broadcast
- broadcastClientSettingsUpdate sends correct message shape
- broadcastClientSettingsUpdate logs key + value

#### `assistant/src/__tests__/handler-skills-simple.test.ts`

**Why**: `listSkills`, `enableSkill`, `disableSkill`, `configureSkill`, `getSkill`, `getSkillFiles` have zero test coverage. These are the CRUD operations for the skill management UI.

**Functions**: `listSkills`, `enableSkill`, `disableSkill`, `configureSkill`, `getSkill`, `getSkillFiles`

**Mock modules** (14): Same set as `install-skill-routing.test.ts` — copy its mock setup.

**Test cases** (14):
- listSkills empty catalog → `[]`
- listSkills mixed sources → sorted by kind rank then alphabetical
- listSkills includes correct kind/origin/status per source type
- enableSkill → config `enabled: true`, broadcasts `skills_state_changed`, seeds memory
- enableSkill config failure → `{ success: false, error }`
- disableSkill → config `enabled: false`, broadcasts
- disableSkill config failure → `{ success: false, error }`
- configureSkill sets env → persisted
- configureSkill sets apiKey → persisted
- configureSkill sets config → persisted
- getSkill existing → returns `{ skill: SkillDetailResponse }`
- getSkill not found → `{ error, status: 404 }`
- getSkillFiles existing → returns file listing
- getSkillFiles not found → `{ error, status: 404 }`

#### `assistant/src/__tests__/handler-conversations-medium.test.ts`

**Why**: `handleConversationSwitch`, `handleSecretResponse`, `cancelGeneration`, `undoLastMessage`, `handleUndo` have zero or minimal direct coverage. `handleConfirmationResponse` has only 1 test covering canonical sync, not core routing.

**Functions**: `handleConversationSwitch`, `handleSecretResponse`, `cancelGeneration`, `undoLastMessage`, `handleUndo`, + `handleConfirmationResponse` (additional cases)

**Mock modules** (8): `util/logger`, `config/loader`, `memory/conversation-crud`, `memory/conversation-key-store`, `memory/conversation-title-service`, `runtime/pending-interactions`, `security/secret-scanner`, `subagent/index`

**Test cases** (19):
- switchConversation existing → sends `conversation_info`
- switchConversation not found → sends `error`
- switchConversation headless-locked → loads without rebinding
- switchConversation restores evicted conversation via getOrCreateConversation
- handleConfirmationResponse routes to correct conversation by requestId
- handleConfirmationResponse no matching conversation → logs warning
- handleConfirmationResponse touches conversation
- handleSecretResponse standalone (pendingStandaloneSecrets) → resolves, clears timeout
- handleSecretResponse conversation → routes to correct conversation
- handleSecretResponse no match → logs warning
- handleSecretResponse delivery mode passed through
- cancelGeneration active → calls abort(), aborts subagents, returns true
- cancelGeneration not found → returns false
- cancelGeneration touches conversation
- undoLastMessage existing → calls undo(), returns `{ removedCount }`
- undoLastMessage resolves conversation key
- undoLastMessage not found → returns null
- handleUndo existing → sends `undo_complete`
- handleUndo not found → sends error

---

### Tier 4: Complex Handlers

#### `assistant/src/__tests__/handler-config-telegram.test.ts`

**Why**: `setTelegramConfig`, `clearTelegramConfig`, `setTelegramCommands`, `setupTelegram`, `handleTelegramConfig` have zero test coverage. The existing `telegram-config.test.ts` only tests `getTelegramConfig` (1 test). These handlers interact with the Telegram Bot API and have complex rollback logic.

**Functions**: `setTelegramConfig`, `clearTelegramConfig`, `setTelegramCommands`, `setupTelegram`, `handleTelegramConfig`, `summarizeTelegramError`

**Mock modules** (8): `config/loader`, `inbound/platform-callback-registration`, `daemon/handlers/shared`, `security/secure-keys`, `oauth/oauth-store`, `oauth/manual-token-connection`, `telegram/bot-username`, `tools/credentials/metadata-store`

**External API**: `globalThis.fetch` replacement per test (Telegram getMe, deleteWebhook, setMyCommands).

**Test cases** (22):
- setTelegramConfig valid token → calls getMe, stores token + webhook secret, returns connected
- setTelegramConfig invalid token (getMe error) → `{ success: false }`
- setTelegramConfig network error → `{ success: false }`
- setTelegramConfig auto-generates webhook secret when missing
- setTelegramConfig webhook secret storage failure → rolls back token, reverts config
- setTelegramConfig existing token from storage → validates existing token
- setTelegramConfig platform callback registration when containerized
- clearTelegramConfig token exists → calls deleteWebhook, deletes creds, clears config
- clearTelegramConfig webhook failure → proceeds with cleanup
- clearTelegramConfig no token → succeeds
- setTelegramCommands valid → calls setMyCommands API
- setTelegramCommands no token → returns error
- setTelegramCommands API failure → returns error
- setupTelegram both succeed → merged result
- setupTelegram set succeeds commands fail → success with warning
- setupTelegram set fails → failure immediately
- handleTelegramConfig dispatches "get" → calls getTelegramConfig
- handleTelegramConfig dispatches "set" → calls setTelegramConfig
- handleTelegramConfig dispatches "clear" → calls clearTelegramConfig
- handleTelegramConfig dispatches "set_commands" → calls setTelegramCommands
- handleTelegramConfig dispatches "setup" → calls setupTelegram
- handleTelegramConfig unknown action → sends error

#### `assistant/src/__tests__/handler-config-ingress.test.ts`

**Why**: All 4 config-ingress functions have zero direct test coverage. They are mocked to stubs in 3 other test files. The handler manages public ingress URLs and Twilio webhook reconciliation.

**Functions**: `getIngressConfigResult`, `handleIngressConfig`, `syncTwilioWebhooks`, `computeGatewayTarget`

**Mock modules** (6): `calls/twilio-rest`, `config/env`, `config/loader`, `inbound/platform-callback-registration`, `inbound/public-ingress-urls`, `util/logger`

**Test cases** (14):
- getIngressConfigResult enabled → returns `{ enabled: true, publicBaseUrl, localGatewayTarget }`
- getIngressConfigResult not configured → `{ enabled: false, publicBaseUrl: "" }`
- computeGatewayTarget → returns gateway base URL from env
- handleIngressConfig GET → sends current config
- handleIngressConfig SET with URL enabled → saves config, sets module-level URL
- handleIngressConfig SET disabled → clears module-level URL
- handleIngressConfig SET triggers Telegram callback when containerized
- handleIngressConfig SET reconciles Twilio webhooks when enabled + creds exist
- handleIngressConfig SET with empty URL → clears publicBaseUrl
- handleIngressConfig SET with multiple assigned numbers → reconciles all
- handleIngressConfig SET without Twilio creds → skips reconciliation
- handleIngressConfig unknown action → sends error
- syncTwilioWebhooks success → `{ success: true }`
- syncTwilioWebhooks failure → `{ success: false, warning }`

#### `assistant/src/__tests__/handler-conversations-complex.test.ts`

**Why**: `handleConversationCreate`, `regenerateResponse`, and `makeEventSender` have zero test coverage. `handleConversationCreate` is the most complex conversation handler — it creates conversations, sets up host proxies for desktop clients, pre-activates skills, and fires the agent loop.

**Functions**: `handleConversationCreate`, `regenerateResponse`, `makeEventSender`

**Mock modules** (12): `util/logger`, `config/loader`, `memory/conversation-crud`, `memory/conversation-key-store`, `memory/conversation-title-service`, `memory/canonical-guardian-store`, `runtime/pending-interactions`, `security/secret-scanner`, `channels/types`, `tools/tool-input-summary`, `subagent/index`, `util/truncate`

**Test cases** (17):
- handleConversationCreate basic → sends `conversation_info`
- handleConversationCreate with initial message → calls `processMessage`
- handleConversationCreate with preactivatedSkillIds → calls `setPreactivatedSkillIds`
- handleConversationCreate macOS interface → sets up HostBashProxy/FileProxy/CuProxy, adds computer-use skill
- handleConversationCreate non-desktop interface → no host proxies
- handleConversationCreate with initial message triggers title generation
- handleConversationCreate processMessage error → sends error, sets fallback title
- handleConversationCreate with systemPromptOverride → passed to getOrCreateConversation
- regenerateResponse resolves conversation key → calls regenerate, returns `{ requestId }`
- regenerateResponse not found → returns null
- regenerateResponse error → throws, emits trace error
- regenerateResponse touches conversation and updates client
- makeEventSender confirmation_request → registers pending interaction + canonical request
- makeEventSender secret_request → registers pending interaction
- makeEventSender host_bash_request → registers pending interaction
- makeEventSender host_cu_request → registers pending interaction
- makeEventSender ACP permission (acpToolKind) → skips normal registration

#### `assistant/src/__tests__/handler-skills-complex.test.ts`

**Why**: `uninstallSkill`, `draftSkill`, `createSkill`, `updateSkill`, `listSkillsWithCatalog`, `inspectSkill`, `checkSkillUpdates`, `postInstallSkill` have zero test coverage. (`installSkill` and `searchSkills` already have 7 tests each.)

**Functions**: `uninstallSkill`, `draftSkill`, `createSkill`, `updateSkill`, `listSkillsWithCatalog`, `inspectSkill`, `checkSkillUpdates`, `postInstallSkill`

**Mock modules** (14+): Same set as `install-skill-routing.test.ts`, plus provider mock for `draftSkill`.

**Test cases** (19):
- uninstallSkill managed → calls deleteManagedSkill, cleans config, broadcasts
- uninstallSkill namespaced slug → direct filesystem removal
- uninstallSkill path traversal attempt → `{ success: false, error: "Invalid skill name" }`
- uninstallSkill not found → error
- uninstallSkill config cleanup
- draftSkill with full frontmatter → extracts all fields, no LLM call
- draftSkill without frontmatter, no LLM → heuristic fallback with warnings
- draftSkill without frontmatter, LLM available → calls provider
- draftSkill LLM timeout → heuristic fallback with warning
- draftSkill skillId normalization
- createSkill valid → calls createManagedSkill, auto-enables, seeds, broadcasts
- createSkill already exists → returns error
- createSkill auto-enable failure → logs warning, still returns success
- updateSkill success → calls clawhubUpdate, reloads catalog
- updateSkill failure → returns error
- listSkillsWithCatalog → merges installed with catalog, deduplicates
- listSkillsWithCatalog catalog fetch failure → returns installed-only
- inspectSkill → delegates to clawhubInspect
- checkSkillUpdates → delegates to clawhubCheckUpdates

---

## 5. Extensions to Existing Test Files

### `assistant/src/__tests__/parse-identity-fields.test.ts` — +6 cases

Existing: 12 tests covering basic parsing and placeholders.

New cases:
- Multiple colons in value (e.g., `**Name:** Dr. Who: Time Lord`) → captures full value after `:**`
- `**Vibe:**` as alternate key for personality → parsed correctly
- Empty string input → all fields empty
- No matching field lines → all fields empty
- Extra blank lines between fields → still parses all
- Markdown with additional non-field content (headers, paragraphs) → ignores noise

### `assistant/src/__tests__/dictation-mode-detection.test.ts` — +7 cases

Existing: 5 tests covering command/action/dictation modes.

New cases:
- Empty transcription `""` → `"dictation"` (no verb match)
- Uppercase action verb `"Send a message"` → verify behavior (action verbs lowercased)
- Whitespace-only selected text → should NOT trigger command mode
- Multiple action verbs but second word → `"dictation"` (only first word checked)
- Cursor in text field, no selected text, non-action verb → `"dictation"`
- All action verbs (`"slack"`, `"email"`, `"send"`, `"create"`, `"open"`, `"search"`, `"find"`, `"message"`, `"text"`, `"schedule"`, `"remind"`, `"launch"`, `"navigate"`) → each returns `"action"`
- Selected text overrides action verb → `"command"` even if transcription starts with `"send"`

### `assistant/src/__tests__/slack-channel-config.test.ts` — +5 cases

Existing: 10 tests covering GET/POST/DELETE basics.

New cases:
- POST with both bot + app tokens in one call → `connected: true`, both stored
- POST bot token only (no app) → warning about missing app token
- clearSlackChannelConfig partial deletion failure → reports accurate per-key status
- GET backfills injection templates on existing credentials (verify `upsertCredentialMetadata` called)
- POST Slack auth.test network timeout/exception → returns error

### `assistant/src/__tests__/install-skill-routing.test.ts` — +3 cases

Existing: 7 tests covering routing between registries.

New cases:
- Feature flag disabled for skill → `{ success: false }` with feature flag message
- Bundled skill → auto-enables without catalog reload or directory install
- Clawhub install with `package.json` present → runs `bun install` after install

### `assistant/src/__tests__/recording-handler.test.ts` — +8 cases

Existing: 19 tests covering start/stop/status lifecycle.

New cases for `handleRecordingRestart`:
- Active recording → stops current, stores deferred start, returns `{ initiated: true, operationToken }`
- No active recording → `{ initiated: false, reason: "no_active_recording" }`
- Restart already in progress → `{ initiated: false, reason: "restart_in_progress" }`
- Cross-conversation restart → keys deferred restart by owner conversation

New cases for `handleRecordingStatusCore` extensions:
- `restart_cancelled` status → cleans up restart state, sends cancellation message
- `stopped` with deferred restart pending → triggers new recording start, finalizes old
- Operation token mismatch → rejects stale status callback
- `paused`/`resumed` statuses → log only, no error

---

## 6. Risks and Blockers

### 1. `mock.module` ordering is fragile
Every `mock.module()` call must appear **before** any `import` of the module under test. If a handler transitively imports an unmocked module, it may pull in the real implementation and cause startup errors. Mitigation: when a test fails on import, trace the handler's import tree and add missing mocks.

### 2. `test-preload.ts` is required
All tests in `assistant/src/__tests__/` get the test-preload via `bunfig.toml` (creates temp workspace dir, resets DB). Verified: the preload runs for files at both the top level and in subdirectories. New test files at `__tests__/handler-*.test.ts` inherit preload automatically.

### 3. `Conversation` constructor is too heavy
Never construct a real `Conversation` in handler tests. Always mock `getOrCreateConversation` to return `createMockConversation()`. The real constructor requires 20+ mocked modules and triggers side effects.

### 4. `config/loader.js` has a wide export surface
Many handlers import `getConfig`, `loadRawConfig`, `saveRawConfig`, `invalidateConfigCache`, `setNestedValue`, and sometimes more. Each test must stub all actually-called exports. When in doubt, stub generously.

### 5. `secure-keys.js` has two valid test strategies
- **Mock strategy**: In-memory record store (simpler, used by `telegram-config.test.ts`)
- **Real strategy**: Real encrypted store in temp dir via `_setStorePath` (more thorough, used by `slack-channel-config.test.ts`)
Choose based on what the handler exercises. Vercel tests should use the real strategy since the handler is thin.

### 6. `globalThis.fetch` must be restored
Tests replacing `globalThis.fetch` must save the original at module level and restore in `beforeEach`/`afterEach`. Pattern: `const originalFetch = globalThis.fetch;` before imports.

### 7. Module-level state in handler files
`recording.ts` has module-level Maps reset by `__resetRecordingState()`. The `config-channels.ts` has a lazy `_readinessService` singleton. If tests see stale state, check for module-level variables.

### 8. `conversations.ts` handlers traverse `ctx.conversations` Map
`handleConfirmationResponse` and `handleSecretResponse` iterate the Map. Tests must populate it with mock conversations whose `hasPendingConfirmation`/`hasPendingSecret` return the expected values.

### 9. Circular dependency risk with `shared.js`
`shared.ts` exports `log` via `getLogger("handlers")`. If logger isn't mocked before importing shared.js, the real Pino logger initializes. Always mock the logger first.

### 10. `skills.ts` has a deep dependency tree
The skills handler imports from 15+ modules. Copy the mock setup from `install-skill-routing.test.ts` verbatim.

---

## 7. Implementation Order

Each file is independently runnable. Earlier files establish patterns reused later.

| # | File | Tier | New Tests | Notes |
|---|------|------|-----------|-------|
| 1 | `__tests__/handlers/handler-test-helpers.ts` | — | 0 | Shared infrastructure. Write first. |
| 2 | `__tests__/handler-config-voice-pure.test.ts` | 1 | 20 | Pure validation. Zero mocks, fastest to write. |
| 3 | `__tests__/handler-conversation-history.test.ts` | 2 | 11 | First file with mock.module. Minimal mocks. |
| 4 | `__tests__/handler-config-vercel.test.ts` | 2 | 7 | Semi-integration with real secure keys. |
| 5 | `__tests__/handler-conversations-simple.test.ts` | 2 | 14 | First use of createTestHandlerContext. |
| 6 | `__tests__/handler-config-embeddings.test.ts` | 3 | 8 | Config mutation + cache invalidation. |
| 7 | `__tests__/handler-config-voice.test.ts` | 3 | 7 | Broadcast assertion pattern. |
| 8 | `__tests__/handler-config-model.test.ts` | 3 | 16 | Provider reinit, conversation eviction. |
| 9 | `__tests__/handler-skills-simple.test.ts` | 3 | 14 | Many mocks (copies install-skill-routing). |
| 10 | `__tests__/handler-conversations-medium.test.ts` | 3 | 19 | Conversations Map, requestId routing. |
| 11 | `__tests__/handler-config-telegram.test.ts` | 4 | 22 | globalThis.fetch, rollback scenarios. |
| 12 | `__tests__/handler-config-ingress.test.ts` | 4 | 14 | Config save + Twilio reconciliation. |
| 13 | `__tests__/handler-conversations-complex.test.ts` | 4 | 17 | Conversation create, host proxies, agent loop. |
| 14 | `__tests__/handler-skills-complex.test.ts` | 4 | 19 | Uninstall, draft, create, update. |
| — | **Extensions to existing files:** | | | |
| 15 | `parse-identity-fields.test.ts` | ext | +6 | Edge cases for parsing. |
| 16 | `dictation-mode-detection.test.ts` | ext | +7 | Empty input, case, verb list. |
| 17 | `slack-channel-config.test.ts` | ext | +5 | Dual tokens, partial failure. |
| 18 | `install-skill-routing.test.ts` | ext | +3 | Feature flags, bundled, bun install. |
| 19 | `recording-handler.test.ts` | ext | +8 | Restart, pause, resume, token mismatch. |

---

## 8. Summary

**13 new test files** + 1 shared helper + **5 extensions to existing test files**.

**217 new test cases** covering **~70 previously-untested handler functions**.

Combined with the 269 existing test cases, this brings daemon handler coverage from **15/~100 functions (15%)** to **~85/~100 functions (~85%)**.

The remaining ~15 untested functions are either thin wrappers (`handleTelegramConfig` dispatches to tested sub-functions), constants (`MODEL_TO_PROVIDER`), or deep-infrastructure utilities (`requestSecretStandalone`, `createSigningCallback`) that require WebSocket-level test harnesses beyond the scope of this plan.
