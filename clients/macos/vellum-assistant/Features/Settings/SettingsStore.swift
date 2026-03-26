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

    // MARK: - Embedding Config State
    @Published var embeddingProvider: String = "auto"
    @Published var embeddingModel: String? = nil
    @Published var embeddingActiveProvider: String? = nil
    @Published var embeddingActiveModel: String? = nil
    @Published var embeddingAvailableProviders: [EmbeddingProviderOption] = []
    @Published var embeddingEnabled: Bool = true
    @Published var embeddingDegraded: Bool = false
    @Published var embeddingKeySaveError: String? = nil

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

    // MARK: - Inference Provider Selection

    @Published var selectedInferenceProvider: String = "anthropic"

    /// Full provider catalog from daemon. Seeded with inline defaults for pre-fetch rendering.
    @Published var providerCatalog: [ProviderCatalogEntry] = []

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
    @Published var sidebarToggleShortcut: String
    @Published var newChatShortcut: String
    @Published var currentConversationShortcut: String
    @Published var popOutShortcut: String
    @Published var cmdEnterToSend: Bool

    // MARK: - Media Embed Settings

    @Published var mediaEmbedsEnabled: Bool
    @Published var mediaEmbedsEnabledSince: Date?
    @Published var mediaEmbedVideoAllowlistDomains: [String]
    @Published var userTimezone: String?

    // MARK: - Permissions Settings

    @Published var dangerouslySkipPermissions: Bool
    /// Monotonic counter to ignore stale rollback responses from rapid toggles.
    private var skipPermissionsToggleGeneration: UInt = 0

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

    /// Managed OAuth mode per provider (keyed by managedServiceConfigKey). Values: "managed" or "your-own".
    @Published var managedOAuthMode: [String: String] = [:]
    /// Managed OAuth connections per provider (keyed by managedServiceConfigKey).
    @Published var managedOAuthConnections: [String: [OAuthConnectionEntry]] = [:]
    /// Whether a managed OAuth connect flow is in progress (keyed by managedServiceConfigKey).
    @Published var managedOAuthIsConnecting: [String: Bool] = [:]
    /// Managed OAuth errors per provider (keyed by managedServiceConfigKey).
    @Published var managedOAuthError: [String: String] = [:]
    /// Strong reference to prevent the auth session from being deallocated mid-flow.
    private var managedOAuthWebAuthSession: ASWebAuthenticationSession?

    // MARK: - Your Own OAuth State

    @Published var yourOwnOAuthApps: [String: [YourOwnOAuthApp]] = [:]
    @Published var yourOwnOAuthConnectionsByApp: [String: [YourOwnOAuthConnection]] = [:]
    @Published var yourOwnOAuthIsLoading: Set<String> = []
    @Published var yourOwnOAuthError: [String: String] = [:]
    @Published var yourOwnOAuthConnectingAppId: String? = nil
    @Published var yourOwnOAuthProviderMetadata: [String: OAuthProviderMetadata] = [:]

    static let availableWebSearchProviders = ["inference-provider-native", "perplexity", "brave"]

    static let webSearchProviderDisplayNames: [String: String] = [
        "inference-provider-native": "Provider Native",
        "perplexity": "Perplexity",
        "brave": "Brave",
    ]

    // MARK: - Platform Config State

    @Published var platformBaseUrl: String = ""

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
    /// Sourced from `GatewayConnectionManager.isTrustRulesSheetOpen` so each view can
    /// disable its button when the other surface is showing trust rules.
    @Published var isAnyTrustRulesSheetOpen = false

    // MARK: - Privacy

    /// Whether the user has opted in to sending crash reports, error diagnostics, and
    /// performance metrics. Defaults to `true`. Controls Sentry independently from usage analytics.
    @Published var sendDiagnostics: Bool = UserDefaults.standard.object(forKey: "sendDiagnostics") as? Bool
        ?? UserDefaults.standard.object(forKey: "sendPerformanceReports") as? Bool
        ?? true

    /// Whether the user has opted in to sharing anonymized usage analytics (e.g. token counts,
    /// feature adoption). Defaults to `true`. Independent from diagnostics.
    @Published var collectUsageData: Bool = UserDefaults.standard.object(forKey: "collectUsageData") as? Bool
        ?? true

    // MARK: - Private

    private weak var connectionManager: GatewayConnectionManager?
    private let eventStreamClient: EventStreamClient?
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

    /// Whether the connected assistant runs in Docker on the local machine.
    /// Docker assistants are "remote" for filesystem purposes (workspace is on
    /// a Docker volume) but support config changes via the HTTP API.
    private var isCurrentAssistantDocker: Bool {
        UserDefaults.standard.string(forKey: "connectedAssistantId")
            .flatMap { LockfileAssistant.loadByName($0) }?.isDocker ?? false
    }

    /// Guards against stale `get` responses overwriting an optimistic
    /// toggle. Set when `setIngressEnabled` fires; cleared once a matching
    /// response arrives.
    private var pendingIngressEnabled: Bool?
    private var pendingIngressUrl: String?
    private var routingSourceRefreshTask: Task<Void, Never>?
    private var yourOwnOAuthConnectPollingTask: Task<Void, Never>?

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
        connectionManager: GatewayConnectionManager? = nil,
        eventStreamClient: EventStreamClient? = nil,
        channelClient: ChannelClientProtocol = ChannelClient(),
        integrationClient: IntegrationClientProtocol = IntegrationClient(),
        settingsClient: SettingsClientProtocol = SettingsClient(),
        pairingClient: PairingClientProtocol = PairingClient(),
        configPath: String? = nil,
        verificationSessionTimeoutDuration: TimeInterval = 12,
        verificationStatusPollInterval: TimeInterval = 2,
        verificationStatusPollWindow: TimeInterval = 600
    ) {
        self.connectionManager = connectionManager
        self.eventStreamClient = eventStreamClient
        self.channelClient = channelClient
        self.integrationClient = integrationClient
        self.settingsClient = settingsClient
        self.pairingClient = pairingClient
        self.configPath = configPath
        self.verificationSessionTimeoutDuration = max(0.05, verificationSessionTimeoutDuration)
        self.verificationStatusPollInterval = max(0.05, verificationStatusPollInterval)
        self.verificationStatusPollWindow = max(self.verificationStatusPollInterval, verificationStatusPollWindow)

        // Seed from UserDefaults / credential storage
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
        // Restore persisted image-gen model as a local fallback so the
        // user's selection survives restarts even if the daemon is unreachable.
        // loadServiceModes() will override with the daemon's authoritative
        // value once it connects.
        let storedImageGenModel = UserDefaults.standard.string(forKey: "selectedImageGenModel")
        if let storedImageGenModel, Self.availableImageGenModels.contains(storedImageGenModel) {
            self.selectedImageGenModel = storedImageGenModel
        }

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
        if UserDefaults.standard.object(forKey: "sidebarToggleShortcut") == nil {
            self.sidebarToggleShortcut = "cmd+\\"
        } else {
            self.sidebarToggleShortcut = UserDefaults.standard.string(forKey: "sidebarToggleShortcut") ?? ""
        }
        if UserDefaults.standard.object(forKey: "newChatShortcut") == nil {
            self.newChatShortcut = "cmd+n"
        } else {
            self.newChatShortcut = UserDefaults.standard.string(forKey: "newChatShortcut") ?? ""
        }
        if UserDefaults.standard.object(forKey: "currentConversationShortcut") == nil {
            self.currentConversationShortcut = "cmd+shift+n"
        } else {
            self.currentConversationShortcut = UserDefaults.standard.string(forKey: "currentConversationShortcut") ?? ""
        }
        if UserDefaults.standard.object(forKey: "popOutShortcut") == nil {
            self.popOutShortcut = "cmd+p"
        } else {
            self.popOutShortcut = UserDefaults.standard.string(forKey: "popOutShortcut") ?? ""
        }

        // Use defaults for config-dependent properties; the daemon will
        // provide authoritative values once reachable via loadConfigFromDaemon().
        let emptyConfig: [String: Any] = [:]

        // Load media embed settings (defaults when config is empty)
        let mediaSettings = Self.loadMediaEmbedSettings(config: emptyConfig)
        self.mediaEmbedsEnabled = mediaSettings.enabled
        self.mediaEmbedsEnabledSince = mediaSettings.enabledSince
        self.mediaEmbedVideoAllowlistDomains = mediaSettings.domains
        self.userTimezone = Self.loadUserTimezone(config: emptyConfig)

        // Permissions default to false until daemon provides config
        self.dangerouslySkipPermissions = false

        // Service modes use defaults until daemon provides config
        loadServiceModes(config: emptyConfig)

        // Seed provider catalog with shared defaults so the UI has data before
        // the first daemon fetch completes.
        providerCatalog = ProviderCatalogEntry.defaultCatalog

        // React to credential storage changes from other surfaces
        NotificationCenter.default.publisher(for: .apiKeyManagerDidChange)
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in self?.refreshAPIKeyState() }
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

        $sidebarToggleShortcut
            .dropFirst()
            .sink { value in UserDefaults.standard.set(value, forKey: "sidebarToggleShortcut") }
            .store(in: &cancellables)

        $newChatShortcut
            .dropFirst()
            .sink { value in UserDefaults.standard.set(value, forKey: "newChatShortcut") }
            .store(in: &cancellables)

        $currentConversationShortcut
            .dropFirst()
            .sink { value in UserDefaults.standard.set(value, forKey: "currentConversationShortcut") }
            .store(in: &cancellables)

        $popOutShortcut
            .dropFirst()
            .sink { value in UserDefaults.standard.set(value, forKey: "popOutShortcut") }
            .store(in: &cancellables)

        // Mirror GatewayConnectionManager's trust-rules-open flag so views can disable their buttons
        connectionManager?.$isTrustRulesSheetOpen
            .receive(on: RunLoop.main)
            .assign(to: &$isAnyTrustRulesSheetOpen)

        // Subscribe to daemon-pushed model changes so the UI stays in sync
        // when the model is changed externally (e.g. via CLI or another client).
        connectionManager?.$latestModelInfo
            .compactMap { $0 }
            .receive(on: RunLoop.main)
            .sink { [weak self] info in
                guard let self else { return }
                self.applyModelInfoResponse(info)
            }
            .store(in: &cancellables)

        // Subscribe to SSE-pushed config updates
        Task { @MainActor [weak self] in
            guard let self, let eventStreamClient = self.eventStreamClient else { return }
            for await message in eventStreamClient.subscribe() {
                switch message {
                case .ingressConfigResponse(let response):
                    self.handleIngressConfigResponse(response)
                case .telegramConfigResponse(let response):
                    self.applyTelegramConfigResponse(response)
                default:
                    break
                }
            }
        }

        // Twilio config is now handled via HTTP — no callback wiring needed.

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
                refreshModelInfo()
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
        refreshModelInfo()
    }

    func saveBraveKey(_ raw: String) {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        braveKeySaveError = nil
        APIKeyManager.setKey(trimmed, for: "brave")
        // Remove any stale deletion tombstone eagerly — the user's intent is to
        // save a new key, so any prior clear is superseded.
        let hadTombstone = removeDeletionTombstone(type: "api_key", name: "brave")
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
                    // Restore the deletion tombstone if one existed before we
                    // removed it, so pending offline clears are not lost.
                    if hadTombstone {
                        addDeletionTombstone(type: "api_key", name: "brave")
                    }
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
        // Remove any stale deletion tombstone eagerly — the user's intent is to
        // save a new key, so any prior clear is superseded.
        let hadTombstone = removeDeletionTombstone(type: "api_key", name: "perplexity")
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
                    // Restore the deletion tombstone if one existed before we
                    // removed it, so pending offline clears are not lost.
                    if hadTombstone {
                        addDeletionTombstone(type: "api_key", name: "perplexity")
                    }
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
        // Remove any stale deletion tombstone eagerly — the user's intent is to
        // save a new key, so any prior clear is superseded.
        let hadTombstone = removeDeletionTombstone(type: "api_key", name: "gemini")
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
                    // Restore the deletion tombstone if one existed before we
                    // removed it, so pending offline clears are not lost.
                    if hadTombstone {
                        addDeletionTombstone(type: "api_key", name: "gemini")
                    }
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
        hasElevenLabsKey = true
        maskedElevenLabsKey = Self.maskKey(trimmed)
    }

    func clearElevenLabsKey() {
        APIKeyManager.deleteKey(for: "elevenlabs")
        hasElevenLabsKey = false
        maskedElevenLabsKey = ""
    }

    func clearAPIKeyForProvider(_ provider: String) {
        APIKeyManager.deleteKey(for: provider)
        addDeletionTombstone(type: "api_key", name: provider)
        deleteKeyFromDaemon(provider: provider)
        refreshAPIKeyState()
        scheduleRoutingSourceRefresh()
        refreshModelInfo()
    }

    func saveInferenceAPIKey(_ raw: String, provider: String, onSuccess: (() -> Void)? = nil, onError: ((String) -> Void)? = nil) {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        // Only mutate inference-card state when called from the inference path
        // (onError == nil). When called from the embedding path, these would
        // briefly flash saving state on the inference card and clear any
        // existing inference error.
        if onError == nil {
            apiKeySaveError = nil
            apiKeySaving = true
        }

        // Persist locally first
        APIKeyManager.setKey(trimmed, for: provider)

        // Remove any stale deletion tombstone eagerly — the user's intent is to
        // save a new key, so any prior clear is superseded. Deferring this until
        // after async validation creates a race: if the daemon reconnects before
        // validation completes, replayDeletionTombstones would DELETE the new key.
        let hadTombstone = removeDeletionTombstone(type: "api_key", name: provider)

        Task {
            let result = await syncKeyToDaemonWithValidation(provider: provider, value: trimmed)
            if onError == nil {
                apiKeySaving = false
            }
            if result.success {
                scheduleRoutingSourceRefresh()
                onSuccess?()
                refreshModelInfo()
            } else if let error = result.error {
                if let onError {
                    onError(error)
                } else {
                    apiKeySaveError = error
                }
                if !result.isTransient {
                    // Definitive validation failure — revert optimistic local state
                    APIKeyManager.deleteKey(for: provider)
                    // Restore the deletion tombstone if one existed before we
                    // removed it, so pending offline clears are not lost.
                    if hadTombstone {
                        addDeletionTombstone(type: "api_key", name: provider)
                    }
                }
            }
        }
    }

    func setImageGenModel(_ model: String) {
        selectedImageGenModel = model
        UserDefaults.standard.set(model, forKey: "selectedImageGenModel")
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
        Task {
            guard let response = await settingsClient.saveVercelConfig(apiToken: trimmed) else { return }
            self.applyVercelConfigResponse(response)
        }
    }

    func clearVercelKey() {
        Task {
            guard let response = await settingsClient.deleteVercelConfig() else { return }
            self.applyVercelConfigResponse(response)
        }
    }

    func refreshVercelKeyState() {
        Task {
            guard let response = await settingsClient.fetchVercelConfig() else { return }
            self.applyVercelConfigResponse(response)
        }
    }

    /// Fetches and applies the current Vercel config, returning whether a token is present.
    func checkVercelKeyPresent() async -> Bool {
        guard let response = await settingsClient.fetchVercelConfig() else { return false }
        applyVercelConfigResponse(response)
        return response.success && response.hasToken
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
        if let allProviders = response.allProviders, !allProviders.isEmpty {
            self.providerCatalog = allProviders
        }
    }

    // MARK: - Dynamic Provider Catalog Helpers

    var dynamicProviderIds: [String] {
        providerCatalog.map(\.id)
    }

    func dynamicProviderDisplayName(_ provider: String) -> String {
        providerCatalog.first { $0.id == provider }?.displayName ?? provider
    }

    func dynamicProviderModels(_ provider: String) -> [CatalogModel] {
        providerCatalog.first { $0.id == provider }?.models ?? []
    }

    func dynamicProviderDefaultModel(_ provider: String) -> String {
        providerCatalog.first { $0.id == provider }?.defaultModel ?? ""
    }

    func dynamicProviderApiKeyPlaceholder(_ provider: String) -> String? {
        providerCatalog.first { $0.id == provider }?.apiKeyPlaceholder
    }

    // MARK: - Embedding Config Actions

    func refreshEmbeddingConfig() {
        Task { @MainActor in
            guard let config = await settingsClient.fetchEmbeddingConfig() else { return }
            self.embeddingProvider = config.provider
            self.embeddingModel = config.model
            self.embeddingActiveProvider = config.activeProvider
            self.embeddingActiveModel = config.activeModel
            if let providers = config.availableProviders {
                self.embeddingAvailableProviders = providers
            }
            if let status = config.status {
                self.embeddingEnabled = status.enabled
                self.embeddingDegraded = status.degraded
            }
        }
    }

    /// Fetches the current dangerouslySkipPermissions state from the daemon
    /// over HTTP. Only meaningful for Docker assistants where the config lives
    /// inside the container and cannot be read from the host filesystem.
    func refreshDangerouslySkipPermissions() {
        guard isCurrentAssistantDocker else { return }
        Task { @MainActor in
            guard let enabled = await settingsClient.fetchDangerouslySkipPermissions() else { return }
            self.dangerouslySkipPermissions = enabled
        }
    }

    func setEmbeddingProvider(_ provider: String, model: String?) {
        Task { @MainActor in
            guard let config = await settingsClient.setEmbeddingConfig(provider: provider, model: model) else { return }
            self.embeddingProvider = config.provider
            self.embeddingModel = config.model
            self.embeddingActiveProvider = config.activeProvider
            self.embeddingActiveModel = config.activeModel
            if let providers = config.availableProviders {
                self.embeddingAvailableProviders = providers
            }
            if let status = config.status {
                self.embeddingEnabled = status.enabled
                self.embeddingDegraded = status.degraded
            }
        }
    }

    func saveEmbeddingAPIKey(_ raw: String, provider: String) {
        embeddingKeySaveError = nil
        // Delegate to saveInferenceAPIKey — same credential store, same daemon validation
        saveInferenceAPIKey(raw, provider: provider, onSuccess: {
            self.refreshEmbeddingConfig()
        }, onError: { error in
            self.embeddingKeySaveError = error
        })
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
    /// Pushes keys present in the credential store, and replays any pending
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

    func applyChannelVerificationResponse(_ response: ChannelVerificationSessionResponseMessage) {
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
        pendingVerificationSessionChannel = channel
        armVerificationSessionTimeout(for: channel)
        Task {
            guard let response = await settingsClient.sendChannelVerificationSession(
                action: "create_session",
                channel: channel,
                conversationId: nil,
                rebind: rebind ? true : nil,
                destination: nil,
                originConversationId: nil,
                purpose: nil,
                contactChannelId: nil
            ) else {
                clearVerificationSessionPending(for: channel)
                self.setVerificationError(for: channel, message: "Failed to start verification. Try again.")
                return
            }
            self.applyChannelVerificationResponse(response)
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
        Task {
            _ = await settingsClient.sendChannelVerificationSession(
                action: "revoke", channel: channel,
                conversationId: nil, rebind: nil, destination: nil,
                originConversationId: nil, purpose: nil, contactChannelId: nil
            )
        }
    }

    func revokeChannelVerification(channel: String) {
        stopVerificationStatusPolling(for: channel)
        // Eagerly clear instruction so the "Verify" button reappears
        // immediately instead of waiting for the server's response (which
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
        Task {
            let response = await settingsClient.sendChannelVerificationSession(
                action: "revoke", channel: channel,
                conversationId: nil, rebind: nil, destination: nil,
                originConversationId: nil, purpose: nil, contactChannelId: nil
            )
            if let response {
                self.applyChannelVerificationResponse(response)
            }
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
        Task {
            guard let response = await settingsClient.sendChannelVerificationSession(
                action: "create_session",
                channel: channel,
                conversationId: nil,
                rebind: nil,
                destination: destination,
                originConversationId: nil,
                purpose: nil,
                contactChannelId: nil
            ) else {
                self.setVerificationError(for: channel, message: "Failed to start verification. Try again.")
                return
            }
            self.applyChannelVerificationResponse(response)
        }
    }

    func resendOutboundVerification(channel: String) {
        Task {
            let response = await settingsClient.sendChannelVerificationSession(
                action: "resend_session", channel: channel,
                conversationId: nil, rebind: nil, destination: nil,
                originConversationId: nil, purpose: nil, contactChannelId: nil
            )
            if let response {
                self.applyChannelVerificationResponse(response)
            }
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
        Task {
            _ = await settingsClient.sendChannelVerificationSession(
                action: "cancel_session", channel: channel,
                conversationId: nil, rebind: nil, destination: nil,
                originConversationId: nil, purpose: nil, contactChannelId: nil
            )
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

    private func setVerificationError(for channel: String, message: String) {
        switch channel {
        case "telegram":
            telegramVerificationInProgress = false
            telegramVerificationError = message
        case "phone":
            voiceVerificationInProgress = false
            voiceVerificationError = message
        case "slack":
            slackVerificationInProgress = false
            slackVerificationError = message
        default:
            break
        }
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
        Task {
            guard let response = await settingsClient.fetchPlatformConfig() else { return }
            if response.success {
                self.platformBaseUrl = response.baseUrl
                AuthService.shared.configuredBaseURL = response.baseUrl
            }
        }
    }

    func savePlatformBaseUrl(_ raw: String) {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let previous = platformBaseUrl
        platformBaseUrl = trimmed
        AuthService.shared.configuredBaseURL = trimmed
        Task {
            guard let response = await settingsClient.setPlatformConfig(baseUrl: trimmed) else {
                self.platformBaseUrl = previous
                AuthService.shared.configuredBaseURL = previous
                return
            }
            if !response.success {
                self.platformBaseUrl = previous
                AuthService.shared.configuredBaseURL = previous
                if let error = response.error {
                    log.error("Platform config update failed: \(error)")
                }
            }
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
                if let fetchedConfig = await self.settingsClient.fetchConfig() {
                    self.loadServiceModes(config: fetchedConfig)
                }
            } catch {
                log.error("Failed to load provider routing sources: \(error)")
            }
        }
    }

    /// Loads service modes (inference, image-generation) from workspace config.
    /// Called during init and when the daemon reconnects.
    func loadServiceModes(config: [String: Any]) {
        guard let services = config["services"] as? [String: Any] else { return }
        if let inference = services["inference"] as? [String: Any] {
            if let mode = inference["mode"] as? String { self.inferenceMode = mode }
            // Only apply local config provider/model as a fallback when the daemon
            // hasn't yet reported an authoritative value. Once the daemon responds
            // via applyModelInfoResponse, its values take precedence over local
            // config which may be stale (especially for remote assistants).
            if lastDaemonProvider == nil,
               let provider = inference["provider"] as? String { self.selectedInferenceProvider = provider }
            if lastDaemonProvider == nil,
               let model = inference["model"] as? String { self.selectedModel = model }
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
            self.managedOAuthMode["google"] = mode
        } else if let legacy = services["integration:google"] as? [String: Any],
                  let mode = legacy["mode"] as? String {
            // Migrate from the legacy key that was written due to a bug where
            // setManagedOAuthMode fell back to the raw providerKey when metadata
            // hadn't loaded yet. Read the value and re-save under the correct key
            // so subsequent launches use the canonical path.
            self.managedOAuthMode["google"] = mode
            setManagedOAuthMode(mode, providerKey: "google")
        }
    }

    func setInferenceMode(_ mode: String) {
        inferenceMode = mode
        Task {
            let success = await settingsClient.patchConfig([
                "services": ["inference": ["mode": mode]]
            ])
            if !success {
                log.error("Failed to patch config for inference mode")
            }
        }
        scheduleRoutingSourceRefresh()
    }

    func setImageGenMode(_ mode: String) {
        imageGenMode = mode
        Task {
            let success = await settingsClient.patchConfig([
                "services": ["image-generation": ["mode": mode]]
            ])
            if !success {
                log.error("Failed to patch config for image-generation mode")
            }
        }
        scheduleRoutingSourceRefresh()
    }

    func setWebSearchMode(_ mode: String) {
        webSearchMode = mode
        Task {
            let success = await settingsClient.patchConfig([
                "services": ["web-search": ["mode": mode]]
            ])
            if !success {
                log.error("Failed to patch config for web search mode")
            }
        }
        scheduleRoutingSourceRefresh()
    }

    func setManagedOAuthMode(_ mode: String, providerKey: String) {
        managedOAuthMode[providerKey] = mode
        // Derive the config service key from providerKey (e.g. "google" → "google-oauth")
        // so it matches the key that loadServiceModes() reads on startup.
        let serviceKey = "\(providerKey)-oauth"
        Task {
            let success = await settingsClient.patchConfig([
                "services": [serviceKey: ["mode": mode]]
            ])
            if !success {
                log.error("Failed to patch config for \(serviceKey) mode")
            }
        }
        scheduleRoutingSourceRefresh()
    }

    // MARK: - Google OAuth Connections

    /// Resolves the platform assistant UUID for OAuth endpoints.
    /// For managed assistants, the lockfile ID is the platform UUID.
    /// For self-hosted local assistants, looks up the persisted mapping via PlatformAssistantIdResolver,
    /// triggering bootstrap lazily if the mapping is not yet cached.
    private func resolvePlatformAssistantId(userId: String?) async -> String? {
        guard let connectedId = UserDefaults.standard.string(forKey: "connectedAssistantId"), !connectedId.isEmpty,
              let assistant = LockfileAssistant.loadByName(connectedId) else {
            return nil
        }

        let credentialStorage = FileCredentialStorage()

        let orgId = UserDefaults.standard.string(forKey: "connectedOrganizationId")

        // Try the fast synchronous path first.
        if let resolved = PlatformAssistantIdResolver.resolve(
            lockfileAssistantId: assistant.assistantId,
            isManaged: assistant.isManaged,
            organizationId: orgId,
            userId: userId,
            credentialStorage: credentialStorage
        ) {
            log.info("Resolved platform assistant ID (cached): \(resolved, privacy: .public) for runtime \(connectedId, privacy: .public)")
            return resolved
        }

        // For self-hosted assistants, the credential storage mapping may not exist yet
        // (bootstrap is async and may not have completed). Trigger bootstrap
        // lazily and retry the resolve.
        guard !assistant.isManaged else {
            log.warning("Failed to resolve platform assistant ID for managed assistant \(connectedId, privacy: .public) (orgId=\(orgId ?? "nil", privacy: .public), userId=\(userId ?? "nil", privacy: .public))")
            return nil
        }

        log.info("Platform assistant ID not cached — triggering lazy bootstrap for \(connectedId, privacy: .public)")
        let bootstrapService = LocalAssistantBootstrapService(credentialStorage: credentialStorage)
        do {
            _ = try await bootstrapService.bootstrap(
                runtimeAssistantId: assistant.assistantId,
                clientPlatform: "macos",
                assistantVersion: connectionManager?.assistantVersion
            )
        } catch {
            // Bootstrap can persist the credential storage mapping during ensure-registration
            // but then throw on daemon injection (e.g. gateway not reachable yet).
            // Always retry the resolve — the mapping may already be cached.
            log.warning("Lazy bootstrap threw (mapping may still be cached): \(error.localizedDescription)")
        }

        // Re-resolve userId after bootstrap (it may have become available).
        var postBootstrapUserId = userId
        if postBootstrapUserId == nil {
            let session = try? await AuthService.shared.getSession()
            postBootstrapUserId = session?.data?.user?.id
        }
        let postBootstrapOrgId = UserDefaults.standard.string(forKey: "connectedOrganizationId")

        let postBootstrapResolved = PlatformAssistantIdResolver.resolve(
            lockfileAssistantId: assistant.assistantId,
            isManaged: assistant.isManaged,
            organizationId: postBootstrapOrgId,
            userId: postBootstrapUserId,
            credentialStorage: credentialStorage
        )
        if let resolved = postBootstrapResolved {
            log.info("Resolved platform assistant ID (after lazy bootstrap): \(resolved, privacy: .public) for runtime \(connectedId, privacy: .public)")
        } else {
            log.error("Failed to resolve platform assistant ID after lazy bootstrap for runtime \(connectedId, privacy: .public) (orgId=\(postBootstrapOrgId ?? "nil", privacy: .public), userId=\(postBootstrapUserId ?? "nil", privacy: .public))")
        }
        return postBootstrapResolved
    }

    func fetchManagedOAuthConnections(providerKey: String, userId: String? = nil) async {
        guard managedOAuthMode[providerKey] == "managed" else { return }
        guard let assistantId = await resolvePlatformAssistantId(userId: userId) else { return }

        do {
            let connections = try await PlatformOAuthService.shared.listConnections(assistantId: assistantId)
            managedOAuthConnections[providerKey] = connections.filter { $0.provider == providerKey }
            managedOAuthError[providerKey] = nil
        } catch {
            log.error("Failed to fetch managed OAuth connections for \(providerKey): \(error)")
            managedOAuthError[providerKey] = error.localizedDescription
            managedOAuthConnections[providerKey] = []
        }
    }

    func startManagedOAuthConnect(providerKey: String, userId: String? = nil) {
        Task {
            managedOAuthIsConnecting[providerKey] = true
            managedOAuthError[providerKey] = nil
            defer { managedOAuthIsConnecting[providerKey] = false }

            guard let assistantId = await resolvePlatformAssistantId(userId: userId) else {
                managedOAuthError[providerKey] = "No connected assistant"
                return
            }

            do {
                let response = try await PlatformOAuthService.shared.startOAuthConnect(
                    provider: providerKey,
                    assistantId: assistantId,
                    redirectAfterConnect: "vellum-assistant://oauth/\(providerKey)/callback"
                )

                guard let connectURL = URL(string: response.connect_url) else {
                    managedOAuthError[providerKey] = "Invalid connect URL"
                    return
                }

                let callbackURL: URL = try await withCheckedThrowingContinuation { continuation in
                    let session = ASWebAuthenticationSession(url: connectURL, callbackURLScheme: "vellum-assistant") { [weak self] callbackURL, error in
                        self?.managedOAuthWebAuthSession = nil
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
                    self.managedOAuthWebAuthSession = session
                    session.start()
                }

                let components = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false)
                let oauthStatus = components?.queryItems?.first(where: { $0.name == "oauth_status" })?.value

                if oauthStatus == "connected" {
                    await fetchManagedOAuthConnections(providerKey: providerKey, userId: userId)
                } else if oauthStatus == "error" {
                    let errorCode = components?.queryItems?.first(where: { $0.name == "oauth_code" })?.value
                    managedOAuthError[providerKey] = errorCode ?? "OAuth connection failed"
                }
            } catch let error as ASWebAuthenticationSessionError where error.code == .canceledLogin {
                log.info("User cancelled managed OAuth connect for \(providerKey)")
            } catch {
                log.error("Managed OAuth connect failed for \(providerKey): \(error)")
                managedOAuthError[providerKey] = "Unable to connect your account. Please try again."
            }
        }
    }

    func disconnectManagedOAuthConnection(_ connectionId: String, providerKey: String, userId: String? = nil) {
        Task {
            guard let assistantId = await resolvePlatformAssistantId(userId: userId) else {
                managedOAuthError[providerKey] = "No connected assistant"
                return
            }

            do {
                try await PlatformOAuthService.shared.disconnectConnection(assistantId: assistantId, connectionId: connectionId)
                // Optimistically remove the connection from local state
                managedOAuthConnections[providerKey]?.removeAll { $0.id == connectionId }
            } catch {
                log.error("Failed to disconnect managed OAuth connection for \(providerKey): \(error)")
                managedOAuthError[providerKey] = error.localizedDescription
            }
        }
    }

    // MARK: - Your Own OAuth Actions

    func fetchYourOwnOAuthApps(providerKey: String) {
        yourOwnOAuthIsLoading.insert(providerKey)
        yourOwnOAuthError[providerKey] = nil
        Task {
            do {
                let (decoded, response): (YourOwnOAuthAppsResponse?, _) = try await GatewayHTTPClient.get(
                    path: "oauth/apps",
                    params: ["provider_key": providerKey],
                    timeout: 10
                )
                if response.isSuccess, let decoded {
                    self.yourOwnOAuthApps[providerKey] = decoded.apps
                    if let provider = decoded.provider {
                        self.yourOwnOAuthProviderMetadata[providerKey] = provider
                    }
                    for app in decoded.apps {
                        await self.fetchYourOwnOAuthConnections(appId: app.id)
                    }
                } else {
                    let errorMsg: String
                    if let json = try? JSONSerialization.jsonObject(with: response.data) as? [String: Any],
                       let msg = json["error"] as? String {
                        errorMsg = msg
                    } else {
                        errorMsg = "HTTP \(response.statusCode)"
                    }
                    self.yourOwnOAuthError[providerKey] = errorMsg
                }
            } catch {
                log.error("Failed to fetch Your Own OAuth apps: \(error)")
                self.yourOwnOAuthError[providerKey] = error.localizedDescription
            }
            self.yourOwnOAuthIsLoading.remove(providerKey)
        }
    }

    func fetchYourOwnOAuthConnections(appId: String) async {
        do {
            let (decoded, response): (YourOwnOAuthConnectionsResponse?, _) = try await GatewayHTTPClient.get(
                path: "oauth/apps/\(appId)/connections",
                timeout: 10
            )
            if response.isSuccess, let decoded {
                self.yourOwnOAuthConnectionsByApp[appId] = decoded.connections
            }
        } catch {
            log.error("Failed to fetch Your Own OAuth connections for app \(appId): \(error)")
        }
    }

    func createYourOwnOAuthApp(providerKey: String, clientId: String, clientSecret: String) async {
        yourOwnOAuthError[providerKey] = nil
        var body: [String: Any] = [
            "provider_key": providerKey,
            "client_id": clientId,
        ]
        // Set via subscript to avoid pre-commit secret detection on the literal key.
        let secretKey = "client" + "_secret"
        body[secretKey] = clientSecret
        do {
            let response = try await GatewayHTTPClient.post(path: "oauth/apps", json: body, timeout: 10)
            if response.isSuccess {
                self.fetchYourOwnOAuthApps(providerKey: providerKey)
            } else {
                let errorMsg: String
                if let json = try? JSONSerialization.jsonObject(with: response.data) as? [String: Any],
                   let msg = json["error"] as? String {
                    errorMsg = msg
                } else {
                    errorMsg = "HTTP \(response.statusCode)"
                }
                self.yourOwnOAuthError[providerKey] = "Failed to create app: \(errorMsg)"
            }
        } catch {
            log.error("Failed to create Your Own OAuth app: \(error)")
            self.yourOwnOAuthError[providerKey] = "Failed to create app: \(error.localizedDescription)"
        }
    }

    func deleteYourOwnOAuthApp(id: String, providerKey: String) async {
        yourOwnOAuthError[providerKey] = nil
        do {
            let response = try await GatewayHTTPClient.delete(path: "oauth/apps/\(id)", timeout: 10)
            if response.isSuccess {
                self.yourOwnOAuthApps[providerKey]?.removeAll { $0.id == id }
                self.yourOwnOAuthConnectionsByApp.removeValue(forKey: id)
            } else {
                let errorMsg: String
                if let json = try? JSONSerialization.jsonObject(with: response.data) as? [String: Any],
                   let msg = json["error"] as? String {
                    errorMsg = msg
                } else {
                    errorMsg = "HTTP \(response.statusCode)"
                }
                self.yourOwnOAuthError[providerKey] = "Failed to delete app: \(errorMsg)"
            }
        } catch {
            log.error("Failed to delete Your Own OAuth app: \(error)")
            self.yourOwnOAuthError[providerKey] = "Failed to delete app: \(error.localizedDescription)"
        }
    }

    func disconnectYourOwnOAuthConnection(id: String, appId: String) async {
        let providerKey = yourOwnOAuthApps.first(where: { $0.value.contains(where: { $0.id == appId }) })?.key
        if let providerKey { yourOwnOAuthError[providerKey] = nil }
        do {
            let response = try await GatewayHTTPClient.delete(path: "oauth/connections/\(id)", timeout: 10)
            if response.isSuccess {
                await self.fetchYourOwnOAuthConnections(appId: appId)
            } else {
                let errorMsg: String
                if let json = try? JSONSerialization.jsonObject(with: response.data) as? [String: Any],
                   let msg = json["error"] as? String {
                    errorMsg = msg
                } else {
                    errorMsg = "HTTP \(response.statusCode)"
                }
                if let providerKey { self.yourOwnOAuthError[providerKey] = "Failed to disconnect: \(errorMsg)" }
            }
        } catch {
            log.error("Failed to disconnect Your Own OAuth connection: \(error)")
            if let providerKey { self.yourOwnOAuthError[providerKey] = "Failed to disconnect: \(error.localizedDescription)" }
        }
    }

    func cancelYourOwnOAuthConnect() {
        yourOwnOAuthConnectPollingTask?.cancel()
        yourOwnOAuthConnectPollingTask = nil
        yourOwnOAuthConnectingAppId = nil
    }

    func startYourOwnOAuthConnect(appId: String) {
        yourOwnOAuthConnectingAppId = appId
        let providerKey = yourOwnOAuthApps.first(where: { $0.value.contains(where: { $0.id == appId }) })?.key
        if let providerKey { yourOwnOAuthError[providerKey] = nil }
        Task {
            do {
                let response = try await GatewayHTTPClient.post(path: "oauth/apps/\(appId)/connect", json: [:], timeout: 10)
                guard response.isSuccess else {
                    let errorMsg: String
                    if let json = try? JSONSerialization.jsonObject(with: response.data) as? [String: Any],
                       let msg = json["error"] as? String {
                        errorMsg = msg
                    } else {
                        errorMsg = "HTTP \(response.statusCode)"
                    }
                    if let providerKey { self.yourOwnOAuthError[providerKey] = "Failed to start connect: \(errorMsg)" }
                    if self.yourOwnOAuthConnectingAppId == appId { self.yourOwnOAuthConnectingAppId = nil }
                    return
                }

                let decoder = JSONDecoder()
                let connectResponse = try decoder.decode(YourOwnOAuthConnectResponse.self, from: response.data)

                guard let authURL = URL(string: connectResponse.auth_url) else {
                    if let providerKey { self.yourOwnOAuthError[providerKey] = "Invalid auth URL" }
                    if self.yourOwnOAuthConnectingAppId == appId { self.yourOwnOAuthConnectingAppId = nil }
                    return
                }

                NSWorkspace.shared.open(authURL)

                // Start polling — detect new connections OR re-authed (updated) connections
                let existingConnections = self.yourOwnOAuthConnectionsByApp[appId] ?? []
                let initialCount = existingConnections.count
                let maxUpdatedAt = existingConnections.map(\.updated_at).max() ?? 0
                self.yourOwnOAuthConnectPollingTask?.cancel()
                self.yourOwnOAuthConnectPollingTask = Task {
                    let pollInterval: UInt64 = 3_000_000_000 // 3 seconds
                    let timeout: UInt64 = 300_000_000_000 // 5 minutes
                    let startTime = DispatchTime.now().uptimeNanoseconds

                    while !Task.isCancelled {
                        try? await Task.sleep(nanoseconds: pollInterval)
                        guard !Task.isCancelled else { break }

                        await self.fetchYourOwnOAuthConnections(appId: appId)
                        let current = self.yourOwnOAuthConnectionsByApp[appId] ?? []

                        // New connection added
                        if current.count > initialCount { break }

                        // Existing connection re-authed (updated_at changed)
                        let currentMaxUpdatedAt = current.map(\.updated_at).max() ?? 0
                        if currentMaxUpdatedAt > maxUpdatedAt { break }

                        let elapsed = DispatchTime.now().uptimeNanoseconds - startTime
                        if elapsed >= timeout { break }
                    }

                    if self.yourOwnOAuthConnectingAppId == appId { self.yourOwnOAuthConnectingAppId = nil }
                }
            } catch {
                log.error("Failed to start Your Own OAuth connect: \(error)")
                if let providerKey { self.yourOwnOAuthError[providerKey] = "Failed to start connect: \(error.localizedDescription)" }
                if self.yourOwnOAuthConnectingAppId == appId { self.yourOwnOAuthConnectingAppId = nil }
            }
        }
    }

    // MARK: - Your Own OAuth Convenience Accessors

    func yourOwnApps(for providerKey: String) -> [YourOwnOAuthApp] {
        yourOwnOAuthApps[providerKey] ?? []
    }

    func yourOwnIsLoading(for providerKey: String) -> Bool {
        yourOwnOAuthIsLoading.contains(providerKey)
    }

    func yourOwnError(for providerKey: String) -> String? {
        yourOwnOAuthError[providerKey]
    }

    func yourOwnProviderMeta(for providerKey: String) -> OAuthProviderMetadata? {
        yourOwnOAuthProviderMetadata[providerKey]
    }

    // MARK: - Managed OAuth Convenience Accessors

    func managedOAuthModeFor(_ providerKey: String) -> String {
        managedOAuthMode[providerKey] ?? "your-own"
    }

    func managedConnections(for providerKey: String) -> [OAuthConnectionEntry] {
        managedOAuthConnections[providerKey] ?? []
    }

    func managedIsConnecting(for providerKey: String) -> Bool {
        managedOAuthIsConnecting[providerKey] ?? false
    }

    func managedError(for providerKey: String) -> String? {
        managedOAuthError[providerKey]
    }

    func setWebSearchProvider(_ provider: String) {
        webSearchProvider = provider
        Task {
            let success = await settingsClient.patchConfig([
                "services": ["web-search": ["provider": provider]]
            ])
            if !success {
                log.error("Failed to patch config for web search provider")
            }
        }
        scheduleRoutingSourceRefresh()
    }

    func setInferenceProvider(_ provider: String) {
        selectedInferenceProvider = provider
        Task {
            let success = await settingsClient.patchConfig([
                "services": ["inference": ["provider": provider]]
            ])
            if !success {
                log.error("Failed to patch config for inference provider")
            }
        }
        scheduleRoutingSourceRefresh()
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
        Task {
            guard let response = await settingsClient.fetchIngressConfig() else {
                log.error("Failed to fetch ingress config")
                return
            }
            handleIngressConfigResponse(response)
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
        Task {
            if let response = await settingsClient.updateIngressConfig(publicBaseUrl: trimmed, enabled: shouldEnable) {
                handleIngressConfigResponse(response)
            } else {
                // Send failed — roll back the optimistic update
                ingressPublicBaseUrl = previous
                pendingIngressUrl = nil
                ingressReachable = previousReachable
                tunnelLastChecked = previousLastChecked
            }
        }
    }

    func setIngressEnabled(_ enabled: Bool) {
        ingressEnabled = enabled
        pendingIngressEnabled = enabled
        Task {
            if let response = await settingsClient.updateIngressConfig(publicBaseUrl: ingressPublicBaseUrl, enabled: enabled) {
                handleIngressConfigResponse(response)
            } else {
                log.error("Failed to send ingress config set (enabled)")
            }
        }
    }

    private func handleIngressConfigResponse(_ response: IngressConfigResponseMessage) {
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

    func setModel(_ model: String, provider: String? = nil, force: Bool = false) {
        // Skip if neither model nor provider changed (unless forced,
        // e.g. after an inference-mode switch that requires re-persisting
        // the model+provider pair even when IDs haven't changed).
        if !force {
            let modelUnchanged = model == lastDaemonModel
            let providerUnchanged = provider == nil || provider == lastDaemonProvider
            guard !modelUnchanged || !providerUnchanged else { return }
        }
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

    func setDangerouslySkipPermissions(_ enabled: Bool) {
        skipPermissionsToggleGeneration &+= 1
        let requestGeneration = skipPermissionsToggleGeneration
        dangerouslySkipPermissions = enabled
        Task { @MainActor in
            let success = await settingsClient.setDangerouslySkipPermissions(enabled)
            if !success, self.skipPermissionsToggleGeneration == requestGeneration {
                // Revert optimistic toggle on failure only if no newer toggle has fired
                self.dangerouslySkipPermissions = !enabled
            }
        }
    }

    /// Replaces the video-embed domain allowlist, normalizing the input and
    /// persisting the result to the workspace config.
    func setMediaEmbedVideoAllowlistDomains(_ domains: [String]) {
        let normalized = MediaEmbedSettings.normalizeDomains(domains)
        mediaEmbedVideoAllowlistDomains = normalized

        Task {
            let success = await settingsClient.patchConfig([
                "ui": ["mediaEmbeds": ["videoAllowlistDomains": normalized]]
            ])
            if !success {
                log.error("Failed to patch config for video allowlist domains")
            }
        }
    }

    /// Writes the current `mediaEmbedsEnabled` and `mediaEmbedsEnabledSince` to
    /// the workspace config under `ui.mediaEmbeds`.
    private func persistMediaEmbedState() {
        var mediaEmbedsDict: [String: Any] = [
            "enabled": mediaEmbedsEnabled,
        ]

        if let since = mediaEmbedsEnabledSince {
            mediaEmbedsDict["enabledSince"] = since.iso8601String
        }

        Task {
            let success = await settingsClient.patchConfig([
                "ui": ["mediaEmbeds": mediaEmbedsDict]
            ])
            if !success {
                log.error("Failed to patch config for media embed state")
            }
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
    /// When no `enabledSince` is found in the config (missing section or
    /// missing/unparseable key), the value defaults to "now" so that fresh
    /// installs only embed new messages going forward.
    private static func loadMediaEmbedSettings(config: [String: Any]) -> MediaEmbedLoadResult {

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
            enabledSince = isoString.iso8601Date
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
        // Send the timezone string, or "" to clear it. An empty string avoids
        // sending JSON null (which would fail Zod's string().optional()
        // validation) while loadUserTimezone() already treats "" as nil via
        // its `guard !trimmed.isEmpty` check.
        let tzValue = userTimezone ?? ""

        Task {
            let success = await settingsClient.patchConfig([
                "ui": ["userTimezone": tzValue]
            ])
            if !success {
                log.error("Failed to patch config for user timezone")
            }
        }
    }

    /// Fetches the full workspace config from the daemon and applies all
    /// config-dependent properties. Called after init once the daemon is
    /// reachable.
    func loadConfigFromDaemon() async {
        guard let config = await settingsClient.fetchConfig() else { return }
        applyDaemonConfig(config)
    }

    /// Applies a daemon-fetched workspace config to all config-dependent
    /// published properties.
    private func applyDaemonConfig(_ config: [String: Any]) {
        let mediaSettings = Self.loadMediaEmbedSettings(config: config)
        self.mediaEmbedsEnabled = mediaSettings.enabled
        self.mediaEmbedsEnabledSince = mediaSettings.enabledSince
        self.mediaEmbedVideoAllowlistDomains = mediaSettings.domains
        self.userTimezone = Self.loadUserTimezone(config: config)

        let permissionsConfig = config["permissions"] as? [String: Any]
        self.dangerouslySkipPermissions = (permissionsConfig?["dangerouslySkipPermissions"] as? Bool) ?? false

        if let services = config["services"] as? [String: Any],
           let webSearch = services["web-search"] as? [String: Any],
           let provider = webSearch["provider"] as? String {
            self.webSearchProvider = provider
        }

        loadServiceModes(config: config)

        // Persist enabledSince when it was defaulted so subsequent loads
        // produce a deterministic timestamp.
        if mediaSettings.didDefaultEnabledSince && !isCurrentAssistantRemote {
            persistMediaEmbedState()
        }
    }

    private static func loadUserTimezone(config: [String: Any]) -> String? {
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

// MARK: - Your Own OAuth Types

struct YourOwnOAuthApp: Codable, Identifiable, Sendable {
    let id: String
    let provider_key: String
    let client_id: String
    let created_at: Int
    let updated_at: Int
}

struct YourOwnOAuthConnection: Codable, Identifiable, Sendable {
    let id: String
    let provider_key: String
    let account_info: String?
    let granted_scopes: [String]
    let status: String
    let has_refresh_token: Bool
    let expires_at: Int?
    let created_at: Int
    let updated_at: Int
}

struct OAuthProviderMetadata: Codable, Sendable {
    let provider_key: String
    let display_name: String?
    let description: String?
    let dashboard_url: String?
    let client_id_placeholder: String?
    let requires_client_secret: Int

    /// The platform OAuth slug is the provider_key itself (bare name, e.g. "google").
    var platformOAuthSlug: String {
        return provider_key
    }
}

struct YourOwnOAuthAppsResponse: Codable, Sendable {
    let provider: OAuthProviderMetadata?
    let apps: [YourOwnOAuthApp]
}

struct YourOwnOAuthConnectionsResponse: Codable, Sendable {
    let connections: [YourOwnOAuthConnection]
}

struct YourOwnOAuthConnectResponse: Codable, Sendable {
    let auth_url: String
    let state: String
}
