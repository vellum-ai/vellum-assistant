# Clients Architecture

This document owns macOS/iOS client architecture details. The repo-level architecture index lives in [`/ARCHITECTURE.md`](../ARCHITECTURE.md).

## macOS App — Service and State Ownership

The macOS app uses a centralized service container (`AppServices`) created once in `AppDelegate` and passed down via dependency injection rather than singletons or ambient state.

### AppServices Container

`AppServices` is the single owner of all long-lived services. `AppDelegate` creates it on launch and passes individual services to windows, views, and managers.

| Service | Type | Purpose |
|---------|------|---------|
| `daemonClient` | `DaemonClient` | HTTP+SSE to daemon (local mode) or HTTP+SSE to platform proxy (managed mode) |
| `surfaceManager` | `SurfaceManager` | Routes `ui_surface_show` messages |
| `toolConfirmationManager` | `ToolConfirmationManager` | Handles tool permission prompts |
| `secretPromptManager` | `SecretPromptManager` | Handles secret input prompts |
| `zoomManager` | `ZoomManager` | Window zoom level (`@Observable`) |
| `settingsStore` | `SettingsStore` | Shared settings state for both SettingsView and SettingsPanel |

### Main Window State

The main window has three dedicated state objects:

| Object | Pattern | Scope |
|--------|---------|-------|
| `MainWindowState` | `ObservableObject` | Cross-view UI state: active panel, dynamic workspace, API key status |
| `ConversationManager` | `ObservableObject` | Conversation CRUD, tab management, conforms to `ConversationRestorerDelegate` |
| `ConversationRestorer` | Plain class with delegate | Daemon conversation restoration (conversation list responses, history hydration) |

`ConversationManager` owns conversation lifecycle. `ConversationRestorer` handles the async daemon communication for restoring conversations on reconnect, delegating state mutations back through the `ConversationRestorerDelegate` protocol for testability.

### Observation Framework Migration

Low-risk types use Swift's `@Observable` macro (Observation framework) instead of `ObservableObject`/`@Published`:

| Type | Consumer pattern |
|------|-----------------|
| `ZoomManager` | Plain `var` (read-only in views) |
| `ConversationInputState` | `@Bindable` (bindings needed for text input) |
| `BundleConfirmationViewModel` | Plain `var` (read-only in view) |

Types that use Combine `$`-prefixed publishers (e.g., `VoiceTranscriptionViewModel`) remain as `ObservableObject`.

---

## Data Persistence — Where Everything Lives

```mermaid
graph LR
    subgraph "macOS Keychain"
        K1["API Key<br/>service: vellum-assistant<br/>account: anthropic<br/>stored via /usr/bin/security CLI"]
        K2["Credential Secrets<br/>key: credential/{service}/{field}<br/>stored via secure-keys.ts<br/>(encrypted file fallback if Keychain unavailable)"]
    end

    subgraph "UserDefaults (plist)"
        UD1["hasCompletedOnboarding"]
        UD2["assistantName"]
        UD3["activationKey (fn/ctrl)"]
        UD4["ambientAgentEnabled"]
        UD5["ambientCaptureInterval"]
        UD6["maxStepsPerSession"]
    end

    subgraph "~/Library/Application Support/vellum-assistant/"
        direction TB
        SL["logs/session-*.json<br/>───────────────<br/>Per-session JSON log<br/>task, start/end times, result<br/>Per-turn: AX tree, screenshot,<br/>action, token usage"]
    end

    subgraph "~/.vellum/workspace/data/db/assistant.db (SQLite + WAL)"
        direction TB
        CONV["conversations<br/>───────────────<br/>id, title, timestamps<br/>token counts, estimated cost<br/>context_summary (compaction)<br/>conversation_type: 'standard' | 'private'<br/>memory_scope_id: 'default' | 'private:&lt;uuid&gt;'"]
        MSG["messages<br/>───────────────<br/>id, conversation_id (FK)<br/>role: user | assistant<br/>content: JSON array<br/>created_at"]
        TOOL["tool_invocations<br/>───────────────<br/>tool_name, input, result<br/>decision, risk_level<br/>duration_ms"]
        SEG["memory_segments<br/>───────────────<br/>Text chunks for retrieval<br/>Linked to messages<br/>token_estimate per segment"]
        ITEMS["memory_items<br/>───────────────<br/>Extracted facts/entities<br/>kind, subject, statement<br/>confidence, fingerprint (dedup)<br/>verification_state, scope_id<br/>first/last seen timestamps"]
        SUM["memory_summaries<br/>───────────────<br/>scope: conversation | weekly<br/>Compressed history for context<br/>window management"]
        EMB["memory_embeddings<br/>───────────────<br/>target: segment | item | summary<br/>provider + model metadata<br/>vector_json (float array)<br/>Powers semantic search"]
        JOBS["memory_jobs<br/>───────────────<br/>Async task queue<br/>Types: embed, extract,<br/>summarize, backfill, cleanup<br/>Status: pending → running →<br/>completed | failed"]
        ATT["attachments<br/>───────────────<br/>base64-encoded file data<br/>mime_type, size_bytes<br/>Linked to messages via<br/>message_attachments join"]
        REM["reminders<br/>───────────────<br/>One-time scheduled reminders<br/>label, message, fireAt<br/>mode: notify | execute<br/>status: pending → fired | cancelled"]
        SCHED_JOBS["cron_jobs (recurrence schedules)<br/>───────────────<br/>Recurring schedule definitions<br/>cron_expression: cron or RRULE string<br/>schedule_syntax: 'cron' | 'rrule'<br/>timezone, message, next_run_at<br/>enabled, retry_count<br/>Legacy alias: scheduleJobs"]
        SCHED_RUNS["cron_runs (schedule runs)<br/>───────────────<br/>Execution history per schedule<br/>job_id (FK → cron_jobs)<br/>status: ok | error<br/>duration_ms, output, error<br/>Legacy alias: scheduleRuns"]
        TASKS["tasks<br/>───────────────<br/>Reusable prompt templates<br/>title, Handlebars template<br/>inputSchema, contextFlags<br/>requiredTools, status"]
        TASK_RUNS["task_runs<br/>───────────────<br/>Execution history per task<br/>taskId (FK → tasks)<br/>conversationId, status<br/>startedAt, finishedAt, error"]
        WORK_ITEMS["work_items<br/>───────────────<br/>Task Queue entries<br/>taskId (FK → tasks)<br/>title, notes, status<br/>priority_tier (0-3), sort_index<br/>last_run_id, last_run_status<br/>source_type, source_id"]
    end

    subgraph "~/.vellum/ (Root Files)"
        TRUST["protected/trust.json<br/>Tool permission rules"]
    end

    subgraph "~/.vellum/workspace/ (Workspace Files)"
        CONFIG["config files<br/>Hot-reloaded by daemon"]
        ONBOARD_PLAYBOOKS["onboarding/playbooks/<br/>[channel]_onboarding.md<br/>assistant-updatable checklists"]
        ONBOARD_REGISTRY["onboarding/playbooks/registry.json<br/>channel-start index for fast-path + reconciliation"]
        APPS_STORE["data/apps/<br/><app-id>.json + pages/*.html<br/>User-created apps stored here"]
        SKILLS_DIR["skills/<br/>managed skill directories<br/>SKILL.md + TOOLS.json + tools/"]
    end

    subgraph "PostgreSQL (Web Server Only)"
        PG["assistants, users,<br/>channel_accounts,<br/>channel_contacts,<br/>api_tokens, api_keys<br/>───────────────<br/>Multi-tenant management<br/>Billing & provisioning"]
    end
```

---

## Computer Use Session — Detailed Data Flow

Computer use runs through the daemon's main session loop. The daemon decides when to
invoke CU tools, sends `host_cu_request` messages to the client, which executes them
locally via `HostCuExecutor` and posts `host_cu_result` back.

```mermaid
sequenceDiagram
    participant User
    participant Chat as ChatView
    participant AD as AppDelegate
    participant HCE as HostCuExecutor
    participant AX as AccessibilityTree
    participant SC as ScreenCapture
    participant DC as DaemonClient
    participant Daemon as Daemon (Bun)
    participant Claude as Claude API
    participant AV as ActionVerifier
    participant AE as ActionExecutor
    participant macOS as macOS (CGEvents)

    User->>Chat: Type task / Voice / Paste
    Chat->>DC: POST /v1/messages
    DC->>Daemon: HTTP POST
    Note over Daemon: Creates conversation in SQLite<br/>Starts agent loop

    Daemon->>Claude: API call with user message
    Claude-->>Daemon: tool_use (computer use tool)
    Note over Daemon: Model decides CU is needed

    loop host_cu_request / host_cu_result
        Daemon-->>DC: host_cu_request (SSE)
        Note over DC: Contains: tool name, parameters,<br/>step number, reasoning

        DC-->>AD: getOrCreateHostCuOverlay()
        Note over AD: Creates HostCuSessionProxy<br/>Shows SessionOverlayWindow<br/>Pauses ambient agent

        AD->>HCE: execute(request)

        HCE->>AV: verify(action, history)
        Note over AV: Step limit (max 50)<br/>Loop detection (3x same)<br/>Sensitive data check<br/>Destructive key check<br/>System menu bar block<br/>AppleScript sandboxing

        alt allowed
            AV-->>HCE: .allowed
        else needsConfirmation
            AV-->>HCE: .needsConfirmation(reason)
            HCE->>User: confirmation dialog
            User-->>HCE: approve/block
        else blocked
            AV-->>HCE: .blocked(reason)
        end

        HCE->>AE: execute(action)
        Note over AE: click: CGEvent mouse down/up<br/>type: clipboard paste + Cmd+V<br/>key: CGEvent key events<br/>scroll: scroll wheel events<br/>openApp: NSWorkspace launch<br/>appleScript: osascript subprocess

        AE->>macOS: CGEvent injection
        macOS-->>AE: result

        par Parallel Capture
            HCE->>AX: enumerate()
            Note over AX: AXUIElement tree walk<br/>Sets AXEnhancedUserInterface<br/>Filters to interactive elements<br/>Format: [ID] role "title" at (x,y)
            AX-->>HCE: axTree + axDiff
        and
            HCE->>SC: capture()
            Note over SC: ScreenCaptureKit<br/>Exclude own windows<br/>Downscale to 1280x720<br/>JPEG @ 0.6 quality
            SC-->>HCE: base64 screenshot
        end

        HCE->>DC: POST host_cu_result
        Note over DC: Contains: axTree, axDiff,<br/>screenshot, secondaryWindows,<br/>executionResult/error

        DC->>Daemon: HTTP POST
        Daemon->>Claude: API call with observation
        Note over Daemon: Appends tool result<br/>Stores in messages table
        Claude-->>Daemon: next tool_use or end_turn
    end

    Note over Daemon: Agent loop ends (end_turn)
    Daemon-->>DC: message_complete (SSE)
    DC-->>AD: dismissHostCuOverlay()
end
```

---

## Standalone Screen Recording

Standalone screen recording allows users to record their screen without starting a full computer-use session. The daemon manages the recording lifecycle and attaches the resulting video file to the conversation as a file-backed attachment.

### Lifecycle

```
idle → starting → recording → stopping → idle
                                      └→ failed → idle
```

A recording is initiated via dedicated HTTP endpoints (`/v1/recordings/*`). The daemon generates a unique `recordingId`, stores bidirectional mappings (`recordingId ↔ conversationId`), and sends a `recording_start` SSE event to the macOS client. The client manages the actual screen capture via `RecordingManager.swift` and reports status transitions back to the daemon via HTTP.

### Key Files

| File | Role |
|---|---|
| `assistant/src/daemon/handlers/recording.ts` | Daemon handler for start, stop, and status lifecycle events (dedicated HTTP endpoints) |
| `clients/macos/vellum-assistant/ComputerUse/RecordingManager.swift` | macOS-side screen capture using ScreenCaptureKit |

### Messages

| Message | Direction | Transport | Purpose |
|---|---|---|---|
| `recording_start` | Server → Client | SSE | Instructs the client to begin recording with a `recordingId` and optional `RecordingOptions` |
| `recording_stop` | Server → Client | SSE | Instructs the client to stop the active recording |
| `recording_status` | Client → Server | HTTP POST | Reports lifecycle transitions: `started`, `stopped` (with `filePath`), or `failed` (with `error`) |

### Intent Routing

Recording is managed through dedicated HTTP endpoints (`/v1/recordings/*`) rather than intent detection in user messages. Clients call these endpoints directly to start, stop, and query recording status.

### File-Backed Attachments

When a recording stops with a valid `filePath`, the handler:
1. Validates the file exists and reads its size via `statSync`.
2. Creates a file-backed attachment via `uploadFileBackedAttachment()` (avoids reading large video files into memory).
3. Links the attachment to the last assistant message in the conversation (or creates a new one).
4. Sends `assistant_text_delta` + `message_complete` with attachment metadata to the client.

### Recording Flow

```mermaid
sequenceDiagram
    participant Client as macOS Client
    participant Daemon as Daemon (Bun)
    participant RM as RecordingManager

    Client->>Daemon: POST /v1/recordings/start
    Daemon->>Client: recording_start { recordingId, options }
    Client->>RM: startRecording(recordingId)
    RM-->>Client: capture started
    Client->>Daemon: recording_status { status: 'started' }

    Note over RM: Screen capture in progress...

    Client->>Daemon: POST /v1/recordings/stop
    Daemon->>Client: recording_stop { recordingId }
    Client->>RM: stopRecording()
    RM-->>Client: file saved at filePath
    Client->>Daemon: recording_status { status: 'stopped', filePath, durationMs }

    Note over Daemon: uploadFileBackedAttachment<br/>linkAttachmentToMessage
    Daemon->>Client: assistant_text_delta + message_complete { attachments }
```

---

## Dynamic Workspace — Surface Routing and Layout

The workspace is a full-window mode that replaces the chat UI with an interactive dynamic page (WKWebView) and a pinned composer for follow-up messages. It activates when the daemon sends a `ui_surface_show` message with `display != "inline"`.

### Routing Flow (Chat → Workspace)

```mermaid
sequenceDiagram
    participant Daemon as Daemon (HTTP)
    participant DC as DaemonClient
    participant SM as SurfaceManager
    participant AD as AppDelegate
    participant MW as MainWindowView

    Daemon->>DC: ui_surface_show (display != "inline")
    DC->>SM: onSurfaceShow callback
    SM->>SM: Check display field
    alt display == "inline"
        SM->>SM: Show floating NSPanel
    else display != "inline" (workspace route)
        SM->>SM: Add to workspaceRoutedSurfaces set
        SM->>AD: onDynamicPageShow callback
        AD->>AD: Post .openDynamicWorkspace notification
        AD->>MW: Notification with UiSurfaceShowMessage
        MW->>MW: Parse Surface from message
        MW->>MW: Set activeDynamicSurface,<br/>activeDynamicParsedSurface,<br/>isDynamicExpanded = true
        MW->>MW: Render dynamicWorkspaceView()<br/>instead of normal chat
    end

    Note over SM,MW: Updates and dismissals follow<br/>the same notification pattern:<br/>.updateDynamicWorkspace<br/>.dismissDynamicWorkspace
```

**Key types:** `SurfaceManager` routes surfaces by `display` field. `MainWindowView` listens for three notifications (`.openDynamicWorkspace`, `.updateDynamicWorkspace`, `.dismissDynamicWorkspace`) and manages `@State` properties to toggle between chat and workspace views.

### Full-Window Workspace Layout

```
┌────────────────────────────────────────────────┐
│  ← Back    App Title                     ✕     │  ← Toolbar (HStack)
├────────────────────────────────────────────────┤
│                                                │
│                                                │
│           DynamicPageSurfaceView               │  ← WKWebView (fills space)
│              (interactive HTML)                 │
│                                                │
│                                                │
├────────────────────────────────────────────────┤
│  ComposerView (pinned at bottom)               │  ← Follow-up input
└────────────────────────────────────────────────┘
```

The workspace is a `VStack(spacing: 0)` with `VColor.backgroundSubtle` background. The toolbar has back (returns to gallery) and close (exits workspace + panel) buttons. `DynamicPageSurfaceView` grows to fill remaining vertical space. `ComposerView` is pinned at the bottom, bound to the active `ChatViewModel` so users can send follow-up messages while the page is open.

### Widget Injection Pipeline (CSS + JS into WKWebView)

`DynamicPageSurfaceView` is an `NSViewRepresentable` that wraps a `WKWebView`. On creation, three `WKUserScript`s are injected at document start:

```mermaid
graph LR
    subgraph "Injection (at document start)"
        BRIDGE["1. Bridge Script<br/>───────────────<br/>window.vellum.sendAction()<br/>window.vellum.confirm()<br/>window.vellum.data.* (if appId)<br/>console forwarding"]
        CSS["2. Design System CSS<br/>───────────────<br/>vellum-design-system.css<br/>Semantic tokens (--v-*)<br/>Element defaults<br/>Dark/light mode"]
        WIDGETS["3. Widget Utilities JS<br/>───────────────<br/>vellum-widgets.js<br/>sparkline(), barChart()<br/>lineChart(), gauge()<br/>format() helpers"]
    end

    subgraph "Message Passing"
        JS_CALL["JS: window.webkit.messageHandlers<br/>.vellumBridge.postMessage()"]
        COORD["Coordinator<br/>(WKScriptMessageHandler)"]
        DAEMON["AppDelegate → Daemon"]
    end

    BRIDGE --> JS_CALL
    JS_CALL --> COORD
    COORD --> DAEMON
```

**Per-app isolation:** Each app gets its own origin (`https://{appId}.vellum.local/`). The `VellumAppSchemeHandler` handles `vellumapp://` URLs for serving bundled app files from the sandbox directory. Sandbox mode blocks external network requests.

**Data RPC flow:** App JS calls `window.vellum.data.query()` → Coordinator → AppDelegate → Daemon `app_data_request`. Daemon responds with `app_data_response` → `SurfaceManager.resolveDataResponse()` → Coordinator evaluates `window.vellum.data._resolve()` in the WebView.

---


---

## Inline Media Embeds — URL Detection and Rendering Pipeline

Chat messages containing image or video URLs are rendered inline with a click-to-play card (videos) or lazy-loaded preview (images). The pipeline runs entirely on the macOS client with no daemon involvement; settings are persisted to the workspace config file via `WorkspaceConfigIO`.

### Resolution Flow

```mermaid
graph TD
    MSG["ChatMessage.text"] --> EXTRACT["MessageURLExtractor<br/>NSDataDetector + markdown regex<br/>strips code blocks first"]
    EXTRACT --> URLS["Deduplicated URL list"]

    URLS --> VP{"Video parsers<br/>(tried in order)"}
    VP -->|match| ALLOWLIST["DomainAllowlistMatcher<br/>exact + subdomain matching"]
    VP -->|no match| IMG_CLASS["ImageURLClassifier<br/>extension-based (.png, .jpg, ...)"]

    ALLOWLIST -->|allowed| VIDEO_INTENT["MediaEmbedIntent.video<br/>(provider, videoID, embedURL)"]
    ALLOWLIST -->|blocked| SKIP["Skip URL"]

    IMG_CLASS -->|.image| IMAGE_INTENT["MediaEmbedIntent.image(url)"]
    IMG_CLASS -->|.unknown| MIME_PROBE["ImageMIMEProbe<br/>async HTTP HEAD<br/>NSCache-backed"]
    IMG_CLASS -->|.notImage| SKIP

    MIME_PROBE -->|image/*| IMAGE_INTENT
    MIME_PROBE -->|other| SKIP

    subgraph "Video Parsers"
        YT["YouTubeParser<br/>watch, shorts, embed, youtu.be"]
        VIMEO["VimeoParser<br/>standard, player, channels, groups"]
        LOOM["LoomParser<br/>share, embed"]
    end

    VP --> YT
    VP --> VIMEO
    VP --> LOOM
```

`MediaEmbedResolver` is the single entry point. It checks whether the feature is enabled, filters out messages that predate the `enabledSince` timestamp, calls `MessageURLExtractor.extractAllURLs`, and runs each URL through the video parsers and image classifier. The result is an array of `MediaEmbedIntent` values consumed by the chat view.

### Rendering Components

| Component | Purpose |
|---|---|
| `InlineImageEmbedView` | `AsyncImage` wrapper; defers loading until `onAppear` to avoid eager fetches in long histories. Tapping opens the URL in the default browser. Silent `EmptyView` on failure. |
| `InlineVideoEmbedCard` | Click-to-play card with state machine (`placeholder` -> `initializing` -> `playing` / `failed`). Tears down webview on `onDisappear` to prevent background audio and memory leaks. |
| `InlineVideoWebView` | `NSViewRepresentable` wrapping `WKWebView`. Uses `VideoEmbedURLBuilder` to add provider-specific autoplay parameters. |
| `InlineVideoEmbedStateManager` | `@MainActor ObservableObject` driving the card's lifecycle states. |

### Security Policies

The video webview applies three hardening layers:

1. **Ephemeral storage** -- `WKWebViewConfiguration.websiteDataStore = .nonPersistent()` so no cookies, local storage, or cache survive the session.
2. **Navigation policy** -- The first programmatic load (the embed URL we control) is always allowed. Subsequent `navigationType == .other` loads are checked against a per-provider host allowlist (e.g. `*.googlevideo.com`, `*.ytimg.com` for YouTube; `*.vimeocdn.com` for Vimeo; `*.loomcdn.com` for Loom). Unrecognised hosts and all user-initiated navigations (link clicks, form submissions) are cancelled and opened in the system browser via `NSWorkspace`.
3. **Popup blocking** -- `createWebViewWith` returns `nil`, preventing embedded players from opening new windows.

### Settings Persistence

Appearance-related preferences that must be shared with the daemon live in the workspace config file (`~/.vellum/workspace/config.json`) under `ui`:

```json
{
  "ui": {
    "userTimezone": "America/New_York",
    "mediaEmbeds": {
      "enabled": true,
      "enabledSince": "2026-02-15T12:00:00Z",
      "videoAllowlistDomains": ["youtube.com", "youtu.be", "vimeo.com", "loom.com"]
    }
  }
}
```

`SettingsStore` loads these values on init via `WorkspaceConfigIO.read` and writes them back via `WorkspaceConfigIO.merge`. `ui.userTimezone` provides an explicit user-local timezone hint for daemon-side temporal grounding when profile memory is unavailable. The `enabledSince` timestamp ensures only messages created after the user enabled embeds are eligible, so toggling the feature on doesn't retroactively embed every historical link.

### Key Source Files

| File | Role |
|---|---|
| `clients/macos/.../MediaEmbeds/MessageURLExtractor.swift` | URL extraction (plain text + markdown links, code-block exclusion) |
| `clients/macos/.../MediaEmbeds/ImageURLClassifier.swift` | Extension-based image classification |
| `clients/macos/.../MediaEmbeds/ImageMIMEProbe.swift` | Async HTTP HEAD probe for extensionless URLs |
| `clients/macos/.../MediaEmbeds/DomainAllowlistMatcher.swift` | HTTPS-only domain allowlist with subdomain support |
| `clients/macos/.../MediaEmbeds/MediaEmbedResolver.swift` | Pipeline orchestrator: settings gate, extraction, classification, dedup |
| `clients/macos/.../MediaEmbeds/VideoProviders/YouTubeParser.swift` | YouTube URL parsing (watch, shorts, embed, youtu.be) |
| `clients/macos/.../MediaEmbeds/VideoProviders/VimeoParser.swift` | Vimeo URL parsing (standard, player, channels, groups) |
| `clients/macos/.../MediaEmbeds/VideoProviders/LoomParser.swift` | Loom URL parsing (share, embed) |
| `clients/macos/.../MediaEmbeds/VideoEmbedURLBuilder.swift` | Provider-specific embed URL construction with autoplay params |
| `clients/macos/.../MediaEmbeds/InlineImageEmbedView.swift` | Lazy-loaded inline image rendering |
| `clients/macos/.../MediaEmbeds/InlineVideoEmbedCard.swift` | Click-to-play video card with state machine |
| `clients/macos/.../MediaEmbeds/InlineVideoWebView.swift` | Privacy-hardened WKWebView wrapper |
| `clients/macos/.../MediaEmbeds/InlineVideoEmbedState.swift` | Video embed lifecycle state + manager |
| `clients/macos/.../Features/Settings/MediaEmbedSettings.swift` | Centralized defaults and domain normalization |
| `clients/macos/.../Features/Settings/SettingsStore.swift` | Settings persistence (reads/writes `ui.userTimezone` and `ui.mediaEmbeds` in workspace config) |

---


---

## Avatar System

The avatar uses a simple image-based approach: a custom user-uploaded profile picture, or a colored-circle initial-letter fallback.

**Components:**
- `AvatarAppearanceManager` — Observable singleton that provides `chatAvatarImage` (custom PNG or initial-letter fallback). Watches the custom avatar file for live updates.
- `AvatarCustomizationPanel` — User surface for uploading/clearing a custom profile picture

**Custom avatar storage:** User-uploaded profile pictures are stored at `~/.vellum/workspace/data/avatar/avatar-image.png`. On first launch after upgrade, any legacy avatar from `~/Library/Application Support/vellum-assistant/` is automatically migrated (copied, not moved). The avatar customization panel is accessible from the Identity panel via a "Customize Avatar" CTA button.

**Fallback:** When no custom avatar exists, `buildInitialLetterAvatar(name:)` renders a Forest._600 circle with the assistant's first initial in white.

## Managed Sign-In (macOS)

Managed sign-in allows macOS users to connect to a platform-hosted assistant during first-run onboarding instead of running a local daemon. When a user clicks "Sign in" on the onboarding screen, the app authenticates via WorkOS through the platform, ensures a managed assistant exists (via the idempotent hatch endpoint), and connects to it through platform proxy endpoints.

### Sign-In Flow

```
User clicks "Sign in"
  --> WorkOS authentication (via AuthManager)
  --> ManagedAssistantBootstrapService.ensureManagedAssistant()
      --> If connectedAssistantId stored: GET /v1/assistants/{id}/  (retrieve by ID)
      --> Otherwise: POST /v1/assistants/hatch/  (idempotent — returns existing or creates new)
  --> Upsert lockfile entry (cloud: "vellum")
  --> Set connectedAssistantId in UserDefaults
  --> Configure managed HTTP transport
  --> Proceed to app
```

If managed bootstrap fails, the user stays on the onboarding screen with an error message and a retry option. The app does not proceed until bootstrap succeeds or the user chooses a different path.

### Transport Modes

`HTTPDaemonClient` supports two route modes, selected based on the lockfile entry's `cloud` field:

| Mode | Route Pattern | Auth Header | When Used |
|------|--------------|-------------|-----------|
| `runtimeFlat` | `/health`, `/v1/messages`, `/v1/events` | `Authorization: Bearer {token}` | Local daemon, gateway-proxied remote |
| `platformAssistantProxy` | `/v1/assistants/{id}/health/`, `/v1/assistants/{id}/messages/` | `X-Session-Token: {token}` | Platform-managed assistants (`cloud == "vellum"`) |

The route mode and auth mode are carried in `TransportMetadata` (defined in `DaemonConfig.swift`) and threaded through the `DaemonConfig` to the `HTTPDaemonClient`. `AppDelegate.configureDaemonTransport(for:)` selects the mode based on `LockfileAssistant.isManaged`.

### Startup Guardrails

When the current assistant is managed (`isCurrentAssistantManaged == true`), the app skips:
- **Local daemon hatching** -- the platform hosts the daemon, so `vellumCli.hatch()` is not called.
- **Actor credential bootstrap** -- identity is derived from the platform session token, not local actor tokens. The `ensureActorCredentials()` flow is skipped entirely.
- **Server-unavailable re-hatch** -- the reconnection loop does not attempt local re-hatch when the daemon HTTP server is unreachable.

### Credential and State Storage

| Data | Storage | Location |
|------|---------|----------|
| Session token | Keychain | provider: `session-token` (via `SessionTokenManager`) |
| Platform token file | Filesystem | `~/.vellum/platform-token` (0600 permissions, daemon-readable) |
| Managed lockfile entry | Filesystem | `~/.vellum.lock.json` (entry with `cloud: "vellum"`) |
| Connected assistant ID | UserDefaults | `connectedAssistantId` |

### 401 Handling in Managed Mode

When a managed-mode HTTP request receives a 401, the `HTTPDaemonClient` does not attempt the bearer token refresh flow (which is designed for local actor tokens). Instead, it emits a `conversation_error` event so the app can prompt re-authentication through the platform.

### Key Files

| File | Purpose |
|------|---------|
| `clients/shared/App/Auth/ManagedAssistantBootstrapService.swift` | Discover-or-create orchestrator for managed assistants |
| `clients/shared/App/Auth/AuthService.swift` | Platform API methods (`getAssistant`, `hatchAssistant`) |
| `clients/shared/App/Auth/SessionTokenManager.swift` | Session token storage (Keychain + `~/.vellum/platform-token` file bridge) |
| `clients/shared/Network/DaemonConfig.swift` | `RouteMode`, `AuthMode`, `TransportMetadata` types |
| `clients/shared/Network/HTTPDaemonClient.swift` | Endpoint builder and auth application for both route modes |
| `clients/macos/vellum-assistant/App/AppDelegate.swift` | Transport selection (`configureDaemonTransport`) and startup guardrails |
| `clients/macos/vellum-assistant/Features/Onboarding/OnboardingFlowView.swift` | Onboarding sign-in UI and managed bootstrap invocation |
| `clients/macos/vellum-assistant/Features/MainWindow/Panels/IdentityData.swift` | `LockfileAssistant.isManaged` computed property and managed entry upsert |

---

## GatewayHTTPClient Migration (In Progress)

`DaemonClient` and `HTTPTransport` are being incrementally migrated to `GatewayHTTPClient`. New HTTP API calls should use `GatewayHTTPClient` instead of adding methods to `DaemonClient` or `HTTPTransport`.

### Why

The assistant currently exposes an HTTP port so that the native client can call its REST API directly via `DaemonClient`/`HTTPTransport`. By routing these calls through the gateway instead, we can eventually remove that HTTP port entirely and lock down the assistant's networking surface. `GatewayHTTPClient` is the client-side piece of this: an authenticated HTTP client that talks to the gateway (and its platform proxy) instead of hitting the assistant directly.

### Pattern

Each migrated API surface gets a focused protocol + struct, instantiated inline on the consuming type. Once every method has been migrated off `DaemonClient`/`HTTPTransport`, the assistant's HTTP port can be removed:

1. **Define a protocol** describing the operations (e.g. `ConversationClientProtocol`).
2. **Implement a struct** that calls `GatewayHTTPClient.get/post/delete(path:timeout:)`.
3. **Instantiate the struct** inline as a private property on the consuming type (e.g. `private let client: any SurfaceClientProtocol = SurfaceClient()`).
4. **Remove** the corresponding method from `DaemonClient` and `HTTPTransport`.
5. **Clean up** any `Endpoint` enum cases that are no longer referenced.

### Key Files

| File | Purpose |
|------|---------|
| `clients/shared/Network/GatewayHTTPClient.swift` | Authenticated HTTP client for gateway and platform proxy requests |
| `clients/shared/Network/DaemonClient.swift` | Legacy client (do not add new HTTP methods here) |
| `clients/shared/Network/HTTPDaemonClient.swift` | Legacy HTTP transport (do not add new HTTP methods here) |

---

## iOS Connection Architecture

The iOS app connects to the macOS assistant exclusively via HTTPS through the gateway.

### Connection Flow

```
iOS App  --HTTPS-->  Ingress (tunnel/public URL)  -->  Gateway  -->  Runtime
         <--SSE---                                 <--          <--
```

1. **Pairing** provides the iOS app with an ingress URL and bearer token via QR code scan with Mac-side approval.
2. **HTTP+SSE transport**: The iOS `HTTPDaemonClient` sends commands via HTTP POST to the gateway and receives events via Server-Sent Events (SSE). All communication is authenticated with the bearer token.
3. **Gateway proxy**: The gateway's runtime proxy forwards `/v1/*` requests to the local runtime, validating the bearer token on each request.

### Pairing Flow (v4)

iOS pairing uses a v4 QR code protocol with Mac-side approval. There is no manual entry option.

**QR payload (v4):**
```json
{
  "type": "vellum-daemon", "v": 4,
  "id": "<mac-hash>",
  "g": "<resolved-gateway-url>",
  "pairingRequestId": "<uuid>",
  "pairingSecret": "<Random Hex Value>",
  "localLanUrl": "http://<lan-ip>:7830"  // only present when VELLUM_ENABLE_INSECURE_LAN_PAIRING=1
}
```

**Flow:**
1. macOS generates a v4 QR code (no bearer token in QR) and pre-registers the pairing request with the daemon via `POST /v1/pairing/register`.
2. iOS scans the QR code, extracts the `pairingRequestId` and `pairingSecret`, and sends a pairing request to the gateway (`POST /pairing/request`). If `localLanUrl` is present (requires `VELLUM_ENABLE_INSECURE_LAN_PAIRING=1`), tries it first (3s timeout), then falls back to cloud gateway URL (`g`).
3. The daemon validates the secret and either auto-approves (if the device is in the allowlist) or sends an SSE event to macOS to show an approval prompt.
4. macOS shows a floating approval window with three options: Deny, Approve Once, Always Allow.
5. iOS polls `GET /pairing/status?id=<id>&secret=<secret>` every 2.5s until approved, denied, or expired (5-min TTL).
6. On approval, the response includes the bearer token and gateway URL. iOS saves these and connects.

**Daemon endpoints:**
- `POST /v1/pairing/register` -- macOS pre-registers a pairing request (bearer-authenticated).
- `POST /v1/pairing/request` -- iOS initiates pairing (unauthenticated, secret-gated).
- `GET /v1/pairing/status` -- iOS polls for approval status (unauthenticated, secret-gated).

**Gateway proxy endpoints** (unauthenticated, proxied to daemon):
- `POST /pairing/request` -> daemon `/v1/pairing/request`
- `GET /pairing/status` -> daemon `/v1/pairing/status`

**Approved devices:** Devices paired with "Always Allow" are persisted to `~/.vellum/protected/approved-devices.json` (keyed by hashed deviceId). Future pairings from allowlisted devices auto-approve without a prompt. The macOS Connect tab shows an Approved Devices list with remove/clear actions.

### JWT Credential Refresh (Shared: macOS + iOS)

Both macOS and iOS clients use a single JWT access token for all HTTP authentication, sent as `Authorization: Bearer <jwt>`. The JWT serves as both authentication and identity — there is no separate `X-Actor-Token` header. A shared credential refresh mechanism maintains valid tokens without re-bootstrapping or re-pairing. Bootstrap (macOS) and pairing (iOS) are only used for initial credential issuance.

**Credential storage:** The client stores the following in the Keychain:

| Data | Storage | Purpose |
|------|---------|---------|
| Access token (JWT) | Keychain | `Authorization: Bearer <jwt>` header for authenticated requests |
| Refresh token | Keychain | Presented to the refresh endpoint to rotate credentials |
| Access token expiry | Keychain | Absolute expiry timestamp of the current access token |
| Refresh token expiry | Keychain | Absolute expiry timestamp of the current refresh token |
| `refreshAfter` | Keychain | Timestamp at which the client should proactively refresh (80% of access token TTL) |

**Proactive refresh:** Both macOS and iOS run a periodic check every 5 minutes. If `now >= refreshAfter`, the client calls `POST /v1/guardian/refresh` (through the gateway) with the current refresh token and `Authorization: Bearer <jwt>`. On success, the response provides a new `accessToken`, `refreshToken`, `accessTokenExpiresAt`, `refreshTokenExpiresAt`, and `refreshAfter`. All stored credentials are updated atomically.

**401 recovery:** When an HTTP request receives a 401 response with `{ "code": "refresh_required" }`, the `HTTPTransport` attempts a single refresh before surfacing a "Session expired" error. If the refresh succeeds, the original request is retried with the new JWT. If the 401 contains a different code or the refresh fails (e.g., refresh token expired or revoked), the client surfaces the session-expired error and the user must re-pair (iOS) or re-bootstrap (macOS).

**Shared utility:** `ActorCredentialRefresher` is a shared utility used by both platforms. It encapsulates the refresh HTTP call, credential update, and error handling. `ActorTokenManager` on each platform delegates to this refresher for both proactive and reactive (401-recovery) refresh flows.

**No legacy bootstrap-as-renewal:** macOS no longer re-bootstraps on every launch. Bootstrap runs only when no access token exists at all (first launch or after credential wipe). All subsequent renewal is handled by the refresh flow.

### Prerequisites

- A gateway URL must be configured (cloud tunnel or LAN). LAN pairing requires setting `VELLUM_ENABLE_INSECURE_LAN_PAIRING=1`; when enabled, `localLanUrl` is included in the QR payload.
- A conversation key is auto-generated on first connect and stored in UserDefaults.
- iOS maintains a stable `deviceId` (UUID) in the Keychain across reinstalls.

### Configuration Storage (iOS)

| Data | Storage | Key |
|------|---------|-----|
| Gateway URL | UserDefaults | `gateway_base_url` |
| Bearer token | Keychain | provider: `runtime-bearer-token` |
| Actor token | Keychain | provider: `actor-token` |
| Refresh token | Keychain | provider: `actor-refresh-token` |
| Conversation key | UserDefaults | `conversation_key` |
| Host ID | UserDefaults | `gateway_host_id` |
| Device ID | Keychain | provider: `pairing-device-id` |

### Key Files

| File | Purpose |
|------|---------|
| `clients/ios/Views/Settings/QRPairingSheet.swift` | QR scan, v4 parsing, pairing handshake, polling |
| `clients/ios/Views/Settings/ConnectionSettingsSection.swift` | Connection status and QR scan entry point |
| `clients/macos/vellum-assistant/Features/Settings/PairingQRCodeSheet.swift` | macOS v4 QR generation, pre-registration with daemon |
| `clients/macos/vellum-assistant/Features/Settings/PairingApprovalWindow.swift` | Floating approval prompt window |
| `assistant/src/daemon/pairing-store.ts` | In-memory pairing request store with TTL |
| `assistant/src/daemon/approved-devices-store.ts` | Persistent approved devices allowlist |
| `assistant/src/daemon/handlers/pairing.ts` | Pairing approval handlers |
| `gateway/src/http/routes/pairing-proxy.ts` | Gateway proxy for pairing endpoints |

### Offline Message Queue (iOS)

When the daemon is unreachable, outgoing user messages are buffered in `OfflineMessageQueue` (a persistent FIFO stored in UserDefaults) instead of surfacing an error. The message bubble shows a "Pending" indicator (`ChatMessageStatus.pendingOffline`) while offline. On reconnect (`daemonDidReconnect`), `ChatViewModel.flushOfflineQueue()` drains the queue and sends messages in order, clearing the pending indicator.

| Component | Role |
|-----------|------|
| `clients/ios/App/OfflineMessageQueue.swift` | Persistent FIFO queue; serialized to `offline_message_queue_v1` in UserDefaults |
| `ChatMessageStatus.pendingOffline` | Message status for locally buffered, unsent messages |
| `ChatViewModel.flushOfflineQueue()` | Drains the queue on reconnect, sending messages in FIFO order |
| `MessageBubbleView` | Renders a clock icon + "Pending" label for `.pendingOffline` messages |

Storage key: `offline_message_queue_v1` (UserDefaults).

### Guardian Approval Card UI (macOS/iOS)

Guardian approval prompts are rendered as structured card UIs in the chat timeline using a "buttons first, text fallback" model. The daemon delivers `GuardianDecisionPrompt` objects via HTTP+SSE, and the client renders them as kind-aware cards with tappable action buttons.

**Kind-aware rendering:** `GuardianDecisionBubble` renders distinct card headers for each canonical request kind:

| Kind | Header | Icon | Accent |
|------|--------|------|--------|
| `tool_approval` | "Tool Approval Required" | `shield.lefthalf.filled` | Warning |
| `pending_question` | "Question Pending" | `questionmark.circle.fill` | Accent |
| `access_request` | "Access Request" | `person.badge.key.fill` | Warning |

**Interaction model:** Each card displays the `questionText` (which includes text fallback directives for `access_request`), action buttons (Approve once / Reject), and secondary metadata (tool name, request code). Buttons submit decisions via `POST /v1/guardian-actions/decision` with the `requestId` and chosen action. The `requestCode` is always visible as a "Ref:" label so guardians can use text-based fallback (`<code> approve` / `<code> reject`) if buttons are not available or not used.

**Shared primitives:** Action buttons use `VButton` (from the design system), and the button row is rendered by `GuardianApprovalActionRow`. Resolved prompts collapse to `ApprovalStatusRow` showing the outcome.

| File | Purpose |
|------|---------|
| `clients/shared/Features/Chat/GuardianDecisionBubble.swift` | Kind-aware guardian approval card with action buttons |
| `clients/shared/Features/Chat/ApprovalActionRow.swift` | `GuardianApprovalActionRow` — renders action buttons using `VButton` |
| `clients/shared/Features/Chat/ApprovalStatusRow.swift` | Collapsed resolved-state display |
| `clients/shared/Features/Chat/ToolConfirmationBubble.swift` | Tool confirmation card with approve/deny actions |

---

## Shared Feature Stores

Cross-platform `ObservableObject` stores in `clients/shared/Features/` encapsulate daemon communication and state management. Platform views delegate data operations to these stores while owning their own UI presentation state.

| Store | Location | Purpose |
|-------|----------|---------|
| `SkillsStore` | `shared/Features/Skills/SkillsStore.swift` | Skills CRUD: list, search, inspect, install, uninstall, enable/disable, configure, draft, and create. Caches inspect results and uses generation counters to handle stale responses. |
| `ContactsStore` | `shared/Features/Contacts/ContactsStore.swift` | Contacts CRUD: list, get, update channel policy, delete. Auto-refreshes on `contactsChanged` daemon broadcasts with 500ms debounce. |
| `DirectoryStore` | `shared/Features/Directory/DirectoryStore.swift` | Directory data: local apps, shared apps, documents. Supports open, delete, share-to-cloud, fork, and bundle operations. Auto-refreshes on `appFilesChanged` broadcasts. |
| `ChannelTrustStore` | `shared/Features/ChannelTrust/ChannelTrustStore.swift` | Guardian state and channel trust management. Composes `ContactsStore` for guardian contact data, manages pending guardian action prompts via daemon HTTP API. |

### Store Patterns

All shared stores follow the same async pattern for daemon communication:

1. Subscribe to the daemon's `AsyncStream` via `daemonClient.subscribe()`
2. Send a request message via the appropriate `DaemonClient` method
3. Iterate the stream with `for await`, matching on the expected response case
4. Update `@Published` state on the main actor
5. Cancel subscription tasks in `deinit` to prevent leaks

Stores use `[weak self]` in all `Task` closures and background subscriptions. Platform views own stores via `@ObservedObject` or `@StateObject` and pass them down to child views.

---

## iOS Feature Flows

### Intelligence Tab (M6)

The Intelligence tab is the iOS hub for skills and contacts management, gated on daemon connectivity.

| View | File | Purpose |
|------|------|---------|
| `InstalledSkillsView` | `ios/Views/Intelligence/InstalledSkillsView.swift` | List of installed skills with enable/disable swipe actions and uninstall |
| `SkillDetailView` | `ios/Views/Intelligence/SkillDetailView.swift` | Skill details with ClaWhub inspect data, enable/disable/uninstall actions |
| `ContactsListView` | `ios/Views/Intelligence/ContactsListView.swift` | Searchable contacts list with guardian section and delete swipe actions |
| `ContactDetailView` | `ios/Views/Intelligence/ContactDetailView.swift` | Contact details with channel list and policy editing via confirmation dialog |

### Things Tab (M8-M9)

The Things tab provides access to local apps, shared apps, and documents via a segmented picker.

| View | File | Purpose |
|------|------|---------|
| `ThingsView` | `ios/Views/Things/ThingsView.swift` | Segmented container switching between My Apps, Shared, and Documents |
| `AppsGridView` | `ios/Views/Things/AppsGridView.swift` | 2-column LazyVGrid of local apps with pin, share, bundle, and delete context menu actions |
| `SharedAppsListView` | `ios/Views/Things/SharedAppsListView.swift` | List of shared apps with detail sheet for fork/delete |
| `DocumentsListView` | `ios/Views/Things/DocumentsListView.swift` | Searchable, sortable document list |

### Settings Parity (M7)

New settings sections brought to iOS for feature parity with macOS:

| View | File | Purpose |
|------|------|---------|
| `ModelsServicesSection` | `ios/Views/Settings/ModelsServicesSection.swift` | Active model display/set, API key management via Keychain |
| `PrivacySection` | `ios/Views/Settings/PrivacySection.swift` | System permission status display with deep-link to iOS Settings |
| `ChannelsGuardianSection` | `ios/Views/Settings/ChannelsGuardianSection.swift` | Guardian status, guardian channel management, approved contacts overview |

---

## macOS Deep-Link Send (M11)

The macOS app registers a `vellum://send?message=...` URL scheme handler. When invoked, it creates or reuses a conversation and sends the message through the daemon. This enables external tools, scripts, and iOS Shortcuts to trigger assistant actions on the Mac.

---
