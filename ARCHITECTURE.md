# Vellum Assistant — Architecture

This file is the cross-system architecture index. Detailed designs live in domain docs close to code ownership.

## Architecture Docs

| Domain | Architecture Doc |
|---|---|
| Assistant runtime | [`assistant/ARCHITECTURE.md`](assistant/ARCHITECTURE.md) |
| Gateway ingress/webhooks | [`gateway/ARCHITECTURE.md`](gateway/ARCHITECTURE.md) |
| Clients (macOS/iOS) | [`clients/ARCHITECTURE.md`](clients/ARCHITECTURE.md) |
| Assistant memory deep dive | [`assistant/docs/architecture/memory.md`](assistant/docs/architecture/memory.md) |
| Assistant integrations deep dive | [`assistant/docs/architecture/integrations.md`](assistant/docs/architecture/integrations.md) |
| Assistant scheduling deep dive | [`assistant/docs/architecture/scheduling.md`](assistant/docs/architecture/scheduling.md) |
| Assistant security deep dive | [`assistant/docs/architecture/security.md`](assistant/docs/architecture/security.md) |
| macOS keychain broker | [`assistant/docs/architecture/keychain-broker.md`](assistant/docs/architecture/keychain-broker.md) |
| Gateway SMS parity checklist | [`gateway/docs/sms-twilio-parity-checklist.md`](gateway/docs/sms-twilio-parity-checklist.md) |
| Trusted contact access design | [`assistant/docs/trusted-contact-access.md`](assistant/docs/trusted-contact-access.md) |
| Trusted contacts operator runbook | [`assistant/docs/runbook-trusted-contacts.md`](assistant/docs/runbook-trusted-contacts.md) |

## Cross-Cutting Invariants

- Public ingress is gateway-only; external webhook/API routes are implemented in `gateway/` and forwarded internally.
- Bundled-skill config/status retrieval is CLI-first: `SKILL.md -> bash -> canonical vellum CLI surfaces -> gateway/runtime`. The baseline retrieval path is `vellum config` plus secure secret surfaces (`vellum keys`); domain-specific status reads (for example `vellum integrations ...` or `vellum email ...`) are follow-on surfaces, not a prerequisite for the initial migration. Direct gateway curls are reserved for control-plane writes when no CLI surface exists; keychain lookup commands are not part of bundled skill retrieval guidance.
- Bundled-skill outbound API calls that require credentials default to proxied execution (`bash` with `network_mode: "proxied"` + `credential_ids`) rather than manual token plumbing.
- Managed shared-identity channel routing runs in a separate managed-gateway service lane from the per-assistant `gateway/` lane. The deployable managed-gateway runtime is platform-owned; this repo keeps public contracts/fixtures under `gateway-managed/`.
- Production LLM calls go through the provider abstraction, not provider SDKs in feature code.
- Notification producers emit through `emitNotificationSignal()` to preserve decisioning and audit invariants. Reminder routing metadata (`routingIntent`, `routingHints`) flows through the signal and is enforced post-decision to control multi-channel fanout. The decision engine produces per-channel thread actions (`start_new` / `reuse_existing`) validated against a candidate set; `notification_thread_created` IPC is emitted only on actual creation, not on reuse.
- Memory extraction/recall must enforce actor-role provenance gates for untrusted actors.
- Trusted contact ingress ACL is channel-agnostic; identity binding adapts per channel (chat ID, E.164 phone, external user ID) without channel-specific branching.
- macOS managed sign-in connects the desktop app to a platform-hosted assistant via Django assistant-scoped proxy endpoints (`/v1/assistants/{id}/...`). The `HTTPDaemonClient` operates in `platformAssistantProxy` route mode with `X-Session-Token` auth. Managed lockfile entries have `cloud: "vellum"`. Startup guardrails skip local daemon hatching and actor credential bootstrap. See [`clients/ARCHITECTURE.md`](clients/ARCHITECTURE.md) for the full flow.
- **Assistant feature flags** control skill availability at runtime. The canonical key format is `feature_flags.<flagId>.enabled`; the legacy `skills.<id>.enabled` format is no longer supported. All declared flags live in the unified registry at `meta/feature-flags/feature-flag-registry.json`, scoped by `scope` (`assistant` or `macos`). Labels come from the registry. Bundled copies exist at `assistant/src/config/feature-flag-registry.json` and `gateway/src/feature-flag-registry.json`. The gateway owns the `/v1/feature-flags` REST API (see [`gateway/ARCHITECTURE.md`](gateway/ARCHITECTURE.md)); the daemon resolves effective flag state via the assistant feature-flag resolver (see [`assistant/ARCHITECTURE.md`](assistant/ARCHITECTURE.md)). When a flag is OFF, the corresponding skill is excluded from all exposure surfaces: client skill lists, system prompt catalog, `skill_load`, runtime tool projection, and included child skills. Guard tests enforce that all flag keys in code use the canonical format and that all referenced flags are declared in the unified registry.
- **Context overflow resilience**: The session loop implements a deterministic overflow convergence pipeline that recovers from context-too-large failures without surfacing errors to users. A preflight budget check catches overflow before provider calls; a tiered reducer (forced compaction, tool-result truncation, media stubbing, injection downgrade) iteratively shrinks the payload; and an overflow policy resolver gates latest-turn compression behind user approval for interactive sessions. Non-interactive sessions auto-compress; denied compression produces a graceful assistant explanation message (not a `session_error`). Config lives under `contextWindow.overflowRecovery`. See [`assistant/ARCHITECTURE.md`](assistant/ARCHITECTURE.md#context-overflow-recovery) for the full design and [`assistant/docs/architecture/memory.md`](assistant/docs/architecture/memory.md#context-compaction-and-overflow-recovery-interaction) for compaction interaction details.

## System Overview

```mermaid
graph TB
    subgraph "macOS Menu Bar App (Swift)"
        subgraph "AppServices (singleton container)"
            DC_SWIFT["DaemonClient"]
            AMBIENT["AmbientAgent"]
            SURFACE_MGR["SurfaceManager<br/>route by display field"]
            ZOOM["ZoomManager<br/>(@Observable)"]
            SETTINGS_STORE["SettingsStore<br/>shared settings state"]
        end

        UI["UI Layer<br/>NSStatusItem + Popover<br/>SessionOverlay / ThinkingIndicator<br/>Onboarding / Settings"]
        TI["TaskInputView<br/>Text + Voice + Attachments"]
        CLS["Classifier<br/>Haiku direct call<br/>+ heuristic fallback"]

        subgraph "Computer Use Session"
            PERCEIVE["PERCEIVE<br/>AX Tree + Screenshot<br/>(parallel capture)"]
            VERIFY["VERIFY<br/>ActionVerifier<br/>safety checks"]
            EXECUTE["EXECUTE<br/>ActionExecutor<br/>CGEvent injection"]
            WAIT["WAIT<br/>Adaptive UI settle<br/>AX tree polling"]
        end

        subgraph "Ride Shotgun (Ambient Agent)"
            RS_TRIGGER["RideShotgunTrigger<br/>timer-based auto-invitation<br/>eligibility checks"]
            RS_SESSION["RideShotgunSession<br/>time-boxed observation<br/>daemon IPC + WatchSession"]
            RS_INVITE["RideShotgunInvitationWindow"]
            RS_PROGRESS["RideShotgunProgressWindow"]
            RS_SUMMARY["RideShotgunSummaryWindow"]
            WATCH["WatchSession<br/>timed capture loop"]
            AX_CAP["AmbientAXCapture<br/>shallow tree depth 4"]
            OCR_CAP["ScreenOCR<br/>Vision framework fallback"]
        end

        subgraph "Text Q&A Session"
            TEXT_SESS["TextSession<br/>streaming deltas"]
            TEXT_WIN["TextResponseWindow"]
        end

        subgraph "Main Window"
            MW_STATE["MainWindowState<br/>cross-view UI state"]
            THREAD_MGR["ThreadManager<br/>thread CRUD + delegate"]
            THREAD_RESTORER["ThreadSessionRestorer<br/>daemon session restoration"]
            CHAT_VM["ChatViewModel<br/>session bootstrap + streaming"]
            CHAT_VIEW["ChatView<br/>bubbles + composer + stop"]
        end

        subgraph "Debug Panel"
            TRACE_STORE["TraceStore<br/>in-memory, per-session<br/>dedup + retention cap"]
            DEBUG_PANEL["DebugPanel UI<br/>metrics strip + timeline"]
        end

        subgraph "Dynamic Workspace"
            WORKSPACE["WorkspaceView<br/>toolbar + WKWebView + composer + optional docked chat"]
            DYN_PAGE["DynamicPageSurfaceView<br/>WKWebView + widget injection"]
        end

        VOICE["VoiceInputManager<br/>Fn hold → SFSpeechRecognizer"]
        ATTACH["Attachment System<br/>images, PDFs, text<br/>drag/drop, paste, picker"]
        PERM["PermissionManager<br/>Accessibility, Screen Recording,<br/>Microphone"]
    end

    subgraph "Daemon (Bun + TypeScript)"
        IPC_SERVER["DaemonServer<br/>Unix socket IPC<br/>~/.vellum/vellum.sock"]
        HANDLERS["Message Handlers<br/>session routing"]
        SESSION_MGR["Session Manager<br/>in-memory pool<br/>stale eviction"]

        subgraph "Onboarding Control Plane"
            PLAYBOOK_MGR["OnboardingPlaybookManager<br/>resolve + reconcile channel playbooks"]
            PLAYBOOK_REG["onboarding/playbooks/registry.json<br/>started-channel index"]
            ONBOARD_ORCH["OnboardingOrchestrator<br/>post-hatch sequence + Home Base handoff<br/>runtime onboarding-mode prompt"]
            HOME_BASE_SEED["HomeBaseSeed<br/>prebuilt scaffold seeding<br/>idempotent bootstrap"]
            HOME_BASE_BOOT["HomeBaseBootstrap<br/>durable app-link resolution + repair"]
            HOME_BASE_LINK["HomeBaseAppLinkStore<br/>home_base_app_links table"]
        end

        subgraph "Inference"
            ANTHROPIC["Anthropic Claude<br/>primary provider"]
            OPENAI["OpenAI<br/>secondary provider"]
            GEMINI["Google Gemini<br/>secondary provider"]
            OLLAMA["Ollama<br/>local models"]
        end

        subgraph "Memory System"
            CONV_STORE["ConversationStore<br/>Drizzle ORM CRUD"]
            INDEXER["Memory Indexer<br/>segment + extract"]
            RECALL["Memory Recall<br/>FTS5 + Qdrant + Entity Graph + RRF<br/>Trust + Freshness + Scope"]
            CONFLICT_STORE["ConflictStore<br/>pending/resolved clarification state"]
            CLARIFICATION_RESOLVER["ClarificationResolver<br/>heuristics + timeout-bounded LLM fallback"]
            PROFILE_COMPILER["ProfileCompiler<br/>canonical trusted profile<br/>strict token-cap trimming"]
            JOBS_WORKER["MemoryJobsWorker<br/>poll every 1.5s"]
        end

        subgraph "SQLite Database (~/.vellum/workspace/data/db/assistant.db)"
            DB_CONV["conversations"]
            DB_MSG["messages"]
            DB_TOOL["tool_invocations"]
            DB_SEG["memory_segments"]
            DB_FTS["memory_segment_fts (FTS5)"]
            DB_ITEMS["memory_items"]
            DB_SRC["memory_item_sources"]
            DB_CONFLICTS["memory_item_conflicts"]
            DB_ENT["memory_entities"]
            DB_REL["memory_entity_relations"]
            DB_ITEM_ENT["memory_item_entities"]
            DB_SUM["memory_summaries"]
            DB_EMB["memory_embeddings"]
            DB_JOBS["memory_jobs"]
            DB_ATTACH["attachments"]
            DB_CHAN["channel_inbound_events"]
            DB_KEYS["conversation_keys"]
            DB_REMINDERS["reminders<br/>(routing_intent, routing_hints_json)"]
            DB_SCHED_JOBS["cron_jobs (recurrence schedules)"]
            DB_SCHED_RUNS["cron_runs (schedule execution history)"]
            DB_HOME["home_base_app_links"]
            DB_TASKS["tasks"]
            DB_TASK_RUNS["task_runs"]
            DB_WORK_ITEMS["work_items"]
            DB_CONTACTS["contacts"]
        end

        subgraph "Tracing"
            TRACE_EMITTER["TraceEmitter<br/>per-session, monotonic seq"]
            TOOL_TRACE["ToolTraceListener<br/>event bus subscriber"]
            EVENT_BUS["EventBus<br/>domain events"]
        end

        subgraph "Swarm Orchestration"
            SWARM_TOOL["swarm_delegate tool<br/>recursion guard"]
            ROUTER_PLAN["Router Planner<br/>LLM → DAG plan"]
            DAG_SCHED["DAG Scheduler<br/>topological order<br/>bounded concurrency"]
            WORKER_POOL["Worker Pool<br/>claude_code backend<br/>role-scoped profiles"]
            SYNTH["Synthesizer<br/>LLM + markdown fallback"]
        end

        subgraph "Skill Tool System"
            SKILL_CATALOG["Skill Catalog<br/>bundled + managed + workspace + extra"]
            SKILL_MANIFEST["SKILL.md + TOOLS.json<br/>per-skill directory"]
            SKILL_PROJECTION["projectSkillTools()<br/>session-level projection"]
            SKILL_DERIVE["deriveActiveSkillIds()<br/>scan &lt;loaded_skill&gt; markers"]
            SKILL_FACTORY["SkillToolFactory<br/>manifest → Tool objects"]
            SKILL_HOST_RUNNER["Host Script Runner<br/>in-process import + run()"]
            SKILL_SANDBOX_RUNNER["Sandbox Script Runner<br/>isolated subprocess"]
        end

        subgraph "Integrations"
            INT_REGISTRY["IntegrationRegistry<br/>in-memory definitions"]
            INT_OAUTH["OAuth2 PKCE Flow<br/>gateway callback transport"]
            INT_TOKEN["TokenManager<br/>auto-refresh + retry"]
            GMAIL_CLIENT["GmailClient<br/>REST API wrapper"]
            GMAIL_TOOLS["Gmail Tools<br/>(bundled skill: gmail)"]
        end

        subgraph "Script Proxy"
            PROXY_SESSION["SessionManager<br/>per-conversation proxy sessions"]
            PROXY_SERVER["ProxyServer<br/>HTTP forward + CONNECT"]
            PROXY_ROUTER["Router<br/>MITM vs tunnel decision"]
            PROXY_POLICY["PolicyEngine<br/>credential template matching"]
            PROXY_MITM["MITM Handler<br/>TLS termination + rewrite"]
            PROXY_CERTS["Cert Manager<br/>local CA + leaf certs"]
            PROXY_APPROVAL["ApprovalCallback<br/>→ PermissionPrompter"]
        end

        subgraph "Asset Tools"
            ASSET_SEARCH["asset_search<br/>cross-thread metadata query"]
            ASSET_MATERIALIZE["asset_materialize<br/>decode + write to sandbox"]
            VISIBILITY_POLICY["MediaVisibilityPolicy<br/>private thread gate"]
        end

        HTTP_SERVER["RuntimeHttpServer<br/>(optional, RUNTIME_HTTP_PORT)"]
    end

    subgraph "Gateway (Bun + TypeScript)"
        GW_WEBHOOK["Telegram Webhook<br/>/webhooks/telegram"]
        GW_VERIFY["Verify Secret<br/>x-telegram-bot-api-secret-token"]
        GW_NORMALIZE["Normalize Message<br/>DM text only (v1)"]
        GW_ROUTE["Route Resolver<br/>conversation_id → actor_id → default"]
        GW_FORWARD["Runtime Client<br/>POST /channels/inbound"]
        GW_REPLY["Send Reply<br/>Telegram sendMessage"]
        GW_ATTACH["Send Attachments<br/>sendPhoto / sendDocument"]
        GW_TG_DELIVER["Telegram Deliver<br/>/deliver/telegram<br/>(internal, from runtime)"]
        GW_TWILIO_VOICE["Twilio Voice Webhook<br/>/webhooks/twilio/voice"]
        GW_TWILIO_STATUS["Twilio Status Webhook<br/>/webhooks/twilio/status"]
        GW_TWILIO_CONNECT["Twilio Connect-Action<br/>/webhooks/twilio/connect-action"]
        GW_TWILIO_RELAY["Twilio Relay WS<br/>/webhooks/twilio/relay<br/>(bidirectional proxy)"]
        GW_SMS_WEBHOOK["Twilio SMS Webhook<br/>/webhooks/twilio/sms<br/>(HMAC-SHA1 validated)"]
        GW_SMS_DELIVER["SMS Deliver<br/>/deliver/sms<br/>(internal, from runtime)"]
        GW_WA_WEBHOOK["WhatsApp Webhook<br/>/webhooks/whatsapp<br/>(HMAC-SHA256 validated)"]
        GW_WA_DELIVER["WhatsApp Deliver<br/>/deliver/whatsapp<br/>(internal, from runtime)"]
        GW_SLACK_SOCKET["Slack Socket Mode<br/>WebSocket via<br/>apps.connections.open"]
        GW_SLACK_NORMALIZE["Slack Normalize<br/>app_mention events<br/>+ bot-mention stripping"]
        GW_SLACK_DELIVER["Slack Deliver<br/>/deliver/slack<br/>(internal, from runtime)"]
        GW_OAUTH["OAuth Callback<br/>/webhooks/oauth/callback"]
        GW_PROXY["Runtime Proxy<br/>(optional, bearer auth)"]
        GW_FEATURE_FLAGS["Feature Flags API<br/>GET /v1/feature-flags<br/>PATCH /v1/feature-flags/:key"]
        GW_PROBES["/healthz + /readyz<br/>k8s liveness/readiness"]
    end

    subgraph "Web Server (Next.js + React)"
        WEB_UI["Web Dashboard<br/>React 19"]
        WEB_API["API Routes"]

        subgraph "PostgreSQL (Drizzle ORM)"
            PG_ASST["assistants"]
            PG_CHAN["assistant_channel_accounts"]
            PG_CONTACT["assistant_channel_contacts"]
            PG_USER["user / session / account"]
            PG_TOKENS["assistant tokens (OAuth)"]
            PG_APIKEYS["api_keys"]
        end

        LOCAL_IPC["LocalDaemonClient<br/>Unix socket proxy"]
        RUNTIME_CLIENT["RuntimeClient<br/>HTTP proxy"]
    end

    subgraph "macOS Local Storage"
        ENC_STORE["Encrypted Store<br/>(~/.vellum/protected/keys.enc)"]
        USERDEFAULTS["UserDefaults<br/>preferences / state"]
        APP_SUPPORT["~/Library/App Support/<br/>vellum-assistant/"]
        APPS_DATA["~/.vellum/workspace/data/apps/<br/>app JSON + pages"]
        SESSION_LOGS["logs/session-*.json"]
    end

    %% User input flows
    TI -->|"task_submit<br/>(source='text')"| CLS
    VOICE -->|"task_submit<br/>(source='voice')"| TEXT_SESS
    ATTACH -->|"validated files"| TI
    CLS -->|"computerUse"| PERCEIVE
    CLS -->|"textQA"| TEXT_SESS

    %% Text Q&A → CU escalation
    TEXT_SESS -.->|"computer_use_request_control<br/>(explicit user request)"| PERCEIVE

    %% Computer Use loop
    PERCEIVE -->|"CuObservationMessage"| IPC_SERVER
    IPC_SERVER -->|"CuActionMessage"| VERIFY
    VERIFY -->|"allowed"| EXECUTE
    VERIFY -->|"needsConfirmation"| UI
    UI -->|"approved"| EXECUTE
    VERIFY -->|"blocked"| PERCEIVE
    EXECUTE --> WAIT
    WAIT --> PERCEIVE

    %% Text Q&A flow
    TEXT_SESS -->|"SessionCreate +<br/>UserMessage"| IPC_SERVER
    IPC_SERVER -->|"AssistantTextDelta<br/>stream"| TEXT_WIN

    %% Main Window Chat flow
    CHAT_VM -->|"session_create +<br/>user_message +<br/>cancel"| IPC_SERVER
    IPC_SERVER -->|"session_info +<br/>session_title_updated +<br/>text deltas +<br/>message_complete +<br/>session_error +<br/>message_queued +<br/>message_dequeued +<br/>generation_handoff"| CHAT_VM
    CHAT_VIEW --> CHAT_VM
    MW_STATE -->|"home_base_get + app_open_request<br/>(dashboard-first bootstrap)"| IPC_SERVER

    %% Ride Shotgun flow
    RS_TRIGGER -->|"shouldShowInvitation"| AMBIENT
    AMBIENT -->|"show"| RS_INVITE
    RS_INVITE -->|"accepted"| RS_SESSION
    RS_SESSION --> WATCH
    WATCH --> AX_CAP
    WATCH -.->|"fallback"| OCR_CAP
    RS_SESSION -->|"observations via<br/>daemon IPC"| IPC_SERVER
    RS_SESSION -->|"progress"| RS_PROGRESS
    RS_SESSION -->|"summary"| RS_SUMMARY

    %% Dynamic Workspace flow
    IPC_SERVER -->|"ui_surface_show"| SURFACE_MGR
    SURFACE_MGR -->|"display != inline<br/>.openDynamicWorkspace"| WORKSPACE
    WORKSPACE --> DYN_PAGE
    DYN_PAGE -->|"vellumBridge<br/>actions + data RPC"| IPC_SERVER

    %% Daemon internals
    IPC_SERVER --> HANDLERS
    HANDLERS --> SESSION_MGR
    SESSION_MGR --> ANTHROPIC
    SESSION_MGR --> OPENAI
    SESSION_MGR --> GEMINI
    SESSION_MGR --> OLLAMA
    SESSION_MGR --> CONV_STORE
    SESSION_MGR --> PROFILE_COMPILER
    HANDLERS -->|"session_create.transport"| PLAYBOOK_MGR
    PLAYBOOK_MGR --> PLAYBOOK_REG
    PLAYBOOK_MGR -->|"inject <channel_onboarding_playbook><br/>runtime context"| SESSION_MGR
    PLAYBOOK_MGR --> ONBOARD_ORCH
    ONBOARD_ORCH -->|"inject <onboarding_mode><br/>runtime context"| SESSION_MGR
    IPC_SERVER -.->|"daemon startup bootstrap + home_base_get"| HOME_BASE_BOOT
    HOME_BASE_BOOT --> HOME_BASE_SEED
    HOME_BASE_BOOT --> HOME_BASE_LINK
    HOME_BASE_LINK --> DB_HOME
    HOME_BASE_SEED --> APPS_DATA
    CONV_STORE --> DB_CONV
    CONV_STORE --> DB_MSG
    CONV_STORE --> DB_TOOL
    CONV_STORE --> DB_ATTACH
    PROFILE_COMPILER --> DB_ITEMS
    INDEXER --> DB_SEG
    INDEXER --> DB_FTS
    INDEXER --> DB_ITEMS
    INDEXER --> DB_SRC
    INDEXER --> DB_JOBS
    JOBS_WORKER --> DB_JOBS
    JOBS_WORKER --> DB_EMB
    JOBS_WORKER --> DB_ENT
    JOBS_WORKER --> DB_REL
    JOBS_WORKER --> DB_ITEM_ENT
    JOBS_WORKER --> DB_SUM
    RECALL --> DB_FTS
    RECALL --> DB_EMB

    %% Gateway flow — Telegram path
    GW_WEBHOOK --> GW_VERIFY
    GW_VERIFY --> GW_NORMALIZE
    GW_NORMALIZE --> GW_ROUTE
    GW_ROUTE --> GW_FORWARD
    GW_FORWARD -->|"HTTP + replyCallbackUrl"| HTTP_SERVER
    HTTP_SERVER -->|"channels/inbound transport<br/>channelId + hints + uxBrief"| PLAYBOOK_MGR
    GW_REPLY -->|"Telegram API"| GW_WEBHOOK
    GW_ATTACH -->|"download from runtime<br/>+ upload to Telegram"| GW_WEBHOOK

    %% Gateway flow — Telegram deliver (runtime → gateway → Telegram)
    %% replyCallbackUrl is built from gatewayInternalBaseUrl (GATEWAY_INTERNAL_BASE_URL env var)
    HTTP_SERVER -->|"POST /deliver/telegram<br/>(via gatewayInternalBaseUrl)"| GW_TG_DELIVER
    GW_TG_DELIVER --> GW_REPLY
    GW_TG_DELIVER --> GW_ATTACH

    %% Gateway flow — Twilio voice webhooks
    GW_TWILIO_VOICE -->|"HTTP"| HTTP_SERVER
    GW_TWILIO_STATUS -->|"HTTP"| HTTP_SERVER
    GW_TWILIO_CONNECT -->|"HTTP"| HTTP_SERVER
    GW_TWILIO_RELAY -->|"WebSocket proxy"| HTTP_SERVER

    %% Gateway flow — SMS channel (Twilio SMS webhook → gateway → runtime → gateway → Twilio Messages API)
    GW_SMS_WEBHOOK -->|"normalize + MessageSid dedup<br/>+ route resolver"| GW_FORWARD
    HTTP_SERVER -->|"POST /deliver/sms<br/>(via gatewayInternalBaseUrl)"| GW_SMS_DELIVER
    GW_SMS_DELIVER -->|"Twilio Messages API<br/>(text-only, no MMS in v1)"| GW_SMS_WEBHOOK

    %% Gateway flow — WhatsApp channel (Meta Cloud API)
    GW_WA_WEBHOOK -->|"HMAC-SHA256 verify<br/>+ normalize + dedup<br/>+ route resolver"| GW_FORWARD
    HTTP_SERVER -->|"POST /deliver/whatsapp<br/>(via gatewayInternalBaseUrl)"| GW_WA_DELIVER
    GW_WA_DELIVER -->|"Meta Cloud API<br/>/{phoneNumberId}/messages"| GW_WA_WEBHOOK

    %% Gateway flow — Slack channel (Socket Mode WebSocket)
    GW_SLACK_SOCKET -->|"app_mention events<br/>ACK + dedup"| GW_SLACK_NORMALIZE
    GW_SLACK_NORMALIZE -->|"normalize + route resolver"| GW_FORWARD
    HTTP_SERVER -->|"POST /deliver/slack<br/>(via gatewayInternalBaseUrl)"| GW_SLACK_DELIVER
    GW_SLACK_DELIVER -->|"Slack API<br/>chat.postMessage"| GW_SLACK_SOCKET

    %% Gateway flow — OAuth callback
    GW_OAUTH -->|"forward code + state"| HTTP_SERVER

    %% Gateway flow — Runtime proxy path (optional)
    GW_PROXY -->|"HTTP (forwarded)"| HTTP_SERVER

    %% Web server
    WEB_API -->|"local mode"| LOCAL_IPC
    LOCAL_IPC -->|"Unix socket"| IPC_SERVER
    WEB_API -->|"cloud mode"| RUNTIME_CLIENT
    RUNTIME_CLIENT -->|"HTTP"| HTTP_SERVER

    %% Swarm data flow
    SESSION_MGR -->|"swarm_delegate<br/>tool_use"| SWARM_TOOL
    SWARM_TOOL --> ROUTER_PLAN
    ROUTER_PLAN --> DAG_SCHED
    DAG_SCHED --> WORKER_POOL
    WORKER_POOL --> ANTHROPIC
    DAG_SCHED --> SYNTH
    SYNTH --> ANTHROPIC

    %% Tracing data flow
    SESSION_MGR --> TRACE_EMITTER
    EVENT_BUS --> TOOL_TRACE
    TOOL_TRACE --> TRACE_EMITTER
    TRACE_EMITTER -->|"trace_event"| IPC_SERVER
    IPC_SERVER -->|"trace_event"| TRACE_STORE
    TRACE_STORE --> DEBUG_PANEL

    %% Integration data flow
    HANDLERS -->|"integration_connect"| INT_REGISTRY
    INT_REGISTRY --> INT_OAUTH
    INT_OAUTH -->|"open_url"| IPC_SERVER
    INT_OAUTH -->|"store tokens"| ENC_STORE
    GMAIL_TOOLS --> INT_TOKEN
    INT_TOKEN -->|"auto-refresh"| ENC_STORE
    INT_TOKEN --> GMAIL_CLIENT

    %% Skill tool data flow
    SESSION_MGR -->|"per-turn resolveTools"| SKILL_PROJECTION
    SKILL_PROJECTION --> SKILL_DERIVE
    SKILL_DERIVE -->|"&lt;loaded_skill id=...&gt;<br/>markers in history"| SKILL_CATALOG
    SKILL_PROJECTION --> SKILL_CATALOG
    SKILL_CATALOG --> SKILL_MANIFEST
    SKILL_MANIFEST --> SKILL_FACTORY
    SKILL_FACTORY -->|"register/unregister"| HANDLERS
    SKILL_FACTORY -->|"host tools"| SKILL_HOST_RUNNER
    SKILL_FACTORY -->|"sandbox tools"| SKILL_SANDBOX_RUNNER

    %% Script proxy data flow
    SESSION_MGR -->|"proxied bash<br/>network_mode"| PROXY_SESSION
    PROXY_SESSION --> PROXY_SERVER
    PROXY_SERVER --> PROXY_ROUTER
    PROXY_ROUTER -->|"mitm: credential_injection"| PROXY_MITM
    PROXY_MITM --> PROXY_CERTS
    PROXY_SERVER --> PROXY_POLICY
    PROXY_POLICY -->|"ask_*"| PROXY_APPROVAL
    PROXY_APPROVAL --> HANDLERS

    %% Asset tools data flow
    SESSION_MGR -->|"tool_use"| ASSET_SEARCH
    SESSION_MGR -->|"tool_use"| ASSET_MATERIALIZE
    ASSET_SEARCH --> DB_ATTACH
    ASSET_SEARCH --> VISIBILITY_POLICY
    ASSET_MATERIALIZE --> DB_ATTACH
    ASSET_MATERIALIZE --> VISIBILITY_POLICY

    %% Local storage
    APP_SUPPORT --- SESSION_LOGS

    classDef swift fill:#f9a825,stroke:#f57f17,color:#000
    classDef daemon fill:#42a5f5,stroke:#1565c0,color:#000
    classDef db fill:#66bb6a,stroke:#2e7d32,color:#000
    classDef web fill:#ab47bc,stroke:#6a1b9a,color:#fff
    classDef storage fill:#78909c,stroke:#37474f,color:#fff
    classDef provider fill:#ef5350,stroke:#c62828,color:#fff
```

## Assistant Feature Flags

All feature flags (assistant-scoped and macOS-scoped) are declared in the unified registry at `meta/feature-flags/feature-flag-registry.json`. Each entry has `id`, `scope`, `key`, `label`, `description`, and `defaultEnabled`. Flags are scoped: `assistant` flags gate daemon behavior via the gateway API, while `macos` flags control client-side UI behavior stored in UserDefaults.

**Separation of concerns:**

| Flag Type | Scope | Storage | Managed By |
|-----------|-------|---------|------------|
| Assistant feature flags (`scope: "assistant"`) | Gateway-managed, workspace config | `~/.vellum/workspace/config.json` under `assistantFeatureFlagValues` | Gateway `/v1/feature-flags` API |
| macOS client feature flags (`scope: "macos"`) | Local-only, per-device | UserDefaults (plist) | macOS app directly |

**Unified registry:** The canonical source is `meta/feature-flags/feature-flag-registry.json`. Bundled copies are maintained at `assistant/src/config/feature-flag-registry.json` and `gateway/src/feature-flag-registry.json`. Labels come from the registry. Flags not declared in the registry default to enabled (open by default).

**Canonical key format:** `feature_flags.<flag_id>.enabled` (e.g., `feature_flags.browser.enabled`). The legacy `skills.<id>.enabled` format is no longer supported.

**Resolution priority:** When determining whether an assistant flag is enabled, the resolver checks (highest priority first):
1. `config.assistantFeatureFlagValues[key]` (canonical config section)
2. Defaults registry `defaultEnabled`
3. `true` (unknown flags are open by default)

**Domain docs:**
- Assistant-side resolver and enforcement points: [`assistant/ARCHITECTURE.md`](assistant/ARCHITECTURE.md)
- Gateway defaults loader and REST API: [`gateway/ARCHITECTURE.md`](gateway/ARCHITECTURE.md)

## Maintenance Rule

When architecture changes, update the relevant domain architecture document(s) above and keep this index aligned.
