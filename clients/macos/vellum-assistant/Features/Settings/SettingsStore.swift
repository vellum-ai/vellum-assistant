import AppKit
import AuthenticationServices
import Carbon.HIToolbox
import Combine
import Foundation
import os
import VellumAssistantShared

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "SettingsStore")

/// UserDefaults key for tracking explicit key deletions that may not have reached the daemon.
private let kPendingKeyDeletionTombstones = "pendingKeyDeletionTombstones"

/// Single source of truth for settings state shared between `SettingsPanel`
/// (main window side panel) and its extracted tab views.
@MainActor
public final class SettingsStore: ObservableObject {
    // MARK: - Navigation

    /// Set externally (e.g. via HTTP) to deep-link into a specific settings tab.
    /// SettingsPanel observes this and clears it after applying.
    @Published var pendingSettingsTab: SettingsTab?

    // MARK: - API Key State

    @Published var hasKey: Bool
    @Published var hasBraveKey: Bool
    @Published var hasPerplexityKey: Bool
    @Published var hasImageGenKey: Bool
    @Published var hasElevenLabsKey: Bool
    @Published var hasVercelKey: Bool = false
    @Published var maskedKey: String = ""
    @Published var apiKeySaveError: String?
    @Published var apiKeySaving: Bool = false
    @Published var braveKeySaveError: String?
    @Published var perplexityKeySaveError: String?
    @Published var imageGenKeySaveError: String?
    @Published var maskedBraveKey: String = ""
    @Published var maskedPerplexityKey: String = ""
    @Published var maskedImageGenKey: String = ""
    @Published var maskedElevenLabsKey: String = ""

    // MARK: - Model Selection

    @Published var selectedModel: String = "claude-opus-4-6"
    @Published var configuredProviders: Set<String> = ["ollama"]
    @Published var selectedImageGenModel: String = "gemini-3.1-flash-image-preview"

    static let availableModels: [String] = [
        "claude-opus-4-6",
        "claude-sonnet-4-6",
        "claude-haiku-4-5-20251001",
    ]

    static let modelDisplayNames: [String: String] = [
        "claude-opus-4-6": "Claude Opus 4.6",
        "claude-sonnet-4-6": "Claude Sonnet 4.6",
        "claude-haiku-4-5-20251001": "Claude Haiku 4.5",
    ]

    // MARK: - Inference Provider Selection

    @Published var selectedInferenceProvider: String = "anthropic"
    @Published var inferenceAvailableModels: [CatalogModel] = []

    static let inferenceProviders: [String] = [
        "anthropic", "openai", "gemini", "ollama", "fireworks", "openrouter",
    ]
    static let inferenceProviderDisplayNames: [String: String] = [
        "anthropic": "Anthropic",
        "openai": "OpenAI",
        "gemini": "Google Gemini",
        "ollama": "Ollama",
        "fireworks": "Fireworks",
        "openrouter": "OpenRouter",
    ]
    /// Client-side model catalog for immediate UI updates on provider change.
    /// Mirrors PROVIDER_MODEL_CATALOG on the daemon.
    static let inferenceProviderModels: [String: [(id: String, displayName: String)]] = [
        "anthropic": [
            ("claude-opus-4-6", "Claude Opus 4.6"),
            ("claude-sonnet-4-6", "Claude Sonnet 4.6"),
            ("claude-haiku-4-5-20251001", "Claude Haiku 4.5"),
        ],
        "openai": [
            ("gpt-5.2", "GPT-5.2"),
            ("gpt-5.4", "GPT-5.4"),
            ("gpt-5.4-nano", "GPT-5.4 Nano"),
        ],
        "gemini": [
            ("gemini-3-flash", "Gemini 3 Flash"),
            ("gemini-3-pro", "Gemini 3 Pro"),
        ],
        "ollama": [
            ("llama3.2", "Llama 3.2"),
            ("mistral", "Mistral"),
        ],
        "fireworks": [
            ("accounts/fireworks/models/kimi-k2p5", "Kimi K2.5"),
        ],
        "openrouter": [
            ("x-ai/grok-4", "Grok 4"),
            ("x-ai/grok-4.20-beta", "Grok 4.20 Beta"),
        ],
    ]
    /// Default model per provider (first entry from the catalog).
    static let inferenceProviderDefaultModel: [String: String] = [
        "anthropic": "claude-opus-4-6",
        "openai": "gpt-5.2",
        "gemini": "gemini-3-flash",
        "ollama": "llama3.2",
        "fireworks": "accounts/fireworks/models/kimi-k2p5",
        "openrouter": "x-ai/grok-4",
    ]

    static let availableImageGenModels: [String] = [
        "gemini-3.1-flash-image-preview",
        "gemini-3-pro-image-preview",
    ]

    static let imageGenModelDisplayNames: [String: String] = [
        "gemini-3.1-flash-image-preview": "Nano Banana 2",
        "gemini-3-pro-image-preview": "Nano Banana Pro",
    ]

    // MARK: - Settings Values

    @Published var globalHotkeyShortcut: String
    @Published var quickInputHotkeyShortcut: String
    @Published var quickInputHotkeyKeyCode: Int
    @Published var cmdEnterToSend: Bool

    // MARK: - Media Embed Settings

    @Published var mediaEmbedsEnabled: Bool
    @Published var mediaEmbedsEnabledSince: Date?
    @Published var mediaEmbedVideoAllowlistDomains: [String]
    @Published var userTimezone: String?

    // MARK: - Telegram Integration State

    @Published var telegramHasBotToken: Bool = false
    @Published var telegramBotId: String?
    @Published var telegramBotUsername: String?
    @Published var telegramConnected: Bool = false
    @Published var telegramHasWebhookSecret: Bool = false
    @Published var telegramSaveInProgress: Bool = false
    @Published var telegramError: String?

    // MARK: - Twilio Integration State

    @Published var twilioHasCredentials: Bool = false
    @Published var twilioPhoneNumber: String?
    @Published var twilioNumbers: [TwilioNumberInfo] = []
    @Published var twilioSaveInProgress: Bool = false
    @Published var twilioListInProgress: Bool = false
    @Published var twilioWarning: String?
    @Published var twilioError: String?

    // MARK: - Channel Verification State (Telegram)

    @Published var telegramVerificationIdentity: String?
    @Published var telegramVerificationUsername: String?
    @Published var telegramVerificationDisplayName: String?
    @Published var telegramVerificationVerified: Bool = false
    @Published var telegramVerificationInProgress: Bool = false
    @Published var telegramVerificationInstruction: String?
    @Published var telegramVerificationError: String?
    @Published var telegramVerificationAlreadyBound: Bool = false

    // MARK: - Channel Verification State (Voice)

    @Published var voiceVerificationIdentity: String?
    @Published var voiceVerificationUsername: String?
    @Published var voiceVerificationDisplayName: String?
    @Published var voiceVerificationVerified: Bool = false
    @Published var voiceVerificationInProgress: Bool = false
    @Published var voiceVerificationInstruction: String?
    @Published var voiceVerificationError: String?
    @Published var voiceVerificationAlreadyBound: Bool = false

    // MARK: - Outbound Verification Session State (Telegram)

    @Published var telegramOutboundSessionId: String?
    @Published var telegramOutboundExpiresAt: Date?
    @Published var telegramOutboundNextResendAt: Date?
    @Published var telegramOutboundSendCount: Int = 0
    @Published var telegramBootstrapUrl: String?
    @Published var telegramOutboundCode: String?

    // MARK: - Outbound Verification Session State (Voice)

    @Published var voiceOutboundSessionId: String?
    @Published var voiceOutboundExpiresAt: Date?
    @Published var voiceOutboundNextResendAt: Date?
    @Published var voiceOutboundSendCount: Int = 0
    @Published var voiceOutboundCode: String?

    // MARK: - Slack Channel Integration State

    @Published var slackChannelHasBotToken: Bool = false
    @Published var slackChannelHasAppToken: Bool = false
    @Published var slackChannelConnected: Bool = false
    @Published var slackChannelBotUsername: String?
    @Published var slackChannelBotUserId: String?
    @Published var slackChannelTeamId: String?
    @Published var slackChannelTeamName: String?
    @Published var slackChannelSaveInProgress: Bool = false
    @Published var slackChannelError: String?

    // MARK: - Channel Verification State (Slack)

    @Published var slackVerificationIdentity: String?
    @Published var slackVerificationUsername: String?
    @Published var slackVerificationDisplayName: String?
    @Published var slackVerificationVerified: Bool = false
    @Published var slackVerificationInProgress: Bool = false
    @Published var slackVerificationInstruction: String?
    @Published var slackVerificationError: String?
    @Published var slackVerificationAlreadyBound: Bool = false

    // MARK: - Outbound Verification Session State (Slack)

    @Published var slackOutboundSessionId: String?
    @Published var slackOutboundExpiresAt: Date?
    @Published var slackOutboundNextResendAt: Date?
    @Published var slackOutboundSendCount: Int = 0
    @Published var slackOutboundCode: String?

    // MARK: - Email Integration State

    @Published var assistantEmail: String?

    // MARK: - Channel Setup Status

    /// Per-channel setup status populated from the readiness API.
    /// Values: "not_configured", "incomplete", "ready".
    @Published var channelSetupStatus: [String: String] = [:]

    // MARK: - Provider Routing Sources

    /// Per-provider routing source from the daemon debug endpoint.
    /// Values: `"user-key"`, `"managed-proxy"`, or absent.
    @Published var providerRoutingSources: [String: String] = [:]

    /// Current inference mode from the daemon debug endpoint.
    /// Values: `"managed"` or `"your-own"`.
    @Published var inferenceMode: String = "your-own"

    /// Current image generation mode. Values: "managed" or "your-own".
    @Published var imageGenMode: String = "your-own"

    /// The selected web search provider, persisted in workspace config under
    /// `services.web-search.provider`.
    @Published var webSearchProvider: String = "inference-provider-native"

    /// Current web search mode. Values: "managed" or "your-own".
    @Published var webSearchMode: String = "your-own"

    /// Current Google OAuth mode. Values: "managed" or "your-own".
    @Published var googleOAuthMode: String = "your-own"
    @Published var googleOAuthConnections: [OAuthConnectionEntry] = []
    @Published var googleOAuthIsConnecting: Bool = false
    @Published var googleOAuthError: String? = nil

    static let availableWebSearchProviders = ["inference-provider-native", "perplexity", "brave"]

    static let webSearchProviderDisplayNames: [String: String] = [
        "inference-provider-native": "Provider Native",
        "perplexity": "Perplexity",
        "brave": "Brave",
    ]

    // MARK: - Platform Config State

    @Published var platformBaseUrl: String = ""
    private var pendingPlatformUrl: String?

    // MARK: - Ingress Config State

    @Published var ingressEnabled: Bool = false
    @Published var ingressPublicBaseUrl: String = ""
    /// Read-only gateway target derived from daemon config.
    /// Initial value reads env var > lockfile runtimeUrl > default 7830; updated by HTTP.
    @Published var localGatewayTarget: String = LockfilePaths.resolveGatewayUrl(
        connectedAssistantId: UserDefaults.standard.string(forKey: "connectedAssistantId")
    )

    /// Set to `true` once the first ingress config response arrives, so the
    /// view layer can defer diagnostics until the real config values are available.
    @Published var ingressConfigLoaded: Bool = false

    // MARK: - Connection Health Check State

    @Published var gatewayReachable: Bool?
    @Published var ingressReachable: Bool?
    @Published var gatewayLastChecked: Date?
    @Published var isCheckingGateway: Bool = false
    @Published var isCheckingTunnel: Bool = false
    @Published var tunnelLastChecked: Date?

    // MARK: - Trust Rules Coordination

    /// Whether any settings surface currently has a trust rules sheet open.
    /// Sourced from `DaemonClient.isTrustRulesSheetOpen` so each view can
    /// disable its button when the other surface is showing trust rules.
    @Published var isAnyTrustRulesSheetOpen = false

    // MARK: - Privacy

    /// Whether the user has opted in to sending crash reports, error diagnostics, and
    /// performance metrics. Defaults to `true`. Controls Sentry independently from usage analytics.
    @Published var sendDiagnostics: Bool = UserDefaults.standard.object(forKey: "sendDiagnostics") as? Bool
        ?? UserDefaults.standard.object(forKey: "collectUsageData") as? Bool
        ?? true

    /// Whether the user has opted in to sharing anonymized usage analytics (e.g. token counts,
    /// feature adoption). Defaults to `true`. Independent from diagnostics.
    @Published var collectUsageData: Bool = UserDefaults.standard.object(forKey: "collectUsageData") as? Bool
        ?? true

    // MARK: - Private

    private weak var daemonClient: DaemonClient?
    private let channelClient: ChannelClientProtocol
    private let integrationClient: IntegrationClientProtocol
    private let settingsClient: SettingsClientProtocol
    private let pairingClient: PairingClientProtocol
    private var cancellables = Set<AnyCancellable>()
    private let configPath: String?

    /// Whether the connected assistant is remote (not running locally).
    /// When true, local workspace config writes are skipped to avoid creating
    /// a `.vellum/` directory that doesn't belong to any local assistant.
    private var isCurrentAssistantRemote: Bool {
        UserDefaults.standard.string(forKey: "connectedAssistantId")
            .flatMap { LockfileAssistant.loadByName($0) }?.isRemote ?? false
    }

    /// Guards against stale `get` responses overwriting an optimistic
    /// toggle. Set when `setIngressEnabled` fires; cleared once a matching
    /// response arrives.
    private var pendingIngressEnabled: Bool?
    private var pendingIngressUrl: String?
    private var routingSourceRefreshTask: Task<Void, Never>?

    /// Last model reported by the daemon — used to skip redundant model_set calls
    /// that would otherwise reinitialize providers and evict idle conversations.
    private var lastDaemonModel: String?
    private var lastDaemonProvider: String?
    private var pendingVerificationSessionChannel: String?
    private var verificationSessionTimeoutWorkItem: DispatchWorkItem?
    private var verificationStatusPollingWorkItems: [String: DispatchWorkItem] = [:]
    private var verificationStatusPollingDeadlines: [String: Date] = [:]
    private let verificationSessionTimeoutDuration: TimeInterval
    private let verificationStatusPollInterval: TimeInterval
    private let verificationStatusPollWindow: TimeInterval
    private static func reflectedString(_ value: Any, key: String) -> String? {
        for child in Mirror(reflecting: value).children {
            guard child.label == key else { continue }
            return child.value as? String
        }
        return nil
    }

    private static let allKnownTimeZoneIdentifiersByLowercase: [String: String] = {
        Dictionary(uniqueKeysWithValues: TimeZone.knownTimeZoneIdentifiers.map { ($0.lowercased(), $0) })
    }()

    private static func canonicalizeTimeZoneIdentifier(_ raw: String) -> String? {
        allKnownTimeZoneIdentifiersByLowercase[raw.lowercased()]
    }

    init(
        daemonClient: DaemonClient? = nil,
        channelClient: ChannelClientProtocol = ChannelClient(),
        integrationClient: IntegrationClientProtocol = IntegrationClient(),
        settingsClient: SettingsClientProtocol = SettingsClient(),
        pairingClient: PairingClientProtocol = PairingClient(),
        configPath: String? = nil,
        verificationSessionTimeoutDuration: TimeInterval = 12,
        verificationStatusPollInterval: TimeInterval = 2,
        verificationStatusPollWindow: TimeInterval = 600
    ) {
        self.daemonClient = daemonClient
        self.channelClient = channelClient
        self.integrationClient = integrationClient
        self.settingsClient = settingsClient
        self.pairingClient = pairingClient
        self.configPath = configPath
        self.verificationSessionTimeoutDuration = max(0.05, verificationSessionTimeoutDuration)
        self.verificationStatusPollInterval = max(0.05, verificationStatusPollInterval)
        self.verificationStatusPollWindow = max(self.verificationStatusPollInterval, verificationStatusPollWindow)

        // Seed from UserDefaults / Keychain
        let anthropicKey = APIKeyManager.getKey(for: "anthropic")
        self.hasKey = anthropicKey != nil
        self.maskedKey = Self.maskKey(anthropicKey)
        let braveKey = APIKeyManager.getKey(for: "brave")
        self.hasBraveKey = braveKey != nil
        self.maskedBraveKey = Self.maskKey(braveKey)
        let perplexityKey = APIKeyManager.getKey(for: "perplexity")
        self.hasPerplexityKey = perplexityKey != nil
        self.maskedPerplexityKey = Self.maskKey(perplexityKey)
        let imageGenKey = APIKeyManager.getKey(for: "gemini")
        self.hasImageGenKey = imageGenKey != nil
        self.maskedImageGenKey = Self.maskKey(imageGenKey)
        let elevenLabsKey = APIKeyManager.getKey(for: "elevenlabs")
        self.hasElevenLabsKey = elevenLabsKey != nil
        self.maskedElevenLabsKey = Self.maskKey(elevenLabsKey)
        // selectedImageGenModel is initialized with a hardcoded default and
        // populated from the daemon's workspace config via loadServiceModes().

        self.cmdEnterToSend = UserDefaults.standard.object(forKey: "cmdEnterToSend") as? Bool ?? false

        if UserDefaults.standard.object(forKey: "globalHotkeyShortcut") == nil {
            self.globalHotkeyShortcut = "cmd+shift+g"
        } else {
            self.globalHotkeyShortcut = UserDefaults.standard.string(forKey: "globalHotkeyShortcut") ?? ""
        }
        if UserDefaults.standard.object(forKey: "quickInputHotkeyShortcut") == nil {
            self.quickInputHotkeyShortcut = "cmd+shift+/"
        } else {
            self.quickInputHotkeyShortcut = UserDefaults.standard.string(forKey: "quickInputHotkeyShortcut") ?? ""
        }
        let storedQIKeyCode = UserDefaults.standard.object(forKey: "quickInputHotkeyKeyCode") as? Int
        self.quickInputHotkeyKeyCode = storedQIKeyCode ?? kVK_ANSI_Slash

        // Load media embed settings from workspace config
        let mediaSettings = Self.loadMediaEmbedSettings(from: configPath)
        self.mediaEmbedsEnabled = mediaSettings.enabled
        self.mediaEmbedsEnabledSince = mediaSettings.enabledSince
        self.mediaEmbedVideoAllowlistDomains = mediaSettings.domains
        self.userTimezone = Self.loadUserTimezone(from: configPath)

        // Load web search provider from workspace config
        let config = WorkspaceConfigIO.read(from: configPath)
        if let services = config["services"] as? [String: Any],
           let webSearch = services["web-search"] as? [String: Any],
           let provider = webSearch["provider"] as? String {
            self.webSearchProvider = provider
        }

        // Load service modes (inference, image-generation) from workspace config
        loadServiceModes()

        // When enabledSince was defaulted to "now" (no value on disk),
        // persist it immediately so subsequent loads produce the same
        // deterministic timestamp instead of advancing each time.
        // Skip for remote assistants to avoid creating a local .vellum/ directory.
        if mediaSettings.didDefaultEnabledSince && !isCurrentAssistantRemote {
            persistMediaEmbedState()
        }

        // React to Keychain changes from other surfaces
        NotificationCenter.default.publisher(for: .apiKeyManagerDidChange)
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in self?.refreshAPIKeyState() }
            .store(in: &cancellables)

        // Re-sync all API keys and refresh remote state when the daemon reconnects.
        // This also covers the first-launch case where SettingsStore is initialized
        // before onboarding sets connectedAssistantId.
        NotificationCenter.default.publisher(for: .daemonDidReconnect)
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in
                self?.syncAllKeysToDaemon()
                self?.refreshVercelKeyState()
                self?.refreshModelInfo()
                self?.refreshTelegramStatus()
                self?.refreshTwilioStatus()
                self?.refreshChannelVerificationStatus(channel: "telegram")
                self?.refreshChannelVerificationStatus(channel: "phone")
                self?.refreshChannelVerificationStatus(channel: "slack")
                self?.loadProviderRoutingSources()
            }
            .store(in: &cancellables)

        // Refresh routing sources when local assistant bootstrap completes
        // (e.g. after sign-in provisions an API key into the daemon)
        NotificationCenter.default.publisher(for: .localBootstrapCompleted)
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in
                self?.loadProviderRoutingSources()
            }
            .store(in: &cancellables)

        // Debounce UserDefaults writes so rapid toggle changes don't thrash disk I/O.
        // dropFirst must come before debounce: it consumes the synchronous initial emission so that
        // only genuine user-driven changes flow into debounce and are eventually persisted.
        // Placing dropFirst after debounce would cause the first real user change to be silently
        // dropped whenever it arrives within the 300ms debounce window of the initial value.
        $cmdEnterToSend
            .dropFirst()
            .debounce(for: .milliseconds(300), scheduler: RunLoop.main)
            .sink { value in UserDefaults.standard.set(value, forKey: "cmdEnterToSend") }
            .store(in: &cancellables)

        $sendDiagnostics
            .dropFirst()
            .debounce(for: .milliseconds(300), scheduler: RunLoop.main)
            .sink {
                UserDefaults.standard.set($0, forKey: "sendDiagnostics")
                if $0 {
                    MetricKitManager.startSentry()
                } else {
                    MetricKitManager.closeSentry()
                }
            }
            .store(in: &cancellables)

        $collectUsageData
            .dropFirst()
            .debounce(for: .milliseconds(300), scheduler: RunLoop.main)
            .sink { value in UserDefaults.standard.set(value, forKey: "collectUsageData") }
            .store(in: &cancellables)

        // Persist shortcut changes immediately so the hotkey re-registers without delay
        $globalHotkeyShortcut
            .dropFirst()
            .sink { value in UserDefaults.standard.set(value, forKey: "globalHotkeyShortcut") }
            .store(in: &cancellables)

        $quickInputHotkeyShortcut
            .dropFirst()
            .sink { value in UserDefaults.standard.set(value, forKey: "quickInputHotkeyShortcut") }
            .store(in: &cancellables)

        $quickInputHotkeyKeyCode
            .dropFirst()
            .sink { value in UserDefaults.standard.set(value, forKey: "quickInputHotkeyKeyCode") }
            .store(in: &cancellables)

        // Mirror DaemonClient's trust-rules-open flag so views can disable their buttons
        daemonClient?.$isTrustRulesSheetOpen
            .receive(on: RunLoop.main)
            .assign(to: &$isAnyTrustRulesSheetOpen)

        // Wire up Vercel API config response
        daemonClient?.onVercelApiConfigResponse = { [weak self] response in
            guard let self else { return }
            self.applyVercelConfigResponse(response)
        }

        // Subscribe to daemon-pushed model changes so the UI stays in sync
        // when the model is changed externally (e.g. via CLI or another client).
        daemonClient?.$latestModelInfo
            .compactMap { $0 }
            .receive(on: RunLoop.main)
            .sink { [weak self] info in
                guard let self else { return }
                self.applyModelInfoResponse(info)
            }
            .store(in: &cancellables)

        // Wire up ingress config response
        daemonClient?.onIngressConfigResponse = { [weak self] response in
            guard let self else { return }
            // For remote assistants, prefer the lockfile's runtimeUrl because the
            // daemon reports its own loopback address which is not reachable from
            // the client. For local assistants, use the daemon's authoritative value
            // since it reflects the daemon's actual runtime environment.
            let connectedId = UserDefaults.standard.string(forKey: "connectedAssistantId")
            let assistant = connectedId.flatMap { LockfileAssistant.loadByName($0) }
                ?? LockfileAssistant.loadLatest()
            if let assistant, assistant.isRemote {
                self.localGatewayTarget = LockfilePaths.resolveGatewayUrl(
                    connectedAssistantId: assistant.assistantId
                )
            } else {
                self.localGatewayTarget = response.localGatewayTarget
            }
            if response.success {
                if let pending = self.pendingIngressEnabled, response.enabled != pending {
                    // A set operation is in-flight and this response disagrees
                    // with the optimistic value — it's a stale get response.
                    // Skip updating enabled to prevent the toggle from bouncing.
                    self.ingressPublicBaseUrl = response.publicBaseUrl
                    self.ingressConfigLoaded = true
                    return
                }
                self.pendingIngressEnabled = nil
                self.pendingIngressUrl = nil
                self.ingressEnabled = response.enabled
                self.ingressPublicBaseUrl = response.publicBaseUrl
            } else {
                // On failure, revert optimistic updates so the UI reflects reality
                if let previousUrl = self.pendingIngressUrl {
                    self.ingressPublicBaseUrl = previousUrl
                }
                self.pendingIngressUrl = nil
                self.pendingIngressEnabled = nil
            }
            self.ingressConfigLoaded = true
        }

        // Wire up platform config response
        daemonClient?.onPlatformConfigResponse = { [weak self] response in
            guard let self else { return }
            if response.success {
                self.platformBaseUrl = response.baseUrl
                AuthService.shared.configuredBaseURL = response.baseUrl
            } else {
                // Revert optimistic state on failure
                if let previous = self.pendingPlatformUrl {
                    self.platformBaseUrl = previous
                    AuthService.shared.configuredBaseURL = previous
                    self.pendingPlatformUrl = nil
                }
                if let error = response.error {
                    log.error("Platform config update failed: \(error)")
                }
            }
        }

        // Wire up Telegram config response
        daemonClient?.onTelegramConfigResponse = { [weak self] response in
            guard let self else { return }
            self.applyTelegramConfigResponse(response)
        }

        // Twilio config is now handled via HTTP — no callback wiring needed.

        // Wire up channel verification response
        daemonClient?.onChannelVerificationSessionResponse = { [weak self] response in
            guard let self else { return }
            self.applyChannelVerificationResponse(response)
        }

        // Only fetch remote state when an assistant is already connected.
        // During initial setup there is no assistant yet, so these calls
        // would all fail with "No connected assistant" errors.
        let hasConnectedAssistant = UserDefaults.standard.string(forKey: "connectedAssistantId") != nil
        if hasConnectedAssistant {
            refreshVercelKeyState()
            refreshModelInfo()
            refreshTelegramStatus()
            refreshTwilioStatus()
            refreshChannelVerificationStatus(channel: "telegram")
            refreshChannelVerificationStatus(channel: "phone")
            refreshChannelVerificationStatus(channel: "slack")

            // Fetch provider routing sources (managed vs BYO) on init
            loadProviderRoutingSources()
        }
    }

    // MARK: - API Key Actions

    func saveAPIKey(_ raw: String, onSuccess: (() -> Void)? = nil) {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        apiKeySaveError = nil
        apiKeySaving = true

        // Persist locally first so the key survives reconnect/retry flows
        // even if the daemon is unreachable or validation is inconclusive.
        APIKeyManager.setKey(trimmed, for: "anthropic")
        hasKey = true
        maskedKey = Self.maskKey(trimmed)

        // Remove any stale deletion tombstone eagerly — the user's intent is to
        // save a new key, so any prior clear is superseded. Deferring this until
        // after async validation creates a race: if the daemon reconnects before
        // validation completes, replayDeletionTombstones would DELETE the new key.
        let hadTombstone = removeDeletionTombstone(type: "api_key", name: "anthropic")

        Task {
            let result = await syncKeyToDaemonWithValidation(provider: "anthropic", value: trimmed)
            apiKeySaving = false
            if result.success {
                scheduleRoutingSourceRefresh()
                onSuccess?()
            } else if let error = result.error {
                apiKeySaveError = error
                if !result.isTransient {
                    // Definitive validation failure (e.g. 401/422) — revert
                    // optimistic local state so an invalid key doesn't persist.
                    APIKeyManager.deleteKey(for: "anthropic")
                    hasKey = false
                    maskedKey = ""
                    // Restore the deletion tombstone if one existed before we
                    // removed it, so pending offline clears are not lost.
                    if hadTombstone {
                        addDeletionTombstone(type: "api_key", name: "anthropic")
                    }
                }
                // For transient errors (daemon unreachable), keep the local
                // key so it survives for retry on reconnect.
            }
        }
    }

    func clearAPIKey() {
        APIKeyManager.deleteKey(for: "anthropic")
        addDeletionTombstone(type: "api_key", name: "anthropic")
        deleteKeyFromDaemon(provider: "anthropic")
        hasKey = false
        maskedKey = ""
        scheduleRoutingSourceRefresh()
    }

    func saveBraveKey(_ raw: String) {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        braveKeySaveError = nil
        APIKeyManager.setKey(trimmed, for: "brave")
        removeDeletionTombstone(type: "api_key", name: "brave")
        hasBraveKey = true
        maskedBraveKey = Self.maskKey(trimmed)
        Task {
            let result = await syncKeyToDaemonWithValidation(provider: "brave", value: trimmed)
            if result.success {
                scheduleRoutingSourceRefresh()
            } else if let error = result.error {
                braveKeySaveError = error
                if !result.isTransient {
                    APIKeyManager.deleteKey(for: "brave")
                    hasBraveKey = false
                    maskedBraveKey = ""
                }
            }
        }
    }

    func clearBraveKey() {
        APIKeyManager.deleteKey(for: "brave")
        addDeletionTombstone(type: "api_key", name: "brave")
        deleteKeyFromDaemon(provider: "brave")
        hasBraveKey = false
        maskedBraveKey = ""
        scheduleRoutingSourceRefresh()
    }

    func savePerplexityKey(_ raw: String) {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        perplexityKeySaveError = nil
        APIKeyManager.setKey(trimmed, for: "perplexity")
        removeDeletionTombstone(type: "api_key", name: "perplexity")
        hasPerplexityKey = true
        maskedPerplexityKey = Self.maskKey(trimmed)
        Task {
            let result = await syncKeyToDaemonWithValidation(provider: "perplexity", value: trimmed)
            if result.success {
                scheduleRoutingSourceRefresh()
            } else if let error = result.error {
                perplexityKeySaveError = error
                if !result.isTransient {
                    APIKeyManager.deleteKey(for: "perplexity")
                    hasPerplexityKey = false
                    maskedPerplexityKey = ""
                }
            }
        }
    }

    func clearPerplexityKey() {
        APIKeyManager.deleteKey(for: "perplexity")
        addDeletionTombstone(type: "api_key", name: "perplexity")
        deleteKeyFromDaemon(provider: "perplexity")
        hasPerplexityKey = false
        maskedPerplexityKey = ""
        scheduleRoutingSourceRefresh()
    }

    func saveImageGenKey(_ raw: String) {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        imageGenKeySaveError = nil
        APIKeyManager.setKey(trimmed, for: "gemini")
        removeDeletionTombstone(type: "api_key", name: "gemini")
        hasImageGenKey = true
        maskedImageGenKey = Self.maskKey(trimmed)
        Task {
            let result = await syncKeyToDaemonWithValidation(provider: "gemini", value: trimmed)
            if result.success {
                scheduleRoutingSourceRefresh()
            } else if let error = result.error {
                imageGenKeySaveError = error
                if !result.isTransient {
                    APIKeyManager.deleteKey(for: "gemini")
                    hasImageGenKey = false
                    maskedImageGenKey = ""
                }
            }
        }
    }

    func clearImageGenKey() {
        APIKeyManager.deleteKey(for: "gemini")
        addDeletionTombstone(type: "api_key", name: "gemini")
        deleteKeyFromDaemon(provider: "gemini")
        hasImageGenKey = false
        maskedImageGenKey = ""
        scheduleRoutingSourceRefresh()
    }

    func saveElevenLabsKey(_ raw: String) {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        APIKeyManager.setKey(trimmed, for: "elevenlabs")
        removeDeletionTombstone(type: "credential", name: "elevenlabs:api_key")
        syncCredentialToDaemon(name: "elevenlabs:api_key", value: trimmed)
        hasElevenLabsKey = true
        maskedElevenLabsKey = Self.maskKey(trimmed)
    }

    func clearElevenLabsKey() {
        APIKeyManager.deleteKey(for: "elevenlabs")
        addDeletionTombstone(type: "credential", name: "elevenlabs:api_key")
        deleteCredentialFromDaemon(name: "elevenlabs:api_key")
        hasElevenLabsKey = false
        maskedElevenLabsKey = ""
    }

    func clearAPIKeyForProvider(_ provider: String) {
        APIKeyManager.deleteKey(for: provider)
        addDeletionTombstone(type: "api_key", name: provider)
        deleteKeyFromDaemon(provider: provider)
        refreshAPIKeyState()
        scheduleRoutingSourceRefresh()
    }

    func saveInferenceAPIKey(_ raw: String, provider: String, onSuccess: (() -> Void)? = nil) {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        apiKeySaveError = nil
        apiKeySaving = true

        // Persist locally first
        APIKeyManager.setKey(trimmed, for: provider)

        // Remove any stale deletion tombstone
        removeDeletionTombstone(type: "api_key", name: provider)

        Task {
            let result = await syncKeyToDaemonWithValidation(provider: provider, value: trimmed)
            apiKeySaving = false
            if result.success {
                scheduleRoutingSourceRefresh()
                onSuccess?()
            } else if let error = result.error {
                apiKeySaveError = error
                if !result.isTransient {
                    // Definitive validation failure — revert optimistic local state
                    APIKeyManager.deleteKey(for: provider)
                }
            }
        }
    }

    func setImageGenModel(_ model: String) {
        selectedImageGenModel = model
        Task {
            _ = await settingsClient.setImageGenModel(modelId: model)
        }
    }

    func refreshAPIKeyState() {
        let anthropicKey = APIKeyManager.getKey(for: "anthropic")
        hasKey = anthropicKey != nil
        maskedKey = Self.maskKey(anthropicKey)

        let braveKey = APIKeyManager.getKey(for: "brave")
        hasBraveKey = braveKey != nil
        maskedBraveKey = Self.maskKey(braveKey)

        let perplexityKey = APIKeyManager.getKey(for: "perplexity")
        hasPerplexityKey = perplexityKey != nil
        maskedPerplexityKey = Self.maskKey(perplexityKey)

        let imageGenKey = APIKeyManager.getKey(for: "gemini")
        hasImageGenKey = imageGenKey != nil
        maskedImageGenKey = Self.maskKey(imageGenKey)

        let elevenLabsKey = APIKeyManager.getKey(for: "elevenlabs")
        hasElevenLabsKey = elevenLabsKey != nil
        maskedElevenLabsKey = Self.maskKey(elevenLabsKey)

    }

    func hasKeyForProvider(_ provider: String) -> Bool {
        APIKeyManager.getKey(for: provider) != nil
    }

    func maskedKeyForProvider(_ provider: String) -> String {
        Self.maskKey(APIKeyManager.getKey(for: provider))
    }

    /// Shows the first 10 and last 4 characters of a key, e.g. "sk-ant-api...Ab1x".
    /// For short keys, reduces visible prefix/suffix so at least 3 characters are always hidden.
    static func maskKey(_ key: String?) -> String {
        guard let key, !key.isEmpty else { return "" }

        let minHidden = 3
        let maxVisible = max(1, key.count - minHidden)

        let prefixLen = min(10, maxVisible)
        let suffixLen = min(4, max(0, maxVisible - prefixLen))

        return "\(key.prefix(prefixLen))...\(key.suffix(suffixLen))"
    }

    func saveVercelKey(_ raw: String) {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        do {
            try daemonClient?.sendVercelApiConfig(action: "set", apiToken: trimmed)
        } catch {
            log.error("Failed to send Vercel API config set: \(error)")
        }
    }

    func clearVercelKey() {
        do {
            try daemonClient?.sendVercelApiConfig(action: "delete")
        } catch {
            log.error("Failed to send Vercel API config delete: \(error)")
        }
    }

    func refreshVercelKeyState() {
        Task {
            guard let response = await settingsClient.fetchVercelConfig() else { return }
            self.applyVercelConfigResponse(response)
        }
    }

    private func applyVercelConfigResponse(_ response: VercelApiConfigResponseMessage) {
        if response.success {
            self.hasVercelKey = response.hasToken
        }
    }

    func refreshModelInfo() {
        Task {
            guard let response = await settingsClient.fetchModelInfo() else { return }
            self.applyModelInfoResponse(response)
        }
    }

    private func applyModelInfoResponse(_ response: ModelInfoMessage) {
        self.lastDaemonModel = response.model
        self.lastDaemonProvider = response.provider
        self.selectedModel = response.model
        self.selectedInferenceProvider = response.provider
        if let providers = response.configuredProviders {
            self.configuredProviders = Set(providers)
        }
        if let models = response.availableModels {
            self.inferenceAvailableModels = models
        }
    }

    // MARK: - Telegram Integration Actions

    func refreshTelegramStatus() {
        Task {
            guard let response = await settingsClient.fetchTelegramConfig() else { return }
            self.applyTelegramConfigResponse(response)
        }
    }

    private func applyTelegramConfigResponse(_ response: TelegramConfigResponseMessage) {
        self.telegramSaveInProgress = false
        if response.success {
            self.telegramHasBotToken = response.hasBotToken
            self.telegramBotId = response.botId
            self.telegramBotUsername = response.botUsername
            self.telegramConnected = response.connected
            self.telegramHasWebhookSecret = response.hasWebhookSecret
            self.telegramError = nil
            self.fetchChannelSetupStatus()
        } else {
            self.telegramError = response.error
            self.fetchChannelSetupStatus()
        }
    }

    func saveTelegramToken(botToken: String) {
        let trimmed = botToken.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        telegramSaveInProgress = true
        telegramError = nil
        Task {
            guard let response = await settingsClient.setTelegramConfig(action: "set", botToken: trimmed, commands: nil) else {
                telegramSaveInProgress = false
                telegramError = "Failed to save Telegram config"
                return
            }
            applyTelegramConfigResponse(response)
        }
    }

    func clearTelegramCredentials() {
        telegramSaveInProgress = true
        telegramError = nil
        Task {
            guard let response = await settingsClient.setTelegramConfig(action: "clear", botToken: nil, commands: nil) else {
                telegramSaveInProgress = false
                log.error("Failed to send Telegram config clear")
                return
            }
            applyTelegramConfigResponse(response)
        }
    }

    // MARK: - Slack Channel Actions (HTTP-first)

    // MARK: - Daemon Key Sync (HTTP)

    /// Notify the daemon that an API key was set, so it updates its encrypted store.
    private func syncKeyToDaemon(provider: String, value: String) {
        guard let assistantId = UserDefaults.standard.string(forKey: "connectedAssistantId") else { return }
        let body: [String: String] = ["type": "api_key", "name": provider, "value": value]
        guard let bodyData = try? JSONSerialization.data(withJSONObject: body) else { return }
        Task {
            _ = try? await GatewayHTTPClient.post(path: "assistants/\(assistantId)/secrets", body: bodyData)
        }
    }

    /// Sync an API key to the daemon with server-side validation.
    /// Returns a result indicating success or a validation error message.
    private func syncKeyToDaemonWithValidation(provider: String, value: String) async -> (success: Bool, error: String?, isTransient: Bool) {
        guard let assistantId = UserDefaults.standard.string(forKey: "connectedAssistantId") else {
            return (false, "No connected assistant. Please restart the app.", true)
        }
        let body: [String: String] = ["type": "api_key", "name": provider, "value": value]
        guard let bodyData = try? JSONSerialization.data(withJSONObject: body) else {
            return (false, "Failed to encode request.", false)
        }
        do {
            let response = try await GatewayHTTPClient.post(path: "assistants/\(assistantId)/secrets", body: bodyData)
            if response.isSuccess {
                return (true, nil, false)
            }
            // 5xx errors are server-side / transient — don't treat them as
            // definitive validation failures (which would wipe the local key).
            let isServerError = response.statusCode >= 500
            // Try to parse error message from response body
            if let parsed = try? JSONSerialization.jsonObject(with: response.data) as? [String: Any],
               let errorMsg = parsed["error"] as? String {
                return (false, errorMsg, isServerError)
            }
            return (false, "Failed to save API key (HTTP \(response.statusCode)).", isServerError)
        } catch {
            return (false, "Could not reach assistant. Please check that it is running.", true)
        }
    }

    // MARK: - Key Deletion Tombstones

    /// Record that a key was explicitly cleared so the deletion can be replayed on reconnect.
    private func addDeletionTombstone(type: String, name: String) {
        var tombstones = UserDefaults.standard.array(forKey: kPendingKeyDeletionTombstones)
            as? [[String: String]] ?? []
        let entry: [String: String] = ["type": type, "name": name]
        if !tombstones.contains(where: { $0["type"] == type && $0["name"] == name }) {
            tombstones.append(entry)
            UserDefaults.standard.set(tombstones, forKey: kPendingKeyDeletionTombstones)
        }
    }

    /// Remove a tombstone when the user re-saves a key, making the pending deletion moot.
    /// Returns `true` if a matching tombstone was present and removed.
    @discardableResult
    private func removeDeletionTombstone(type: String, name: String) -> Bool {
        var tombstones = UserDefaults.standard.array(forKey: kPendingKeyDeletionTombstones)
            as? [[String: String]] ?? []
        let countBefore = tombstones.count
        tombstones.removeAll { $0["type"] == type && $0["name"] == name }
        UserDefaults.standard.set(tombstones, forKey: kPendingKeyDeletionTombstones)
        return tombstones.count < countBefore
    }

    /// Replay pending deletion tombstones, clearing only those successfully dispatched.
    private func replayDeletionTombstones() {
        let tombstones = UserDefaults.standard.array(forKey: kPendingKeyDeletionTombstones)
            as? [[String: String]] ?? []
        guard !tombstones.isEmpty else { return }
        // Bail out early if no assistant is connected — preserve all tombstones
        // for the next reconnect attempt.
        guard UserDefaults.standard.string(forKey: "connectedAssistantId") != nil else { return }
        var remaining: [[String: String]] = []
        for entry in tombstones {
            guard let type = entry["type"], let name = entry["name"] else { continue }
            var dispatched = false
            if type == "api_key" {
                dispatched = deleteKeyFromDaemon(provider: name)
            } else if type == "credential" {
                dispatched = deleteCredentialFromDaemon(name: name)
            }
            if !dispatched {
                remaining.append(entry)
            }
        }
        if remaining.isEmpty {
            UserDefaults.standard.removeObject(forKey: kPendingKeyDeletionTombstones)
        } else {
            UserDefaults.standard.set(remaining, forKey: kPendingKeyDeletionTombstones)
        }
    }

    /// Notify the daemon that an API key was deleted.
    /// Returns true if the HTTP endpoint was available and the request was dispatched.
    @discardableResult
    private func deleteKeyFromDaemon(provider: String) -> Bool {
        guard let assistantId = UserDefaults.standard.string(forKey: "connectedAssistantId") else { return false }
        let body: [String: String] = ["type": "api_key", "name": provider]
        guard let bodyData = try? JSONSerialization.data(withJSONObject: body) else { return false }
        Task {
            _ = try? await GatewayHTTPClient.delete(path: "assistants/\(assistantId)/secrets", body: bodyData)
        }
        return true
    }

    /// Notify the daemon that a credential was set (type: "credential", name: "service:field").
    private func syncCredentialToDaemon(name: String, value: String) {
        guard let assistantId = UserDefaults.standard.string(forKey: "connectedAssistantId") else { return }
        let body: [String: String] = ["type": "credential", "name": name, "value": value]
        guard let bodyData = try? JSONSerialization.data(withJSONObject: body) else { return }
        Task {
            _ = try? await GatewayHTTPClient.post(path: "assistants/\(assistantId)/secrets", body: bodyData)
        }
    }

    /// Notify the daemon that a credential was deleted.
    /// Returns true if the HTTP endpoint was available and the request was dispatched.
    @discardableResult
    private func deleteCredentialFromDaemon(name: String) -> Bool {
        guard let assistantId = UserDefaults.standard.string(forKey: "connectedAssistantId") else { return false }
        let body: [String: String] = ["type": "credential", "name": name]
        guard let bodyData = try? JSONSerialization.data(withJSONObject: body) else { return false }
        Task {
            _ = try? await GatewayHTTPClient.delete(path: "assistants/\(assistantId)/secrets", body: bodyData)
        }
        return true
    }

    /// Re-sync locally-known keys to daemon on reconnect.
    /// Pushes keys present in the macOS keychain, and replays any pending
    /// deletion tombstones so user-initiated clears are eventually consistent.
    /// Waits for the JWT to become available before syncing, because reconnect
    /// can fire before async credential bootstrap completes.
    private func syncAllKeysToDaemon() {
        Task {
            // In managed mode, auth is handled by SessionTokenManager — no actor token needed.
            // In local mode, wait for the JWT to be populated; on reconnect the async
            // credential bootstrap may still be in-flight.
            let connectedId = UserDefaults.standard.string(forKey: "connectedAssistantId")
            let isManagedMode = connectedId
                .flatMap { LockfileAssistant.loadByName($0) }?.isManaged ?? false
            if !isManagedMode {
                guard let _ = await ActorTokenManager.waitForToken(timeout: 15) else { return }
            }

            for provider in APIKeyManager.allSyncableProviders {
                if let key = APIKeyManager.getKey(for: provider) {
                    syncKeyToDaemon(provider: provider, value: key)
                }
            }

            // ElevenLabs uses the credential type, not api_key
            if let key = APIKeyManager.getKey(for: "elevenlabs") {
                syncCredentialToDaemon(name: "elevenlabs:api_key", value: key)
            }

            replayDeletionTombstones()
        }
    }

    func fetchSlackChannelConfig() {
        guard let assistantId = UserDefaults.standard.string(forKey: "connectedAssistantId") else { return }
        Task {
            do {
                let (config, response): (SlackChannelConfigResponse?, _) = try await GatewayHTTPClient.get(
                    path: "assistants/\(assistantId)/integrations/slack/channel/config",
                    timeout: 10
                )
                if response.statusCode == 200, let config {
                    self.slackChannelHasBotToken = config.hasBotToken ?? false
                    self.slackChannelHasAppToken = config.hasAppToken ?? false
                    self.slackChannelConnected = config.connected ?? false
                    self.slackChannelBotUsername = config.botUsername
                    self.slackChannelBotUserId = config.botUserId
                    self.slackChannelTeamId = config.teamId
                    self.slackChannelTeamName = config.teamName
                    self.slackChannelError = nil
                } else if response.statusCode == 404 {
                    self.slackChannelHasBotToken = false
                    self.slackChannelHasAppToken = false
                    self.slackChannelConnected = false
                    self.slackChannelBotUsername = nil
                    self.slackChannelBotUserId = nil
                    self.slackChannelTeamId = nil
                    self.slackChannelTeamName = nil
                }
            } catch {
                log.error("Failed to fetch Slack channel config: \(error)")
            }
        }
    }

    func saveSlackChannelConfig(botToken: String, appToken: String) {
        let trimmedBot = botToken.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedApp = appToken.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedBot.isEmpty, !trimmedApp.isEmpty else { return }
        slackChannelSaveInProgress = true
        slackChannelError = nil
        guard let assistantId = UserDefaults.standard.string(forKey: "connectedAssistantId") else {
            slackChannelSaveInProgress = false
            return
        }
        let body: [String: String] = ["botToken": trimmedBot, "appToken": trimmedApp]
        guard let bodyData = try? JSONSerialization.data(withJSONObject: body) else {
            slackChannelSaveInProgress = false
            return
        }
        Task {
            do {
                let response = try await GatewayHTTPClient.post(
                    path: "assistants/\(assistantId)/integrations/slack/channel/config",
                    body: bodyData,
                    timeout: 10
                )
                self.slackChannelSaveInProgress = false
                if response.isSuccess {
                    if let json = try? JSONSerialization.jsonObject(with: response.data) as? [String: Any] {
                        self.slackChannelHasBotToken = json["hasBotToken"] as? Bool ?? true
                        self.slackChannelHasAppToken = json["hasAppToken"] as? Bool ?? true
                        self.slackChannelConnected = json["connected"] as? Bool ?? false
                        self.slackChannelBotUsername = json["botUsername"] as? String
                        self.slackChannelBotUserId = json["botUserId"] as? String
                        self.slackChannelTeamId = json["teamId"] as? String
                        self.slackChannelTeamName = json["teamName"] as? String
                        self.slackChannelError = nil
                    } else {
                        self.slackChannelHasBotToken = true
                        self.slackChannelHasAppToken = true
                    }
                    self.fetchChannelSetupStatus()
                } else {
                    let errorMsg: String
                    if let json = try? JSONSerialization.jsonObject(with: response.data) as? [String: Any],
                       let msg = json["error"] as? String {
                        errorMsg = msg
                    } else {
                        errorMsg = "HTTP \(response.statusCode)"
                    }
                    self.slackChannelError = "Failed to save: \(errorMsg)"
                }
            } catch {
                self.slackChannelSaveInProgress = false
                self.slackChannelError = "Failed to save: \(error.localizedDescription)"
            }
        }
    }

    func clearSlackChannelConfig() {
        slackChannelSaveInProgress = true
        slackChannelError = nil
        guard let assistantId = UserDefaults.standard.string(forKey: "connectedAssistantId") else {
            slackChannelSaveInProgress = false
            return
        }
        Task {
            do {
                let response = try await GatewayHTTPClient.delete(
                    path: "assistants/\(assistantId)/integrations/slack/channel/config",
                    timeout: 10
                )
                if response.isSuccess {
                    self.slackChannelHasBotToken = false
                    self.slackChannelHasAppToken = false
                    self.slackChannelConnected = false
                    self.slackChannelBotUsername = nil
                    self.slackChannelBotUserId = nil
                    self.slackChannelTeamId = nil
                    self.slackChannelTeamName = nil
                    self.slackChannelError = nil
                } else {
                    self.slackChannelError = "Failed to disconnect: HTTP \(response.statusCode)"
                }
                self.slackChannelSaveInProgress = false
                self.fetchChannelSetupStatus()
            } catch {
                self.slackChannelSaveInProgress = false
                self.slackChannelError = "Failed to disconnect: \(error.localizedDescription)"
                self.fetchChannelSetupStatus()
                log.error("Failed to clear Slack channel config: \(error)")
            }
        }
    }

    // MARK: - Twilio Actions (HTTP)

    /// Shared helper: perform a Twilio HTTP request via GatewayHTTPClient,
    /// decode the JSON response, and apply the result to @Published properties.
    private func performTwilioHTTPRequest(
        method: String,
        path: String,
        body: [String: Any]? = nil,
        applyPhoneNumber: Bool = false,
        applyNumbers: Bool = false
    ) async {
        guard let assistantId = UserDefaults.standard.string(forKey: "connectedAssistantId") else {
            twilioError = "No connected assistant"
            return
        }

        let gatewayPath = "assistants/\(assistantId)/\(path)"
        let bodyData: Data?
        if let body {
            bodyData = try? JSONSerialization.data(withJSONObject: body)
        } else {
            bodyData = nil
        }

        do {
            let response: GatewayHTTPClient.Response
            switch method {
            case "GET":
                response = try await GatewayHTTPClient.get(path: gatewayPath)
            case "POST":
                response = try await GatewayHTTPClient.post(path: gatewayPath, body: bodyData)
            case "DELETE":
                response = try await GatewayHTTPClient.delete(path: gatewayPath, body: bodyData)
            default:
                twilioError = "Unsupported HTTP method"
                return
            }

            guard response.isSuccess else {
                let errorBody = String(data: response.data, encoding: .utf8) ?? "HTTP \(response.statusCode)"
                twilioError = "Request failed: \(errorBody)"
                return
            }

            guard let json = try JSONSerialization.jsonObject(with: response.data) as? [String: Any] else {
                twilioError = "Invalid JSON response"
                return
            }

            let success = json["success"] as? Bool ?? false
            let hasCredentials = json["hasCredentials"] as? Bool ?? false

            if success {
                twilioHasCredentials = hasCredentials
                if !hasCredentials {
                    twilioPhoneNumber = nil
                    twilioNumbers = []
                } else {
                    if applyPhoneNumber || json["phoneNumber"] != nil {
                        twilioPhoneNumber = json["phoneNumber"] as? String
                    }
                    if applyNumbers {
                        twilioNumbers = Self.decodeTwilioNumbers(from: json["numbers"])
                    } else if let rawNumbers = json["numbers"] {
                        twilioNumbers = Self.decodeTwilioNumbers(from: rawNumbers)
                    }
                }
                twilioWarning = json["warning"] as? String
                twilioError = nil
            } else {
                twilioWarning = json["warning"] as? String
                twilioError = json["error"] as? String ?? "Unknown error"
            }
        } catch {
            twilioError = error.localizedDescription
        }
    }

    /// Decode the `numbers` array from the Twilio HTTP response JSON into typed objects.
    private static func decodeTwilioNumbers(from raw: Any?) -> [TwilioNumberInfo] {
        guard let array = raw as? [[String: Any]] else { return [] }
        return array.compactMap { dict -> TwilioNumberInfo? in
            guard let phoneNumber = dict["phoneNumber"] as? String,
                  let friendlyName = dict["friendlyName"] as? String,
                  let caps = dict["capabilities"] as? [String: Any] else { return nil }
            let voice = caps["voice"] as? Bool ?? false
            return TwilioNumberInfo(
                phoneNumber: phoneNumber,
                friendlyName: friendlyName,
                capabilities: TwilioNumberCapabilities(voice: voice)
            )
        }
    }

    func refreshTwilioStatus() {
        twilioSaveInProgress = true
        twilioError = nil
        Task {
            await performTwilioHTTPRequest(
                method: "GET",
                path: "integrations/twilio/config",
                applyPhoneNumber: true
            )
            twilioSaveInProgress = false
        }
    }

    func saveTwilioCredentials(accountSid: String, authToken: String) {
        let trimmedSid = accountSid.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedToken = authToken.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedSid.isEmpty, !trimmedToken.isEmpty else { return }
        twilioSaveInProgress = true
        twilioError = nil
        twilioWarning = nil
        Task {
            await performTwilioHTTPRequest(
                method: "POST",
                path: "integrations/twilio/credentials",
                body: ["accountSid": trimmedSid, "authToken": trimmedToken]
            )
            twilioSaveInProgress = false
            self.fetchChannelSetupStatus()
            // Fetch available phone numbers immediately after saving credentials
            if twilioHasCredentials {
                self.refreshTwilioNumbers()
            }
        }
    }

    func clearTwilioCredentials() {
        twilioSaveInProgress = true
        twilioError = nil
        twilioWarning = nil
        Task {
            await performTwilioHTTPRequest(
                method: "DELETE",
                path: "integrations/twilio/credentials"
            )
            // Clear any warning/error set by the response — "credentials not
            // configured" is obvious after the user just disconnected.
            twilioWarning = nil
            twilioError = nil
            twilioSaveInProgress = false
            self.fetchChannelSetupStatus()
        }
    }

    func assignTwilioNumber(phoneNumber: String) {
        let trimmed = phoneNumber.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        twilioSaveInProgress = true
        twilioError = nil
        twilioWarning = nil
        Task {
            await performTwilioHTTPRequest(
                method: "POST",
                path: "integrations/twilio/numbers/assign",
                body: ["phoneNumber": trimmed],
                applyPhoneNumber: true
            )
            twilioSaveInProgress = false
        }
    }

    func unassignTwilioNumber() {
        twilioPhoneNumber = nil
        twilioError = nil
        twilioWarning = nil
    }

    func provisionTwilioNumber(areaCode: String?, country: String?) {
        let trimmedAreaCode = areaCode?.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedCountry = country?.trimmingCharacters(in: .whitespacesAndNewlines)
        twilioSaveInProgress = true
        twilioError = nil
        twilioWarning = nil
        Task {
            var body: [String: Any] = [:]
            if let ac = trimmedAreaCode, !ac.isEmpty { body["areaCode"] = ac }
            if let c = trimmedCountry, !c.isEmpty { body["country"] = c.uppercased() }
            await performTwilioHTTPRequest(
                method: "POST",
                path: "integrations/twilio/numbers/provision",
                body: body.isEmpty ? nil : body,
                applyPhoneNumber: true
            )
            twilioSaveInProgress = false
        }
    }

    func refreshTwilioNumbers() {
        twilioListInProgress = true
        twilioError = nil
        Task {
            await performTwilioHTTPRequest(
                method: "GET",
                path: "integrations/twilio/numbers",
                applyNumbers: true
            )
            twilioListInProgress = false
            // Auto-select the first available number if none is assigned
            if twilioPhoneNumber == nil, let first = twilioNumbers.first {
                assignTwilioNumber(phoneNumber: first.phoneNumber)
            }
        }
    }

    // MARK: - Channel Verification Actions

    func refreshChannelVerificationStatus(channel: String) {
        Task {
            guard let response = await settingsClient.fetchChannelVerificationStatus(channel: channel) else { return }
            self.applyChannelVerificationResponse(response)
        }
    }

    private func applyChannelVerificationResponse(_ response: ChannelVerificationSessionResponseMessage) {
        guard let channel = resolveVerificationResponseChannel(response.channel) else { return }
        let isStatusPoll = response.success && response.secret == nil && response.instruction == nil && response.bound != true
        if !isStatusPoll {
            clearVerificationSessionPending(for: channel)
        }

        switch channel {
        case "telegram":
            telegramVerificationInProgress = false
            if response.success {
                telegramVerificationIdentity = response.guardianExternalUserId
                telegramVerificationUsername = Self.reflectedString(response, key: "guardianUsername")
                telegramVerificationDisplayName = Self.reflectedString(response, key: "guardianDisplayName")
                let isVerified = response.bound ?? false
                telegramVerificationVerified = isVerified
                if isVerified {
                    telegramVerificationInstruction = nil
                } else if let instruction = response.instruction {
                    telegramVerificationInstruction = instruction
                }
                telegramVerificationError = nil
                telegramVerificationAlreadyBound = false
            } else {
                let isAlreadyBound = response.error == "already_bound"
                telegramVerificationAlreadyBound = isAlreadyBound
                telegramVerificationError = isAlreadyBound
                    ? "A guardian is already bound. Revoke it first or replace it."
                    : response.error
            }
        case "phone":
            voiceVerificationInProgress = false
            if response.success {
                voiceVerificationIdentity = response.guardianExternalUserId
                voiceVerificationUsername = Self.reflectedString(response, key: "guardianUsername")
                voiceVerificationDisplayName = Self.reflectedString(response, key: "guardianDisplayName")
                let isVerified = response.bound ?? false
                voiceVerificationVerified = isVerified
                if isVerified {
                    voiceVerificationInstruction = nil
                } else if let instruction = response.instruction {
                    voiceVerificationInstruction = instruction
                }
                voiceVerificationError = nil
                voiceVerificationAlreadyBound = false
            } else {
                let isAlreadyBound = response.error == "already_bound"
                voiceVerificationAlreadyBound = isAlreadyBound
                voiceVerificationError = isAlreadyBound
                    ? "A guardian is already bound. Revoke it first or replace it."
                    : response.error
            }
        case "slack":
            slackVerificationInProgress = false
            if response.success {
                slackVerificationIdentity = response.guardianExternalUserId
                slackVerificationUsername = Self.reflectedString(response, key: "guardianUsername")
                slackVerificationDisplayName = Self.reflectedString(response, key: "guardianDisplayName")
                let isVerified = response.bound ?? false
                slackVerificationVerified = isVerified
                if isVerified {
                    slackVerificationInstruction = nil
                } else if let instruction = response.instruction {
                    slackVerificationInstruction = instruction
                }
                slackVerificationError = nil
                slackVerificationAlreadyBound = false
            } else {
                let isAlreadyBound = response.error == "already_bound"
                slackVerificationAlreadyBound = isAlreadyBound
                slackVerificationError = isAlreadyBound
                    ? "A guardian is already bound. Revoke it first or replace it."
                    : response.error
            }
        default:
            break
        }

        if response.success {
            if response.verificationSessionId != nil {
                applyOutboundResponseState(channel: channel, response: response)
                startVerificationStatusPolling(for: channel)
            } else if response.secret != nil || response.instruction != nil {
                startVerificationStatusPolling(for: channel)
            } else if response.bound == true {
                clearOutboundState(for: channel)
                stopVerificationStatusPolling(for: channel)
            }
        } else {
            let terminalErrors: Set<String> = ["no_active_session", "already_bound"]
            if let error = response.error, terminalErrors.contains(error) {
                clearOutboundState(for: channel)
            }
            stopVerificationStatusPolling(for: channel)
        }
    }

    func startChannelVerification(channel: String, rebind: Bool = false) {
        stopVerificationStatusPolling(for: channel)
        switch channel {
        case "telegram":
            telegramVerificationInProgress = true
            telegramVerificationError = nil
            telegramVerificationAlreadyBound = false
            telegramVerificationInstruction = nil
        case "phone":
            voiceVerificationInProgress = true
            voiceVerificationError = nil
            voiceVerificationAlreadyBound = false
            voiceVerificationInstruction = nil
        case "slack":
            slackVerificationInProgress = true
            slackVerificationError = nil
            slackVerificationAlreadyBound = false
            slackVerificationInstruction = nil
        default:
            return
        }
        do {
            guard let daemonClient else {
                clearVerificationSessionPending(for: channel)
                switch channel {
                case "telegram":
                    telegramVerificationInProgress = false
                    telegramVerificationError = "Daemon is not connected. Reconnect and try again."
                case "phone":
                    voiceVerificationInProgress = false
                    voiceVerificationError = "Daemon is not connected. Reconnect and try again."
                case "slack":
                    slackVerificationInProgress = false
                    slackVerificationError = "Daemon is not connected. Reconnect and try again."
                default:
                    break
                }
                return
            }
            pendingVerificationSessionChannel = channel
            armVerificationSessionTimeout(for: channel)
            try daemonClient.sendChannelVerificationSession(
                action: "create_session",
                channel: channel,
                rebind: rebind ? true : nil
            )
        } catch {
            log.error("Failed to start \(channel) channel verification: \(error)")
            clearVerificationSessionPending(for: channel)
            switch channel {
            case "telegram":
                telegramVerificationInProgress = false
                telegramVerificationError = "Failed to start verification. Try again."
            case "phone":
                voiceVerificationInProgress = false
                voiceVerificationError = "Failed to start verification. Try again."
            case "slack":
                slackVerificationInProgress = false
                slackVerificationError = "Failed to start verification. Try again."
            default:
                break
            }
        }
    }

    func cancelVerificationSession(channel: String) {
        stopVerificationStatusPolling(for: channel)
        clearVerificationSessionPending(for: channel)
        switch channel {
        case "telegram":
            telegramVerificationInProgress = false
            telegramVerificationInstruction = nil
        case "phone":
            voiceVerificationInProgress = false
            voiceVerificationInstruction = nil
        case "slack":
            slackVerificationInProgress = false
            slackVerificationInstruction = nil
        default:
            break
        }
        // Invalidate the pending session on the backend so it can't be used after cancellation
        do {
            try daemonClient?.sendChannelVerificationSession(action: "revoke", channel: channel)
        } catch {
            log.error("Failed to revoke \(channel) verification session on cancel: \(error)")
        }
    }

    func revokeChannelVerification(channel: String) {
        stopVerificationStatusPolling(for: channel)
        // Eagerly clear instruction so the "Verify" button reappears
        // immediately instead of waiting for the daemon's response (which
        // looks identical to a status poll and won't clear it).
        switch channel {
        case "telegram":
            telegramVerificationInstruction = nil
        case "phone":
            voiceVerificationInstruction = nil
        case "slack":
            slackVerificationInstruction = nil
        default:
            break
        }
        do {
            try daemonClient?.sendChannelVerificationSession(action: "revoke", channel: channel)
        } catch {
            log.error("Failed to revoke \(channel) verification: \(error)")
        }
    }

    // MARK: - Outbound Verification Actions

    func startOutboundVerification(channel: String, destination: String) {
        clearOutboundState(for: channel)
        stopVerificationStatusPolling(for: channel)
        switch channel {
        case "telegram":
            telegramVerificationInProgress = true
            telegramVerificationError = nil
            telegramVerificationAlreadyBound = false
        case "phone":
            voiceVerificationInProgress = true
            voiceVerificationError = nil
            voiceVerificationAlreadyBound = false
        case "slack":
            slackVerificationInProgress = true
            slackVerificationError = nil
            slackVerificationAlreadyBound = false
        default:
            return
        }
        do {
            guard let daemonClient else {
                switch channel {
                case "telegram":
                    telegramVerificationInProgress = false
                    telegramVerificationError = "Daemon is not connected. Reconnect and try again."
                case "phone":
                    voiceVerificationInProgress = false
                    voiceVerificationError = "Daemon is not connected. Reconnect and try again."
                case "slack":
                    slackVerificationInProgress = false
                    slackVerificationError = "Daemon is not connected. Reconnect and try again."
                default:
                    break
                }
                return
            }
            try daemonClient.sendChannelVerificationSession(
                action: "create_session",
                channel: channel,
                destination: destination
            )
        } catch {
            log.error("Failed to start outbound \(channel) channel verification: \(error)")
            switch channel {
            case "telegram":
                telegramVerificationInProgress = false
                telegramVerificationError = "Failed to start verification. Try again."
            case "phone":
                voiceVerificationInProgress = false
                voiceVerificationError = "Failed to start verification. Try again."
            case "slack":
                slackVerificationInProgress = false
                slackVerificationError = "Failed to start verification. Try again."
            default:
                break
            }
        }
    }

    func resendOutboundVerification(channel: String) {
        do {
            try daemonClient?.sendChannelVerificationSession(
                action: "resend_session",
                channel: channel
            )
        } catch {
            log.error("Failed to resend outbound \(channel) channel verification: \(error)")
        }
    }

    func cancelOutboundVerification(channel: String) {
        stopVerificationStatusPolling(for: channel)
        clearOutboundState(for: channel)
        switch channel {
        case "telegram":
            telegramVerificationInProgress = false
        case "phone":
            voiceVerificationInProgress = false
        case "slack":
            slackVerificationInProgress = false
        default:
            break
        }
        do {
            try daemonClient?.sendChannelVerificationSession(
                action: "cancel_session",
                channel: channel
            )
        } catch {
            log.error("Failed to cancel outbound \(channel) channel verification: \(error)")
        }
    }

    private func clearOutboundState(for channel: String) {
        switch channel {
        case "telegram":
            telegramOutboundSessionId = nil
            telegramOutboundExpiresAt = nil
            telegramOutboundNextResendAt = nil
            telegramOutboundSendCount = 0
            telegramBootstrapUrl = nil
            telegramOutboundCode = nil
        case "phone":
            voiceOutboundSessionId = nil
            voiceOutboundExpiresAt = nil
            voiceOutboundNextResendAt = nil
            voiceOutboundSendCount = 0
            voiceOutboundCode = nil
        case "slack":
            slackOutboundSessionId = nil
            slackOutboundExpiresAt = nil
            slackOutboundNextResendAt = nil
            slackOutboundSendCount = 0
            slackOutboundCode = nil
        default:
            break
        }
    }

    private func applyOutboundResponseState(channel: String, response: ChannelVerificationSessionResponseMessage) {
        let conversationId = response.verificationSessionId
        // Only update fields when the response includes them; partial payloads (e.g. resend
        // success) omit fields like expiresAt, sendCount, and nextResendAt. Overwriting with
        // nil/zero would lose countdown tracking and UI state.
        let expiresAt = response.expiresAt.map { Date(timeIntervalSince1970: TimeInterval($0) / 1000.0) }
        let nextResendAt = response.nextResendAt.map { Date(timeIntervalSince1970: TimeInterval($0) / 1000.0) }
        let sendCount = response.sendCount
        let bootstrapUrl = response.telegramBootstrapUrl
        // The secret is returned on start/resend but not on status polls.
        // Persist it so the UI can display the verification code.
        let secret = response.secret

        switch channel {
        case "telegram":
            // When the session changes, reset resend metadata so stale cooldown/counter
            // values from the old session don't persist through the if-let guards below.
            if conversationId != telegramOutboundSessionId {
                telegramOutboundNextResendAt = nil
                telegramOutboundSendCount = 0
                telegramOutboundCode = nil
            }
            telegramOutboundSessionId = conversationId
            if let expiresAt { telegramOutboundExpiresAt = expiresAt }
            if let nextResendAt { telegramOutboundNextResendAt = nextResendAt }
            if let sendCount { telegramOutboundSendCount = sendCount }
            if let secret { telegramOutboundCode = secret }
            if let bootstrapUrl {
                telegramBootstrapUrl = bootstrapUrl
            } else if response.pendingBootstrap == true {
                // Session is still in pending_bootstrap state — preserve the
                // existing bootstrap URL so the deep link stays visible. The
                // status handler cannot reconstruct the URL (only the hash is
                // stored), so we must not overwrite what we received earlier.
            } else if conversationId != nil {
                // Bootstrap complete — clear the URL so resend becomes available
                telegramBootstrapUrl = nil
            }
        case "phone":
            if conversationId != voiceOutboundSessionId {
                voiceOutboundNextResendAt = nil
                voiceOutboundSendCount = 0
                voiceOutboundCode = nil
            }
            voiceOutboundSessionId = conversationId
            if let expiresAt { voiceOutboundExpiresAt = expiresAt }
            if let nextResendAt { voiceOutboundNextResendAt = nextResendAt }
            if let sendCount { voiceOutboundSendCount = sendCount }
            if let secret { voiceOutboundCode = secret }
        case "slack":
            if conversationId != slackOutboundSessionId {
                slackOutboundNextResendAt = nil
                slackOutboundSendCount = 0
                slackOutboundCode = nil
            }
            slackOutboundSessionId = conversationId
            if let expiresAt { slackOutboundExpiresAt = expiresAt }
            if let nextResendAt { slackOutboundNextResendAt = nextResendAt }
            if let sendCount { slackOutboundSendCount = sendCount }
            if let secret { slackOutboundCode = secret }
        default:
            break
        }
    }

    private func resolveVerificationResponseChannel(_ channel: String?) -> String? {
        if let channel {
            return channel
        }
        if let pendingVerificationSessionChannel {
            return pendingVerificationSessionChannel
        }
        // Disambiguate when exactly one channel has verification in progress
        let inProgressChannels = [
            ("telegram", telegramVerificationInProgress),
            ("phone", voiceVerificationInProgress),
            ("slack", slackVerificationInProgress),
        ].filter(\.1)
        if inProgressChannels.count == 1 {
            return inProgressChannels.first?.0
        }
        return nil
    }

    private func clearVerificationSessionPending(for channel: String) {
        if pendingVerificationSessionChannel == channel {
            pendingVerificationSessionChannel = nil
            verificationSessionTimeoutWorkItem?.cancel()
            verificationSessionTimeoutWorkItem = nil
        }
        // Clear stale instruction so the "Verify" button reappears
        // when a session is no longer active (timeout, revoke, or error).
        switch channel {
        case "telegram":
            telegramVerificationInstruction = nil
        case "phone":
            voiceVerificationInstruction = nil
        case "slack":
            slackVerificationInstruction = nil
        default:
            break
        }
    }

    private func armVerificationSessionTimeout(for channel: String) {
        verificationSessionTimeoutWorkItem?.cancel()
        let workItem = DispatchWorkItem { [weak self] in
            guard let self else { return }
            guard self.pendingVerificationSessionChannel == channel else { return }
            self.pendingVerificationSessionChannel = nil
            switch channel {
            case "telegram":
                self.telegramVerificationInProgress = false
                self.telegramVerificationInstruction = nil
                if self.telegramVerificationError == nil {
                    self.telegramVerificationError = "Timed out waiting for verification instructions. Try again."
                }
            case "phone":
                self.voiceVerificationInProgress = false
                self.voiceVerificationInstruction = nil
                if self.voiceVerificationError == nil {
                    self.voiceVerificationError = "Timed out waiting for verification instructions. Try again."
                }
            case "slack":
                self.slackVerificationInProgress = false
                self.slackVerificationInstruction = nil
                if self.slackVerificationError == nil {
                    self.slackVerificationError = "Timed out waiting for verification instructions. Try again."
                }
            default:
                break
            }
        }
        verificationSessionTimeoutWorkItem = workItem
        DispatchQueue.main.asyncAfter(deadline: .now() + verificationSessionTimeoutDuration, execute: workItem)
    }

    private func startVerificationStatusPolling(for channel: String) {
        guard channel == "telegram" || channel == "phone" || channel == "slack" else { return }
        stopVerificationStatusPolling(for: channel)
        verificationStatusPollingDeadlines[channel] = Date().addingTimeInterval(verificationStatusPollWindow)
        scheduleVerificationStatusPoll(for: channel, delay: verificationStatusPollInterval)
    }

    private func stopVerificationStatusPolling(for channel: String) {
        verificationStatusPollingWorkItems[channel]?.cancel()
        verificationStatusPollingWorkItems[channel] = nil
        verificationStatusPollingDeadlines[channel] = nil
    }

    private func scheduleVerificationStatusPoll(for channel: String, delay: TimeInterval) {
        let workItem = DispatchWorkItem { [weak self] in
            guard let self else { return }
            guard let deadline = self.verificationStatusPollingDeadlines[channel] else { return }
            if Date() >= deadline {
                self.stopVerificationStatusPolling(for: channel)
                return
            }
            self.refreshChannelVerificationStatus(channel: channel)
            self.scheduleVerificationStatusPoll(for: channel, delay: self.verificationStatusPollInterval)
        }
        verificationStatusPollingWorkItems[channel]?.cancel()
        verificationStatusPollingWorkItems[channel] = workItem
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: workItem)
    }

    // MARK: - Email Integration

    func refreshAssistantEmail() {
        Task {
            let status = await integrationClient.fetchIntegrationsStatus()
            self.assistantEmail = status?.email.address
        }
    }

    // MARK: - Channel Setup Status

    func fetchChannelSetupStatus() {
        Task {
            let readiness = await channelClient.fetchChannelReadiness()
            for (channel, info) in readiness {
                self.channelSetupStatus[channel] = info.setupStatus ?? "not_configured"
            }
        }
    }

    // MARK: - Platform Config

    func refreshPlatformConfig() {
        do {
            try daemonClient?.send(PlatformConfigRequestMessage(action: "get"))
        } catch {
            log.error("Failed to send platform config get: \(error)")
        }
    }

    func savePlatformBaseUrl(_ raw: String) {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let previous = platformBaseUrl
        pendingPlatformUrl = previous
        platformBaseUrl = trimmed
        AuthService.shared.configuredBaseURL = trimmed
        do {
            try daemonClient?.send(PlatformConfigRequestMessage(action: "set", baseUrl: trimmed))
        } catch {
            pendingPlatformUrl = nil
            platformBaseUrl = previous
            AuthService.shared.configuredBaseURL = previous
            log.error("Failed to send platform config set: \(error)")
        }
    }

    // MARK: - Provider Routing Sources

    /// Fetches provider routing sources from the daemon debug endpoint and
    /// updates `providerRoutingSources`. Non-fatal — silently ignores errors.
    func loadProviderRoutingSources() {
        guard let assistantId = UserDefaults.standard.string(forKey: "connectedAssistantId") else {
            providerRoutingSources = [:]
            return
        }
        Task {
            do {
                let response = try await GatewayHTTPClient.get(
                    path: "assistants/\(assistantId)/debug",
                    timeout: 10
                )
                guard response.isSuccess else { return }
                guard let json = try? JSONSerialization.jsonObject(with: response.data) as? [String: Any],
                      let provider = json["provider"] as? [String: Any],
                      let sources = provider["routingSources"] as? [String: String] else { return }
                self.providerRoutingSources = sources
                self.loadServiceModes()
            } catch {
                log.error("Failed to load provider routing sources: \(error)")
            }
        }
    }

    /// Loads service modes (inference, image-generation) from workspace config.
    /// Called during init and when the daemon reconnects.
    func loadServiceModes() {
        let config = WorkspaceConfigIO.read(from: configPath)
        guard let services = config["services"] as? [String: Any] else { return }
        if let inference = services["inference"] as? [String: Any] {
            if let mode = inference["mode"] as? String { self.inferenceMode = mode }
            if let provider = inference["provider"] as? String { self.selectedInferenceProvider = provider }
        }
        if let imageGen = services["image-generation"] as? [String: Any] {
            if let mode = imageGen["mode"] as? String {
                self.imageGenMode = mode
            }
            if let model = imageGen["model"] as? String,
               Self.availableImageGenModels.contains(model) {
                self.selectedImageGenModel = model
            }
        }
        if let webSearch = services["web-search"] as? [String: Any],
           let mode = webSearch["mode"] as? String {
            self.webSearchMode = mode
        }
        if let googleOAuth = services["google-oauth"] as? [String: Any],
           let mode = googleOAuth["mode"] as? String {
            self.googleOAuthMode = mode
        }
    }

    func setInferenceMode(_ mode: String) {
        inferenceMode = mode
        guard !isCurrentAssistantRemote else { return }
        let existingConfig = WorkspaceConfigIO.read(from: configPath)
        var services = existingConfig["services"] as? [String: Any] ?? [:]
        var inference = services["inference"] as? [String: Any] ?? [:]
        inference["mode"] = mode
        services["inference"] = inference
        do {
            try WorkspaceConfigIO.merge(["services": services], into: configPath)
        } catch {
            log.error("Failed to merge workspace config for inference mode: \(error)")
        }
        scheduleRoutingSourceRefresh()
    }

    func setImageGenMode(_ mode: String) {
        imageGenMode = mode
        guard !isCurrentAssistantRemote else { return }
        let existingConfig = WorkspaceConfigIO.read(from: configPath)
        var services = existingConfig["services"] as? [String: Any] ?? [:]
        var imageGen = services["image-generation"] as? [String: Any] ?? [:]
        imageGen["mode"] = mode
        services["image-generation"] = imageGen
        do {
            try WorkspaceConfigIO.merge(["services": services], into: configPath)
        } catch {
            log.error("Failed to merge workspace config for image-generation mode: \(error)")
        }
        scheduleRoutingSourceRefresh()
    }

    func setWebSearchMode(_ mode: String) {
        webSearchMode = mode
        guard !isCurrentAssistantRemote else { return }
        let existingConfig = WorkspaceConfigIO.read(from: configPath)
        var services = existingConfig["services"] as? [String: Any] ?? [:]
        var webSearch = services["web-search"] as? [String: Any] ?? [:]
        webSearch["mode"] = mode
        services["web-search"] = webSearch
        do {
            try WorkspaceConfigIO.merge(["services": services], into: configPath)
        } catch {
            log.error("Failed to merge workspace config for web search mode: \(error)")
        }
        scheduleRoutingSourceRefresh()
    }

    func setGoogleOAuthMode(_ mode: String) {
        googleOAuthMode = mode
        guard !isCurrentAssistantRemote else { return }
        let existingConfig = WorkspaceConfigIO.read(from: configPath)
        var services = existingConfig["services"] as? [String: Any] ?? [:]
        var googleOAuth = services["google-oauth"] as? [String: Any] ?? [:]
        googleOAuth["mode"] = mode
        services["google-oauth"] = googleOAuth
        do {
            try WorkspaceConfigIO.merge(["services": services], into: configPath)
        } catch {
            log.error("Failed to merge workspace config for google-oauth mode: \(error)")
        }
    }

    // MARK: - Google OAuth Connections

    /// Resolves the platform assistant UUID for OAuth endpoints.
    /// For managed assistants, the lockfile ID is the platform UUID.
    /// For self-hosted local assistants, looks up the persisted mapping via PlatformAssistantIdResolver.
    private func resolvePlatformAssistantId(userId: String?) -> String? {
        guard let connectedId = UserDefaults.standard.string(forKey: "connectedAssistantId"), !connectedId.isEmpty,
              let assistant = LockfileAssistant.loadByName(connectedId) else {
            return nil
        }
        let orgId = UserDefaults.standard.string(forKey: "connectedOrganizationId")
        return PlatformAssistantIdResolver.resolve(
            lockfileAssistantId: assistant.assistantId,
            isManaged: assistant.isManaged,
            organizationId: orgId,
            userId: userId,
            credentialStorage: KeychainCredentialStorage()
        )
    }

    func fetchGoogleOAuthConnections(userId: String? = nil) async {
        guard googleOAuthMode == "managed" else { return }
        guard let assistantId = resolvePlatformAssistantId(userId: userId) else { return }

        do {
            let connections = try await PlatformOAuthService.shared.listConnections(assistantId: assistantId)
            googleOAuthConnections = connections.filter { $0.provider == "google" }
            googleOAuthError = nil
        } catch {
            log.error("Failed to fetch Google OAuth connections: \(error)")
            googleOAuthError = error.localizedDescription
            googleOAuthConnections = []
        }
    }

    func startGoogleOAuthConnect(userId: String? = nil) {
        Task {
            googleOAuthIsConnecting = true
            googleOAuthError = nil
            defer { googleOAuthIsConnecting = false }

            guard let assistantId = resolvePlatformAssistantId(userId: userId) else {
                googleOAuthError = "No connected assistant"
                return
            }

            do {
                let response = try await PlatformOAuthService.shared.startGoogleOAuth(
                    assistantId: assistantId,
                    redirectAfterConnect: "vellum-assistant://oauth/google/callback"
                )

                guard let connectURL = URL(string: response.connect_url) else {
                    googleOAuthError = "Invalid connect URL"
                    return
                }

                let callbackURL: URL = try await withCheckedThrowingContinuation { continuation in
                    let session = ASWebAuthenticationSession(url: connectURL, callbackURLScheme: "vellum-assistant") { callbackURL, error in
                        if let error {
                            continuation.resume(throwing: error)
                        } else if let callbackURL {
                            continuation.resume(returning: callbackURL)
                        } else {
                            continuation.resume(throwing: URLError(.badServerResponse))
                        }
                    }
                    session.prefersEphemeralWebBrowserSession = false
                    session.presentationContextProvider = WebAuthPresentationContext.shared
                    session.start()
                }

                let components = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false)
                let oauthStatus = components?.queryItems?.first(where: { $0.name == "oauth_status" })?.value

                if oauthStatus == "connected" {
                    await fetchGoogleOAuthConnections(userId: userId)
                } else if oauthStatus == "error" {
                    let errorCode = components?.queryItems?.first(where: { $0.name == "oauth_code" })?.value
                    googleOAuthError = errorCode ?? "OAuth connection failed"
                }
            } catch {
                log.error("Google OAuth connect failed: \(error)")
                googleOAuthError = error.localizedDescription
            }
        }
    }

    func disconnectGoogleOAuthConnection(_ connectionId: String, userId: String? = nil) {
        Task {
            guard let assistantId = resolvePlatformAssistantId(userId: userId) else {
                googleOAuthError = "No connected assistant"
                return
            }

            do {
                try await PlatformOAuthService.shared.disconnectConnection(assistantId: assistantId, connectionId: connectionId)
                await fetchGoogleOAuthConnections(userId: userId)
            } catch {
                log.error("Failed to disconnect Google OAuth connection: \(error)")
                googleOAuthError = error.localizedDescription
            }
        }
    }

    func setWebSearchProvider(_ provider: String) {
        webSearchProvider = provider
        guard !isCurrentAssistantRemote else { return }
        let existingConfig = WorkspaceConfigIO.read(from: configPath)
        var services = existingConfig["services"] as? [String: Any] ?? [:]
        var webSearch = services["web-search"] as? [String: Any] ?? [:]
        webSearch["provider"] = provider
        services["web-search"] = webSearch
        do {
            try WorkspaceConfigIO.merge(["services": services], into: configPath)
        } catch {
            log.error("Failed to merge workspace config for web search provider: \(error)")
        }
        scheduleRoutingSourceRefresh()
    }

    func setInferenceProvider(_ provider: String) {
        selectedInferenceProvider = provider
        guard !isCurrentAssistantRemote else { return }
        let existingConfig = WorkspaceConfigIO.read(from: configPath)
        var services = existingConfig["services"] as? [String: Any] ?? [:]
        var inference = services["inference"] as? [String: Any] ?? [:]
        inference["provider"] = provider
        services["inference"] = inference
        do {
            try WorkspaceConfigIO.merge(["services": services], into: configPath)
        } catch {
            log.error("Failed to persist inference provider: \(error.localizedDescription)")
        }
    }

    /// Schedules a delayed refresh of provider routing sources, giving the
    /// daemon time to re-initialize providers after a key change.
    private func scheduleRoutingSourceRefresh() {
        routingSourceRefreshTask?.cancel()
        routingSourceRefreshTask = Task {
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            guard !Task.isCancelled else { return }
            loadProviderRoutingSources()
        }
    }

    // MARK: - Ingress Config

    func refreshIngressConfig() {
        do {
            try daemonClient?.send(IngressConfigRequestMessage(action: "get"))
        } catch {
            log.error("Failed to send ingress config get: \(error)")
        }
    }

    func saveIngressPublicBaseUrl(_ raw: String) {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        // Update local state optimistically so the focus-leave onChange handler
        // in SettingsPanel reads the new value instead of reverting
        // the text field to a stale URL. The daemon's success response
        // (handled by onIngressConfigResponse) will confirm or correct.
        let previous = ingressPublicBaseUrl
        ingressPublicBaseUrl = trimmed
        pendingIngressUrl = previous
        // Reset stale health status so the UI doesn't show results from the old URL
        let previousReachable = ingressReachable
        let previousLastChecked = tunnelLastChecked
        ingressReachable = nil
        tunnelLastChecked = nil
        // Auto-enable ingress when a non-empty URL is saved, auto-disable when cleared.
        // The dedicated Public Ingress toggle was removed, so this is the only path
        // that controls the enabled flag.
        let shouldEnable = !trimmed.isEmpty
        ingressEnabled = shouldEnable
        do {
            try daemonClient?.send(IngressConfigRequestMessage(action: "set", publicBaseUrl: trimmed, enabled: shouldEnable))
        } catch {
            // Send failed — roll back the optimistic update
            ingressPublicBaseUrl = previous
            pendingIngressUrl = nil
            ingressReachable = previousReachable
            tunnelLastChecked = previousLastChecked
        }
    }

    func setIngressEnabled(_ enabled: Bool) {
        ingressEnabled = enabled
        pendingIngressEnabled = enabled
        do {
            try daemonClient?.send(IngressConfigRequestMessage(action: "set", publicBaseUrl: ingressPublicBaseUrl, enabled: enabled))
        } catch {
            log.error("Failed to send ingress config set (enabled): \(error)")
        }
    }

    // MARK: - Connection Health Check

    /// Tests reachability of the local gateway process.
    func testGatewayOnly() async {
        isCheckingGateway = true
        defer {
            isCheckingGateway = false
            gatewayLastChecked = Date()
        }
        gatewayReachable = await Self.checkHealthEndpoint(
            baseUrl: localGatewayTarget,
            timeoutSeconds: 3
        )
    }

    /// Tests reachability of the public tunnel URL.
    func testTunnelOnly() async {
        isCheckingTunnel = true
        defer { isCheckingTunnel = false }
        let trimmedUrl = ingressPublicBaseUrl.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmedUrl.isEmpty {
            ingressReachable = nil
        } else {
            ingressReachable = await Self.checkHealthEndpoint(
                baseUrl: trimmedUrl,
                timeoutSeconds: 5
            )
            tunnelLastChecked = Date()
        }
    }

    /// Performs an HTTP GET to `<baseUrl>/healthz` and returns whether a 2xx response was received.
    private static func checkHealthEndpoint(baseUrl: String, timeoutSeconds: TimeInterval) async -> Bool {
        let normalizedBase = baseUrl.hasSuffix("/") ? String(baseUrl.dropLast()) : baseUrl
        guard let url = URL(string: "\(normalizedBase)/healthz") else { return false }
        var request = URLRequest(url: url)
        request.timeoutInterval = timeoutSeconds
        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            if let httpResponse = response as? HTTPURLResponse {
                return (200..<300).contains(httpResponse.statusCode)
            }
            return false
        } catch {
            return false
        }
    }

    // MARK: - Approved Devices

    @Published var approvedDevices: [ApprovedDevicesListResponseMessage.Device] = []

    func refreshApprovedDevices() {
        Task {
            do {
                let devices = try await pairingClient.fetchApprovedDevices()
                self.approvedDevices = devices
            } catch {
                // Fetch failed — preserve existing local state
            }
        }
    }

    func removeApprovedDevice(hashedDeviceId: String) {
        let removed = approvedDevices.filter { $0.hashedDeviceId == hashedDeviceId }
        approvedDevices.removeAll { $0.hashedDeviceId == hashedDeviceId }
        Task {
            do {
                let success = try await pairingClient.removeApprovedDevice(hashedDeviceId: hashedDeviceId)
                if !success {
                    self.approvedDevices.append(contentsOf: removed)
                }
            } catch {
                // Request failed — restore optimistically removed devices
                self.approvedDevices.append(contentsOf: removed)
            }
        }
    }

    func clearAllApprovedDevices() {
        Task {
            do {
                let success = try await pairingClient.clearApprovedDevices()
                if success {
                    self.approvedDevices = []
                }
            } catch {
                // Request failed — don't clear local state
            }
        }
    }

    // MARK: - iOS Pairing

    /// Gateway URL for iOS pairing.
    var resolvedIosGatewayUrl: String {
        ingressPublicBaseUrl
    }

    /// LAN pairing URL for the gateway, or nil if no LAN IP available.
    var lanPairingUrl: String? {
        guard let ip = LANIPHelper.currentLANAddress() else { return nil }
        let connectedId = UserDefaults.standard.string(forKey: "connectedAssistantId")
        return "http://\(ip):\(LockfilePaths.resolveGatewayPort(connectedAssistantId: connectedId))"
    }

    // MARK: - Model Actions

    func setModel(_ model: String, provider: String? = nil) {
        // Skip if neither model nor provider changed
        let modelUnchanged = model == lastDaemonModel
        let providerUnchanged = provider == nil || provider == lastDaemonProvider
        guard !modelUnchanged || !providerUnchanged else { return }
        lastDaemonModel = model
        if let provider { lastDaemonProvider = provider }
        Task {
            let info = await settingsClient.setModel(model: model, provider: provider)
            if let info {
                applyModelInfoResponse(info)
            } else if lastDaemonModel == model {
                // Request failed — revert only if no newer call overwrote lastDaemonModel
                lastDaemonModel = nil
                lastDaemonProvider = nil
            }
        }
    }

    // MARK: - User Timezone Actions

    /// Saves a user timezone override under `ui.userTimezone`.
    ///
    /// Returns an error string when the value is not a valid IANA timezone.
    @discardableResult
    func saveUserTimezone(_ raw: String) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            clearUserTimezone()
            return nil
        }

        guard let canonical = Self.canonicalizeTimeZoneIdentifier(trimmed) else {
            return "Use an IANA timezone like America/New_York."
        }

        userTimezone = canonical
        persistUserTimezone()
        return nil
    }

    /// Removes the user timezone override so runtime falls back to profile memory or host timezone.
    func clearUserTimezone() {
        userTimezone = nil
        persistUserTimezone()
    }

    // MARK: - Media Embed Actions

    /// Toggles media embeds on or off and persists the change to the workspace config.
    ///
    /// When turning ON from OFF, `mediaEmbedsEnabledSince` is reset to the current
    /// date so that only messages created after this moment are eligible for embeds.
    /// When turning OFF, the existing `enabledSince` timestamp is preserved so a
    /// subsequent re-enable doesn't accidentally surface old links.
    func setMediaEmbedsEnabled(_ enabled: Bool) {
        if enabled {
            guard !mediaEmbedsEnabled else { return }
            mediaEmbedsEnabled = true
            mediaEmbedsEnabledSince = MediaEmbedSettings.enabledSinceNow()
            persistMediaEmbedState()
        } else {
            guard mediaEmbedsEnabled else { return }
            mediaEmbedsEnabled = false
            persistMediaEmbedState()
        }
    }

    /// Replaces the video-embed domain allowlist, normalizing the input and
    /// persisting the result to the workspace config.
    func setMediaEmbedVideoAllowlistDomains(_ domains: [String]) {
        let normalized = MediaEmbedSettings.normalizeDomains(domains)
        mediaEmbedVideoAllowlistDomains = normalized

        guard !isCurrentAssistantRemote else { return }

        let existingConfig = WorkspaceConfigIO.read(from: configPath)
        var existingUI = existingConfig["ui"] as? [String: Any] ?? [:]
        var existingMediaEmbeds = existingUI["mediaEmbeds"] as? [String: Any] ?? [:]

        existingMediaEmbeds["videoAllowlistDomains"] = normalized
        existingUI["mediaEmbeds"] = existingMediaEmbeds

        do {
            try WorkspaceConfigIO.merge(["ui": existingUI], into: configPath)
        } catch {
            log.error("Failed to merge workspace config for video allowlist domains: \(error)")
        }
    }

    /// Writes the current `mediaEmbedsEnabled` and `mediaEmbedsEnabledSince` to
    /// the workspace config under `ui.mediaEmbeds`.
    private func persistMediaEmbedState() {
        guard !isCurrentAssistantRemote else { return }

        var mediaEmbedsDict: [String: Any] = [
            "enabled": mediaEmbedsEnabled,
        ]

        if let since = mediaEmbedsEnabledSince {
            let formatter = ISO8601DateFormatter()
            mediaEmbedsDict["enabledSince"] = formatter.string(from: since)
        }

        // Read existing config to preserve sibling keys inside ui and ui.mediaEmbeds
        let existingConfig = WorkspaceConfigIO.read(from: configPath)
        var existingUI = existingConfig["ui"] as? [String: Any] ?? [:]
        var existingMediaEmbeds = existingUI["mediaEmbeds"] as? [String: Any] ?? [:]

        // Merge our changes on top of whatever is already in mediaEmbeds
        for (key, value) in mediaEmbedsDict {
            existingMediaEmbeds[key] = value
        }
        existingUI["mediaEmbeds"] = existingMediaEmbeds

        do {
            try WorkspaceConfigIO.merge(["ui": existingUI], into: configPath)
        } catch {
            log.error("Failed to merge workspace config for media embed state: \(error)")
        }
    }

    // MARK: - Media Embed Loading

    private struct MediaEmbedLoadResult {
        let enabled: Bool
        let enabledSince: Date?
        let domains: [String]
        /// True when `enabledSince` was not found in the config and was
        /// defaulted to "now". The caller should persist the value so
        /// that subsequent loads produce a deterministic timestamp.
        let didDefaultEnabledSince: Bool
    }

    /// Reads `ui.mediaEmbeds` from the workspace config and falls back to
    /// `MediaEmbedSettings` defaults for any missing or invalid values.
    ///
    /// When no `enabledSince` is found in the config (missing file, missing
    /// section, or missing/unparseable key), the value defaults to "now" so
    /// that fresh installs only embed new messages going forward.
    private static func loadMediaEmbedSettings(from configPath: String? = nil) -> MediaEmbedLoadResult {
        let config = WorkspaceConfigIO.read(from: configPath)

        guard let ui = config["ui"] as? [String: Any],
              let mediaEmbeds = ui["mediaEmbeds"] as? [String: Any] else {
            // No config file, empty config, or no ui.mediaEmbeds section —
            // default enabledSince to now so old history is gated.
            return MediaEmbedLoadResult(
                enabled: MediaEmbedSettings.defaultEnabled,
                enabledSince: MediaEmbedSettings.enabledSinceNow(),
                domains: MediaEmbedSettings.defaultDomains,
                didDefaultEnabledSince: true
            )
        }

        let enabled = mediaEmbeds["enabled"] as? Bool ?? MediaEmbedSettings.defaultEnabled

        var enabledSince: Date?
        var didDefault = false
        if let isoString = mediaEmbeds["enabledSince"] as? String {
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            enabledSince = formatter.date(from: isoString)
            // Fall back to parsing without fractional seconds
            if enabledSince == nil {
                formatter.formatOptions = [.withInternetDateTime]
                enabledSince = formatter.date(from: isoString)
            }
        }

        // If enabledSince is still nil (key missing, wrong type, or
        // unparseable), default to now so old messages are gated.
        if enabledSince == nil {
            enabledSince = MediaEmbedSettings.enabledSinceNow()
            didDefault = true
        }

        let domains: [String]
        if let rawDomains = mediaEmbeds["videoAllowlistDomains"] as? [String] {
            domains = MediaEmbedSettings.normalizeDomains(rawDomains)
        } else {
            domains = MediaEmbedSettings.defaultDomains
        }

        return MediaEmbedLoadResult(
            enabled: enabled,
            enabledSince: enabledSince,
            domains: domains,
            didDefaultEnabledSince: didDefault
        )
    }

    // MARK: - User Timezone Loading/Persistence

    private func persistUserTimezone() {
        guard !isCurrentAssistantRemote else { return }

        let existingConfig = WorkspaceConfigIO.read(from: configPath)
        var existingUI = existingConfig["ui"] as? [String: Any] ?? [:]
        if let timezone = userTimezone {
            existingUI["userTimezone"] = timezone
        } else {
            existingUI.removeValue(forKey: "userTimezone")
        }

        do {
            try WorkspaceConfigIO.merge(["ui": existingUI], into: configPath)
        } catch {
            log.error("Failed to merge workspace config for user timezone: \(error)")
        }
    }

    private static func loadUserTimezone(from configPath: String? = nil) -> String? {
        let config = WorkspaceConfigIO.read(from: configPath)
        guard let ui = config["ui"] as? [String: Any],
              let raw = ui["userTimezone"] as? String else {
            return nil
        }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            return nil
        }
        return canonicalizeTimeZoneIdentifier(trimmed)
    }
}

// MARK: - Slack Channel Config Response

private struct SlackChannelConfigResponse: Decodable {
    let hasBotToken: Bool?
    let hasAppToken: Bool?
    let connected: Bool?
    let botUsername: String?
    let botUserId: String?
    let teamId: String?
    let teamName: String?
}
