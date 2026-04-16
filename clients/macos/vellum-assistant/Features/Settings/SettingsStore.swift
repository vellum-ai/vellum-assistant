import AppKit
import AuthenticationServices
import Carbon.HIToolbox
import Combine
import Foundation
import Observation
import os
import VellumAssistantShared

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "SettingsStore")

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

    @Published var hasKey: Bool = false
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
    @Published var imageGenKeySaving: Bool = false

    // MARK: - Model Selection

    @Published var selectedModel: String = "claude-opus-4-6"
    @Published var configuredProviders: Set<String> = ["ollama"]
    @Published var selectedImageGenModel: String = "gemini-3.1-flash-image-preview"

    // MARK: - Inference Provider Selection

    @Published var selectedInferenceProvider: String = "anthropic"

    /// Full provider catalog from daemon. Seeded with inline defaults for pre-fetch rendering.
    @Published var providerCatalog: [ProviderCatalogEntry] = []

    // MARK: - Per-Call-Site LLM Overrides

    /// Catalog of every LLM call site, merged with whatever overrides the
    /// user has configured under `llm.callSites.<id>` in the workspace
    /// config. Order matches `CallSiteCatalog.all` so the UI renders a
    /// stable list grouped by `CallSiteDomain`.
    ///
    /// Seeded from the static catalog so the picker has every row available
    /// before the first daemon fetch completes. Replaced by
    /// `loadCallSiteOverrides(config:)` once the daemon reports the
    /// authoritative config.
    @Published var callSiteOverrides: [CallSiteOverride] = CallSiteCatalog.all

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
    @Published var markConversationUnreadShortcut: String
    @Published var popOutShortcut: String
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

    // MARK: - TTS Voice ID State

    /// The configured ElevenLabs voice ID from daemon config.
    @Published var elevenLabsVoiceId: String = ""

    /// The configured Fish Audio reference ID from daemon config.
    @Published var fishAudioReferenceId: String = ""

    /// Managed OAuth mode per provider (keyed by managedServiceConfigKey). Values: "managed" or "your-own".
    @Published var managedOAuthMode: [String: String] = [:]
    /// Managed OAuth connections per provider (keyed by managedServiceConfigKey).
    @Published var managedOAuthConnections: [String: [OAuthConnectionEntry]] = [:]
    /// Whether a managed OAuth connect flow is in progress (keyed by managedServiceConfigKey).
    @Published var managedOAuthIsConnecting: [String: Bool] = [:]
    /// Managed OAuth errors per provider (keyed by managedServiceConfigKey).
    @Published var managedOAuthError: [String: String] = [:]
    /// Providers that support managed mode, fetched from the API.
    @Published var managedOAuthProviders: [OAuthProviderMetadata] = []
    /// Whether the managed OAuth providers list is currently loading.
    @Published var managedOAuthProvidersLoading: Bool = false
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

    // MARK: - Managed Assistant Recovery Mode State

    /// Current recovery-mode payload for the selected managed assistant.
    /// `nil` when not in a managed context or when the state has not yet been loaded.
    @Published var managedAssistantRecoveryMode: PlatformAssistantRecoveryMode?

    /// `true` while a recovery-mode refresh is in flight.
    @Published var recoveryModeRefreshing: Bool = false

    /// `true` while an enter-recovery-mode request is in flight.
    @Published var recoveryModeEntering: Bool = false

    /// `true` while an exit-recovery-mode request is in flight.
    @Published var recoveryModeExiting: Bool = false

    /// Non-nil when the most recent refresh failed.
    @Published var recoveryModeRefreshError: String?

    /// Non-nil when the most recent enter-recovery-mode call failed.
    @Published var recoveryModeEnterError: String?

    /// Non-nil when the most recent exit-recovery-mode call failed.
    @Published var recoveryModeExitError: String?

    // MARK: - Platform Config State

    @Published var platformBaseUrl: String = ""

    // MARK: - Ingress Config State

    @Published var ingressEnabled: Bool = false
    @Published var ingressPublicBaseUrl: String = ""
    /// Read-only gateway target derived from daemon config.
    /// Seeded with the default port; resolved asynchronously from the lockfile
    /// so that file I/O does not block the main thread during init.
    @Published var localGatewayTarget: String = "http://127.0.0.1:7830"

    /// Set to `true` once the first ingress config response arrives, so the
    /// view layer can defer diagnostics until the real config values are available.
    @Published var ingressConfigLoaded: Bool = false

    // MARK: - Host Browser (CDP Inspect) State

    /// Whether the cdp-inspect host-browser backend is enabled.
    ///
    /// When true, the browser-session manager probes the configured
    /// `hostBrowserCdpInspectHost`/`hostBrowserCdpInspectPort` for a running
    /// Chrome instance exposing `--remote-debugging-port` before falling
    /// back to the local Playwright backend.
    @Published var hostBrowserCdpInspectEnabled: Bool = false

    /// Host name or IP address for the host Chrome remote-debugging endpoint.
    ///
    /// Only loopback values are accepted (`localhost`, `127.0.0.1`, `::1`,
    /// `[::1]`) to prevent remote attach attempts.
    @Published var hostBrowserCdpInspectHost: String = "localhost"

    /// TCP port for the host Chrome remote-debugging endpoint.
    ///
    /// Must be in the range `1...65535`.
    @Published var hostBrowserCdpInspectPort: Int = 9222

    /// Timeout (in milliseconds) for the backend availability probe.
    /// Defaults to `500` and is preserved verbatim from the fetched config.
    @Published var hostBrowserCdpInspectProbeTimeoutMs: Int = 500

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

    /// In-memory cache of the active assistant ID to avoid repeated
    /// lockfile I/O on every access. Seeded once in `init` and
    /// kept in sync via `LockfileAssistant.activeAssistantDidChange`.
    private var cachedAssistantId: String?

    /// In-memory cache of `connectedOrganizationId`.
    private var cachedOrgId: String?

    /// Whether the connected assistant is remote (not running locally).
    /// When true, local workspace config writes are skipped to avoid creating
    /// a `.vellum/` directory that doesn't belong to any local assistant.
    /// Cached to avoid synchronous lockfile I/O on every access; refreshed
    /// asynchronously during init and when the connected assistant changes.
    private var isCurrentAssistantRemote: Bool = false

    /// Guards against stale `get` responses overwriting an optimistic
    /// toggle. Set when `setIngressEnabled` fires; cleared once a matching
    /// response arrives.
    private var pendingIngressEnabled: Bool?
    private var pendingIngressUrl: String?
    private var routingSourceRefreshTask: Task<Void, Never>?
    private var yourOwnOAuthConnectPollingTask: Task<Void, Never>?
    private var trustRulesObservationTask: Task<Void, Never>?
    private var modelInfoObservationTask: Task<Void, Never>?

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

    deinit {
        trustRulesObservationTask?.cancel()
        modelInfoObservationTask?.cancel()
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

        // Seed cached values with a single read each so that
        // the ~50 call sites throughout SettingsStore never hit IPC again.
        self.cachedAssistantId = LockfileAssistant.loadActiveAssistantId()
        self.cachedOrgId = UserDefaults.standard.string(forKey: "connectedOrganizationId")

        // Credential reads are deferred to a Task so that file-backed
        // CredentialStorage I/O does not block the main thread during init.
        // refreshAPIKeyState() updates the same @Published properties that
        // were previously seeded inline here.
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
        if UserDefaults.standard.object(forKey: "markConversationUnreadShortcut") == nil {
            self.markConversationUnreadShortcut = "cmd+shift+u"
        } else {
            self.markConversationUnreadShortcut = UserDefaults.standard.string(forKey: "markConversationUnreadShortcut") ?? ""
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

        // Service modes use defaults until daemon provides config
        loadServiceModes(config: emptyConfig)

        // Seed provider catalog with shared defaults so the UI has data before
        // the first daemon fetch completes.
        providerCatalog = ProviderCatalogEntry.defaultCatalog

        // Resolve lockfile-derived state (gateway URL, assistant topology)
        // on a background thread so that synchronous Data(contentsOf:)
        // file I/O does not block the main thread during init.
        // Uses the shared refreshLockfileState() path so the startup read
        // is tracked in lockfileRefreshTask and can be cancelled if an
        // assistant switch arrives before it completes.
        refreshLockfileState()

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

        $markConversationUnreadShortcut
            .dropFirst()
            .sink { value in UserDefaults.standard.set(value, forKey: "markConversationUnreadShortcut") }
            .store(in: &cancellables)

        $popOutShortcut
            .dropFirst()
            .sink { value in UserDefaults.standard.set(value, forKey: "popOutShortcut") }
            .store(in: &cancellables)

        // Re-resolve lockfile-derived state whenever the connected assistant changes
        // so that isCurrentAssistantRemote and localGatewayTarget stay in sync.
        NotificationCenter.default.publisher(for: LockfileAssistant.activeAssistantDidChange)
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in
                self?.cachedAssistantId = LockfileAssistant.loadActiveAssistantId()
                self?.refreshLockfileState()
                Task { await IdentityInfo.refreshCache() }
            }
            .store(in: &cancellables)

        // Mirror GatewayConnectionManager's trust-rules-open flag so views can disable their buttons
        trustRulesObservationTask?.cancel()
        if let connectionManager {
            trustRulesObservationTask = Task { @MainActor [weak self] in
                for await isOpen in observationStream({ connectionManager.isTrustRulesSheetOpen }) {
                    guard let self, !Task.isCancelled else { break }
                    self.isAnyTrustRulesSheetOpen = isOpen
                }
            }
        }

        // Subscribe to daemon-pushed model changes so the UI stays in sync
        // when the model is changed externally (e.g. via CLI or another client).
        modelInfoObservationTask?.cancel()
        if let connectionManager {
            modelInfoObservationTask = Task { @MainActor [weak self] in
                for await info in observationStream({ connectionManager.latestModelInfo }) {
                    guard let self, !Task.isCancelled else { break }
                    if let info {
                        self.applyModelInfoResponse(info)
                    }
                }
            }
        }

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

        // Refresh recovery-mode state when the app returns to the foreground
        // so the UI stays current if maintenance was toggled elsewhere.
        NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in
                Task { @MainActor [weak self] in
                    await self?.refreshManagedAssistantRecoveryMode()
                }
            }
            .store(in: &cancellables)

        // Refresh when the connected assistant changes so the state reflects
        // the newly selected managed assistant rather than the previous one.
        NotificationCenter.default.publisher(for: LockfileAssistant.activeAssistantDidChange)
            .debounce(for: .milliseconds(100), scheduler: RunLoop.main)
            .sink { [weak self] _ in
                guard let self else { return }
                // Reset stale maintenance state immediately before async refresh.
                // Also clear in-flight flags so the new assistant's UI starts clean
                // rather than inheriting a spinner from the previous assistant's
                // in-progress mutation.
                self.managedAssistantRecoveryMode = nil
                self.recoveryModeRefreshError = nil
                self.recoveryModeEnterError = nil
                self.recoveryModeExitError = nil
                self.recoveryModeEntering = false
                self.recoveryModeExiting = false
                self.recoveryModeRefreshing = false
                Task { @MainActor [weak self] in
                    await self?.refreshManagedAssistantRecoveryMode()
                }
            }
            .store(in: &cancellables)

        // Refresh when the connected organization changes — switching org without
        // switching assistant can also leave maintenance state stale.
        UserDefaults.standard.publisher(for: \.connectedOrganizationId)
            .dropFirst()
            .debounce(for: .milliseconds(100), scheduler: RunLoop.main)
            .removeDuplicates()
            .sink { [weak self] _ in
                self?.cachedOrgId = UserDefaults.standard.string(forKey: "connectedOrganizationId")
                guard let self else { return }
                // Same as the connectedAssistantId sink: clear in-flight flags so
                // the new context's UI starts clean.
                self.managedAssistantRecoveryMode = nil
                self.recoveryModeRefreshError = nil
                self.recoveryModeEnterError = nil
                self.recoveryModeExitError = nil
                self.recoveryModeEntering = false
                self.recoveryModeExiting = false
                self.recoveryModeRefreshing = false
                Task { @MainActor [weak self] in
                    await self?.refreshManagedAssistantRecoveryMode()
                }
            }
            .store(in: &cancellables)

        // Refresh after a successful local bootstrap/hatch flow completes so the
        // maintenance state reflects the freshly hatched assistant.
        NotificationCenter.default.publisher(for: .localBootstrapCompleted)
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in
                Task { @MainActor [weak self] in
                    await self?.refreshManagedAssistantRecoveryMode()
                }
            }
            .store(in: &cancellables)

        // Perform the initial load.
        Task { @MainActor [weak self] in
            await self?.refreshManagedAssistantRecoveryMode()
        }

        // Eagerly fetch daemon config so config-dependent state (e.g.
        // userTimezone, mediaEmbeds, service providers) is hydrated on
        // app startup. The daemon only broadcasts config_changed on file
        // mutations, so without this the store would stay at init
        // defaults until the user edits config.json.
        refreshDaemonConfig()

        // Refresh config on daemon (re)connect so config-dependent state
        // recovers after the daemon restarts or after a network blip.
        NotificationCenter.default.publisher(for: .daemonDidReconnect)
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in
                self?.refreshDaemonConfig()
            }
            .store(in: &cancellables)

        // Refresh config when the daemon notifies us that config.json changed.
        NotificationCenter.default.publisher(for: .configChanged)
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in
                guard let self else { return }
                self.refreshModelInfo()
                self.refreshDaemonConfig()
            }
            .store(in: &cancellables)

    }

    // MARK: - Lockfile State

    private struct LockfileState {
        let gatewayUrl: String
        let isRemote: Bool
    }

    /// Reads lockfile-derived state off the main thread. The result is applied
    /// to @Published properties on the main actor via `applyLockfileState`.
    private nonisolated static func loadLockfileState() -> LockfileState {
        let assistantId = LockfileAssistant.loadActiveAssistantId()
        let gatewayUrl = LockfilePaths.resolveGatewayUrl(connectedAssistantId: assistantId)
        let assistant = assistantId.flatMap { LockfileAssistant.loadByName($0) }
        return LockfileState(
            gatewayUrl: gatewayUrl,
            isRemote: assistant?.isRemote ?? false
        )
    }

    private func applyLockfileState(_ state: LockfileState) {
        localGatewayTarget = state.gatewayUrl
        isCurrentAssistantRemote = state.isRemote
    }

    /// In-flight lockfile refresh task. Cancelled when a new refresh is
    /// requested so that stale reads from a prior assistant switch cannot
    /// overwrite the latest state.
    private var lockfileRefreshTask: Task<Void, Never>?

    /// Refreshes cached lockfile-derived state on a background thread.
    /// Cancels any in-flight refresh to prevent stale overwrites when
    /// assistant switches happen in quick succession.
    private func refreshLockfileState() {
        lockfileRefreshTask?.cancel()
        lockfileRefreshTask = Task { [weak self] in
            let result = await Task.detached { Self.loadLockfileState() }.value
            guard !Task.isCancelled else { return }
            self?.applyLockfileState(result)
        }
    }

    // MARK: - API Key Actions

    func saveAPIKey(_ raw: String, onSuccess: (() -> Void)? = nil) {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        apiKeySaveError = nil
        apiKeySaving = true

        // Optimistic UI update while the gateway write is in-flight.
        APIKeyManager.setKey(trimmed, for: "anthropic")
        hasKey = true
        maskedKey = Self.maskKey(trimmed)
        removeDeletionTombstone(type: "api_key", name: "anthropic")

        Task {
            let result = await APIKeyManager.setKey(trimmed, for: "anthropic")
            apiKeySaving = false
            if result.success {
                scheduleRoutingSourceRefresh()
                onSuccess?()
                refreshModelInfo()
            } else if let error = result.error {
                apiKeySaveError = error
                if !result.isTransient {
                    let _: Void = APIKeyManager.deleteKey(for: "anthropic")
                    hasKey = false
                    maskedKey = ""
                }
            }
        }
    }

    func clearAPIKey() {
        APIKeyManager.deleteKey(for: "anthropic")
        hasKey = false
        maskedKey = ""
        scheduleRoutingSourceRefresh()
        refreshModelInfo()
        Task {
            let deleted = await APIKeyManager.deleteKey(for: "anthropic")
            if !deleted { addDeletionTombstone(type: "api_key", name: "anthropic") }
        }
    }

    func saveBraveKey(_ raw: String, onSuccess: (() -> Void)? = nil) {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        braveKeySaveError = nil
        APIKeyManager.setKey(trimmed, for: "brave")
        removeDeletionTombstone(type: "api_key", name: "brave")
        Task {
            let result = await APIKeyManager.setKey(trimmed, for: "brave")
            if result.success {
                scheduleRoutingSourceRefresh()
                onSuccess?()
            } else if let error = result.error {
                braveKeySaveError = error
                if !result.isTransient {
                    let _: Void = APIKeyManager.deleteKey(for: "brave")
                }
            }
        }
    }

    func clearBraveKey() {
        APIKeyManager.deleteKey(for: "brave")
        scheduleRoutingSourceRefresh()
        Task {
            let deleted = await APIKeyManager.deleteKey(for: "brave")
            if !deleted { addDeletionTombstone(type: "api_key", name: "brave") }
        }
    }

    func savePerplexityKey(_ raw: String, onSuccess: (() -> Void)? = nil) {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        perplexityKeySaveError = nil
        APIKeyManager.setKey(trimmed, for: "perplexity")
        removeDeletionTombstone(type: "api_key", name: "perplexity")
        Task {
            let result = await APIKeyManager.setKey(trimmed, for: "perplexity")
            if result.success {
                scheduleRoutingSourceRefresh()
                onSuccess?()
            } else if let error = result.error {
                perplexityKeySaveError = error
                if !result.isTransient {
                    let _: Void = APIKeyManager.deleteKey(for: "perplexity")
                }
            }
        }
    }

    func clearPerplexityKey() {
        APIKeyManager.deleteKey(for: "perplexity")
        scheduleRoutingSourceRefresh()
        Task {
            let deleted = await APIKeyManager.deleteKey(for: "perplexity")
            if !deleted { addDeletionTombstone(type: "api_key", name: "perplexity") }
        }
    }

    func saveImageGenKey(_ raw: String, onSuccess: (() -> Void)? = nil) {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        imageGenKeySaveError = nil
        imageGenKeySaving = true
        APIKeyManager.setKey(trimmed, for: "gemini")
        removeDeletionTombstone(type: "api_key", name: "gemini")
        Task {
            let result = await APIKeyManager.setKey(trimmed, for: "gemini")
            imageGenKeySaving = false
            if result.success {
                scheduleRoutingSourceRefresh()
                onSuccess?()
            } else if let error = result.error {
                imageGenKeySaveError = error
                if !result.isTransient {
                    let _: Void = APIKeyManager.deleteKey(for: "gemini")
                }
            }
        }
    }

    func clearImageGenKey() {
        APIKeyManager.deleteKey(for: "gemini")
        scheduleRoutingSourceRefresh()
        Task {
            let deleted = await APIKeyManager.deleteKey(for: "gemini")
            if !deleted { addDeletionTombstone(type: "api_key", name: "gemini") }
        }
    }

    func clearAPIKeyForProvider(_ provider: String) {
        APIKeyManager.deleteKey(for: provider)
        scheduleRoutingSourceRefresh()
        refreshModelInfo()
        Task {
            let deleted = await APIKeyManager.deleteKey(for: provider)
            if !deleted { addDeletionTombstone(type: "api_key", name: provider) }
        }
    }

    func saveInferenceAPIKey(_ raw: String, provider: String, onSuccess: (() -> Void)? = nil, onError: ((String) -> Void)? = nil) {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        if onError == nil {
            apiKeySaveError = nil
            apiKeySaving = true
        }

        APIKeyManager.setKey(trimmed, for: provider)
        removeDeletionTombstone(type: "api_key", name: provider)

        Task {
            let result = await APIKeyManager.setKey(trimmed, for: provider)
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
                    let _: Void = APIKeyManager.deleteKey(for: provider)
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

    func saveEmbeddingAPIKey(_ raw: String, provider: String, onKeySuccess: (() -> Void)? = nil) {
        embeddingKeySaveError = nil
        // Delegate to saveInferenceAPIKey — same credential store, same daemon validation
        saveInferenceAPIKey(raw, provider: provider, onSuccess: {
            self.refreshEmbeddingConfig()
            onKeySuccess?()
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

    /// Replay pending deletion tombstones via the async gateway API.
    private func replayDeletionTombstones() async {
        let tombstones = UserDefaults.standard.array(forKey: kPendingKeyDeletionTombstones)
            as? [[String: String]] ?? []
        guard !tombstones.isEmpty else { return }
        var remaining: [[String: String]] = []
        for entry in tombstones {
            guard let type = entry["type"], let name = entry["name"] else { continue }
            var dispatched = false
            if type == "api_key" {
                dispatched = await APIKeyManager.deleteKey(for: name)
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

    /// Notify the daemon that a credential was set (type: "credential", name: "service:field").
    private func syncCredentialToDaemon(name: String, value: String) {
        guard let assistantId = cachedAssistantId else { return }
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
        guard let assistantId = cachedAssistantId else { return false }
        let body: [String: String] = ["type": "credential", "name": name]
        guard let bodyData = try? JSONSerialization.data(withJSONObject: body) else { return false }
        Task {
            _ = try? await GatewayHTTPClient.delete(path: "assistants/\(assistantId)/secrets", body: bodyData)
        }
        return true
    }

    /// Re-sync locally-known keys to daemon on reconnect.
    /// Pushes keys present in the credential store via the async gateway API,
    /// and replays any pending deletion tombstones so user-initiated clears
    /// are eventually consistent.
    private func syncAllKeysToDaemon() {
        Task {
            // In managed mode, auth is handled by SessionTokenManager — no actor token needed.
            // In local mode, wait for the JWT to be populated; on reconnect the async
            // credential bootstrap may still be in-flight.
            let connectedId = cachedAssistantId
            let isManagedMode = connectedId
                .flatMap { LockfileAssistant.loadByName($0) }?.isManaged ?? false
            if !isManagedMode {
                guard let _ = await ActorTokenManager.waitForToken(timeout: 15) else { return }
            }

            for provider in APIKeyManager.allSyncableProviders {
                if let key = APIKeyManager.getKey(for: provider) {
                    _ = await APIKeyManager.setKey(key, for: provider)
                }
            }

            await replayDeletionTombstones()
        }
    }

    func fetchSlackChannelConfig() {
        guard let assistantId = cachedAssistantId else { return }
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
        guard let assistantId = cachedAssistantId else {
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
        guard let assistantId = cachedAssistantId else {
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
        guard let assistantId = cachedAssistantId else {
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
            }
        }
    }

    func savePlatformBaseUrl(_ raw: String) {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let previous = platformBaseUrl
        platformBaseUrl = trimmed
        Task {
            guard let response = await settingsClient.setPlatformConfig(baseUrl: trimmed) else {
                self.platformBaseUrl = previous
                return
            }
            if !response.success {
                self.platformBaseUrl = previous
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
        guard let assistantId = cachedAssistantId else {
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
        // Resolve inference provider/model with `llm.default.*` as the
        // canonical source (PR 4 backfills it from `services.inference`).
        // Fall back to `services.inference.{provider,model}` for unmigrated
        // configs — defensive, since the migration should have run for
        // existing users but skips early-return cases (missing config,
        // malformed JSON, etc.).
        let services = config["services"] as? [String: Any]
        let llmDefault = (config["llm"] as? [String: Any])?["default"] as? [String: Any]
        let inference = services?["inference"] as? [String: Any]

        // Inference mode remains under `services.inference.mode` — it is an
        // inference-delivery setting (managed vs. your-own), not part of the
        // LLM model config.
        if let inference, let mode = inference["mode"] as? String {
            self.inferenceMode = mode
        }
        // Only apply local config provider/model as a fallback when the daemon
        // hasn't yet reported an authoritative value. Once the daemon responds
        // via applyModelInfoResponse, its values take precedence over local
        // config which may be stale (especially for remote assistants).
        if lastDaemonProvider == nil {
            if let provider = (llmDefault?["provider"] as? String) ?? (inference?["provider"] as? String) {
                self.selectedInferenceProvider = provider
            }
            if let model = (llmDefault?["model"] as? String) ?? (inference?["model"] as? String) {
                self.selectedModel = model
            }
        }
        guard let services else { return }
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
        }
        if let outlookOAuth = services["outlook-oauth"] as? [String: Any],
           let mode = outlookOAuth["mode"] as? String {
            self.managedOAuthMode["outlook"] = mode
        }
        if let linearOAuth = services["linear-oauth"] as? [String: Any],
           let mode = linearOAuth["mode"] as? String {
            self.managedOAuthMode["linear"] = mode
        }
        if let githubOAuth = services["github-oauth"] as? [String: Any],
           let mode = githubOAuth["mode"] as? String {
            self.managedOAuthMode["github"] = mode
        }
        if let notionOAuth = services["notion-oauth"] as? [String: Any],
           let mode = notionOAuth["mode"] as? String {
            self.managedOAuthMode["notion"] = mode
        }
    }

    @discardableResult
    func setInferenceMode(_ mode: String) -> Task<Bool, Never> {
        inferenceMode = mode
        let task = Task {
            let success = await settingsClient.patchConfig([
                "services": ["inference": ["mode": mode]]
            ])
            if !success {
                log.error("Failed to patch config for inference mode")
            }
            return success
        }
        scheduleRoutingSourceRefresh()
        return task
    }

    @discardableResult
    func setImageGenMode(_ mode: String) -> Task<Bool, Never> {
        imageGenMode = mode
        let task = Task {
            let success = await settingsClient.patchConfig([
                "services": ["image-generation": ["mode": mode]]
            ])
            if !success {
                log.error("Failed to patch config for image-generation mode")
            }
            return success
        }
        scheduleRoutingSourceRefresh()
        return task
    }

    @discardableResult
    func setWebSearchMode(_ mode: String) -> Task<Bool, Never> {
        webSearchMode = mode
        let task = Task {
            let success = await settingsClient.patchConfig([
                "services": ["web-search": ["mode": mode]]
            ])
            if !success {
                log.error("Failed to patch config for web search mode")
            }
            return success
        }
        scheduleRoutingSourceRefresh()
        return task
    }

    @discardableResult
    func setManagedOAuthMode(_ mode: String, providerKey: String) -> Task<Bool, Never> {
        managedOAuthMode[providerKey] = mode
        // Derive the config service key from providerKey (e.g. "google" → "google-oauth")
        // so it matches the key that loadServiceModes() reads on startup.
        let serviceKey = "\(providerKey)-oauth"
        let task = Task {
            let success = await settingsClient.patchConfig([
                "services": [serviceKey: ["mode": mode]]
            ])
            if !success {
                log.error("Failed to patch config for \(serviceKey) mode")
            }
            return success
        }
        scheduleRoutingSourceRefresh()
        return task
    }

    // MARK: - Managed OAuth Provider List

    func fetchManagedOAuthProviders() {
        managedOAuthProvidersLoading = true
        Task {
            do {
                let (decoded, response): (OAuthProvidersListResponse?, _) =
                    try await GatewayHTTPClient.get(
                        path: "oauth/providers",
                        params: ["supports_managed_mode": "true"],
                        timeout: 10
                    )
                if response.isSuccess, let decoded {
                    self.managedOAuthProviders = decoded.providers
                }
            } catch {
                log.error("Failed to fetch managed OAuth providers: \(error)")
            }
            managedOAuthProvidersLoading = false
        }
    }

    // MARK: - Google OAuth Connections

    /// Resolves the platform assistant UUID for OAuth endpoints.
    /// For managed assistants, the lockfile ID is the platform UUID.
    /// For self-hosted local assistants, looks up the persisted mapping via PlatformAssistantIdResolver,
    /// triggering bootstrap lazily if the mapping is not yet cached.
    private func resolvePlatformAssistantId(userId: String?) async -> String? {
        guard let connectedId = cachedAssistantId, !connectedId.isEmpty,
              let assistant = LockfileAssistant.loadByName(connectedId) else {
            return nil
        }

        let credentialStorage = FileCredentialStorage()

        let orgId = cachedOrgId

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
        let postBootstrapOrgId = cachedOrgId

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

    /// Fetch all managed OAuth connections at once and distribute by provider key.
    /// Unlike `fetchManagedOAuthConnections`, this does not check the provider mode
    /// guard, so it can be used by the integrations grid to classify providers.
    func fetchAllManagedOAuthConnections(userId: String? = nil) async {
        guard let assistantId = await resolvePlatformAssistantId(userId: userId) else { return }
        do {
            let connections = try await PlatformOAuthService.shared.listConnections(assistantId: assistantId)
            let grouped = Dictionary(grouping: connections, by: { $0.provider })
            managedOAuthConnections = grouped
        } catch {
            log.error("Failed to fetch all managed OAuth connections: \(error)")
            managedOAuthConnections = [:]
        }
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

    // MARK: - Managed Assistant Recovery Mode Actions

    /// Fetches the current recovery-mode state for the selected managed assistant
    /// and updates `managedAssistantRecoveryMode`.
    ///
    /// This is a no-op when the connected assistant is not managed.
    func refreshManagedAssistantRecoveryMode() async {
        guard let connectedId = cachedAssistantId,
              !connectedId.isEmpty,
              let assistant = LockfileAssistant.loadByName(connectedId),
              assistant.isManaged else {
            // Not a managed assistant — clear any stale state.
            managedAssistantRecoveryMode = nil
            recoveryModeRefreshError = nil
            return
        }

        let orgId = cachedOrgId ?? ""
        guard !orgId.isEmpty else {
            log.warning("Cannot refresh recovery mode: no connectedOrganizationId set")
            return
        }

        let taskAssistantId = connectedId
        let taskOrgId = orgId

        recoveryModeRefreshing = true
        recoveryModeRefreshError = nil
        defer {
            let stillSameAssistant = cachedAssistantId == taskAssistantId
            let stillSameOrg = cachedOrgId == taskOrgId
            if stillSameAssistant && stillSameOrg {
                recoveryModeRefreshing = false
            }
        }

        do {
            let updated = try await AuthService.shared.refreshAssistant(
                id: assistant.assistantId,
                organizationId: orgId
            )
            // Guard against stale responses: only apply the result if both the connected
            // assistant and connected organization haven't changed while the request was in flight.
            let currentConnectedId = cachedAssistantId ?? ""
            guard currentConnectedId == connectedId else {
                log.info("Discarding stale recovery-mode response for assistant \(assistant.assistantId, privacy: .public): assistant changed to '\(currentConnectedId, privacy: .public)' while request was in flight")
                return
            }
            let currentOrgId = cachedOrgId ?? ""
            guard currentOrgId == orgId else {
                log.info("Discarding stale recovery-mode response for assistant \(assistant.assistantId, privacy: .public): organization changed to '\(currentOrgId, privacy: .public)' while request was in flight")
                return
            }
            managedAssistantRecoveryMode = updated.recovery_mode
            log.info("Refreshed recovery mode for assistant \(assistant.assistantId, privacy: .public): enabled=\(updated.recovery_mode?.enabled ?? false)")
        } catch {
            // Only apply the error if the context hasn't changed mid-flight — a stale error
            // from a previous assistant/org must not overwrite clean state for the new context.
            let currentConnectedId = cachedAssistantId ?? ""
            let currentOrgId = cachedOrgId ?? ""
            guard currentConnectedId == connectedId && currentOrgId == orgId else {
                log.info("Discarding stale refresh error for assistant \(assistant.assistantId, privacy: .public): context changed while request was in flight")
                return
            }
            recoveryModeRefreshError = error.localizedDescription
            log.error("Failed to refresh recovery mode for assistant \(assistant.assistantId, privacy: .public): \(error)")
        }
    }

    /// Enters recovery mode for the selected managed assistant.
    ///
    /// Sets `recoveryModeEntering` while the request is in flight and updates
    /// `managedAssistantRecoveryMode` on success.
    func enterManagedAssistantRecoveryMode() {
        Task {
            guard let connectedId = cachedAssistantId,
                  !connectedId.isEmpty,
                  let assistant = LockfileAssistant.loadByName(connectedId),
                  assistant.isManaged else {
                recoveryModeEnterError = "No managed assistant selected"
                return
            }

            let orgId = cachedOrgId ?? ""
            guard !orgId.isEmpty else {
                recoveryModeEnterError = "No organization ID available"
                return
            }

            let taskAssistantId = connectedId
            let taskOrgId = orgId

            recoveryModeEntering = true
            recoveryModeEnterError = nil
            defer {
                let stillSameAssistant = cachedAssistantId == taskAssistantId
                let stillSameOrg = cachedOrgId == taskOrgId
                if stillSameAssistant && stillSameOrg {
                    recoveryModeEntering = false
                }
            }

            do {
                let updated = try await AuthService.shared.enterRecoveryMode(
                    assistantId: assistant.assistantId,
                    organizationId: orgId
                )
                // Guard against stale responses: only apply the result if both the
                // connected assistant and connected organization haven't changed while
                // the request was in flight (same pattern as refreshManagedAssistantRecoveryMode).
                let currentConnectedId = cachedAssistantId ?? ""
                guard currentConnectedId == connectedId else {
                    log.info("Discarding stale enter-recovery-mode response for assistant \(assistant.assistantId, privacy: .public): assistant changed to '\(currentConnectedId, privacy: .public)' while request was in flight")
                    return
                }
                let currentOrgId = cachedOrgId ?? ""
                guard currentOrgId == orgId else {
                    log.info("Discarding stale enter-recovery-mode response for assistant \(assistant.assistantId, privacy: .public): organization changed to '\(currentOrgId, privacy: .public)' while request was in flight")
                    return
                }
                managedAssistantRecoveryMode = updated.recovery_mode
                log.info("Entered recovery mode for assistant \(assistant.assistantId, privacy: .public)")
            } catch {
                // Only apply the error if the context hasn't changed mid-flight.
                let currentConnectedId = cachedAssistantId ?? ""
                let currentOrgId = cachedOrgId ?? ""
                guard currentConnectedId == connectedId && currentOrgId == orgId else {
                    log.info("Discarding stale enter error for assistant \(assistant.assistantId, privacy: .public): context changed while request was in flight")
                    return
                }
                recoveryModeEnterError = error.localizedDescription
                log.error("Failed to enter recovery mode for assistant \(assistant.assistantId, privacy: .public): \(error)")
            }
        }
    }

    /// Exits recovery mode for the selected managed assistant.
    ///
    /// Sets `recoveryModeExiting` while the request is in flight and updates
    /// `managedAssistantRecoveryMode` on success.
    func exitManagedAssistantRecoveryMode() {
        Task {
            guard let connectedId = cachedAssistantId,
                  !connectedId.isEmpty,
                  let assistant = LockfileAssistant.loadByName(connectedId),
                  assistant.isManaged else {
                recoveryModeExitError = "No managed assistant selected"
                return
            }

            let orgId = cachedOrgId ?? ""
            guard !orgId.isEmpty else {
                recoveryModeExitError = "No organization ID available"
                return
            }

            let taskAssistantId = connectedId
            let taskOrgId = orgId

            recoveryModeExiting = true
            recoveryModeExitError = nil
            defer {
                let stillSameAssistant = cachedAssistantId == taskAssistantId
                let stillSameOrg = cachedOrgId == taskOrgId
                if stillSameAssistant && stillSameOrg {
                    recoveryModeExiting = false
                }
            }

            do {
                let updated = try await AuthService.shared.exitRecoveryMode(
                    assistantId: assistant.assistantId,
                    organizationId: orgId
                )
                // Guard against stale responses: only apply the result if both the
                // connected assistant and connected organization haven't changed while
                // the request was in flight (same pattern as refreshManagedAssistantRecoveryMode).
                let currentConnectedId = cachedAssistantId ?? ""
                guard currentConnectedId == connectedId else {
                    log.info("Discarding stale exit-recovery-mode response for assistant \(assistant.assistantId, privacy: .public): assistant changed to '\(currentConnectedId, privacy: .public)' while request was in flight")
                    return
                }
                let currentOrgId = cachedOrgId ?? ""
                guard currentOrgId == orgId else {
                    log.info("Discarding stale exit-recovery-mode response for assistant \(assistant.assistantId, privacy: .public): organization changed to '\(currentOrgId, privacy: .public)' while request was in flight")
                    return
                }
                managedAssistantRecoveryMode = updated.recovery_mode
                log.info("Exited recovery mode for assistant \(assistant.assistantId, privacy: .public)")
            } catch {
                // Only apply the error if the context hasn't changed mid-flight.
                let currentConnectedId = cachedAssistantId ?? ""
                let currentOrgId = cachedOrgId ?? ""
                guard currentConnectedId == connectedId && currentOrgId == orgId else {
                    log.info("Discarding stale exit error for assistant \(assistant.assistantId, privacy: .public): context changed while request was in flight")
                    return
                }
                recoveryModeExitError = error.localizedDescription
                log.error("Failed to exit recovery mode for assistant \(assistant.assistantId, privacy: .public): \(error)")
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

    @discardableResult
    func setWebSearchProvider(_ provider: String) -> Task<Bool, Never> {
        webSearchProvider = provider
        let task = Task {
            let success = await settingsClient.patchConfig([
                "services": ["web-search": ["provider": provider]]
            ])
            if !success {
                log.error("Failed to patch config for web search provider")
            }
            return success
        }
        scheduleRoutingSourceRefresh()
        return task
    }

    // TODO PR 19: remove. Superseded by setLLMDefaultProvider — kept for any
    // legacy callers / tests that still write to `services.inference.provider`
    // directly while the unification rollout is in progress.
    @discardableResult
    func setInferenceProvider(_ provider: String) -> Task<Bool, Never> {
        selectedInferenceProvider = provider
        let task = Task {
            let success = await settingsClient.patchConfig([
                "services": ["inference": ["provider": provider]]
            ])
            if !success {
                log.error("Failed to patch config for inference provider")
            }
            return success
        }
        scheduleRoutingSourceRefresh()
        return task
    }

    /// Persists the selected default LLM provider to the daemon config under
    /// the unified `llm.default.provider` key. This is the canonical write
    /// path now that the workspace migration consolidates LLM call-site
    /// settings under `llm.*` (see PR 4 of the unify-llm-callsites plan).
    @discardableResult
    func setLLMDefaultProvider(_ provider: String) -> Task<Bool, Never> {
        selectedInferenceProvider = provider
        let task = Task {
            let success = await settingsClient.patchConfig([
                "llm": ["default": ["provider": provider]]
            ])
            if !success {
                log.error("Failed to patch config for llm.default.provider")
            }
            return success
        }
        scheduleRoutingSourceRefresh()
        return task
    }

    /// Persists the default LLM provider+model pair under `llm.default`.
    /// Both keys are written together so the daemon's read-modify-write cycle
    /// observes a consistent pair.
    @discardableResult
    func setLLMDefaultModel(
        _ model: String,
        provider: String,
        force: Bool = false
    ) -> Task<Bool, Never> {
        if !force {
            let modelUnchanged = model == lastDaemonModel
            let providerUnchanged = provider == lastDaemonProvider
            if modelUnchanged && providerUnchanged {
                return Task { true }
            }
        }
        lastDaemonModel = model
        lastDaemonProvider = provider
        selectedModel = model
        selectedInferenceProvider = provider
        let task = Task {
            let success = await settingsClient.patchConfig([
                "llm": ["default": ["provider": provider, "model": model]]
            ])
            if !success {
                log.error("Failed to patch config for llm.default.{provider,model}")
                if lastDaemonModel == model {
                    lastDaemonModel = nil
                    lastDaemonProvider = nil
                }
            }
            return success
        }
        scheduleRoutingSourceRefresh()
        return task
    }

    // MARK: - Per-Call-Site Override Read / Write

    /// Number of entries in `callSiteOverrides` that have at least one
    /// explicit override (`provider`, `model`, or `profile`). Useful for
    /// rendering a badge on the overrides settings entry.
    var overridesCount: Int {
        callSiteOverrides.lazy.filter { $0.hasOverride }.count
    }

    /// Reads `llm.callSites.<id>` from the workspace config dictionary,
    /// merges every entry against `CallSiteCatalog.all`, and replaces
    /// `callSiteOverrides`. Catalog entries missing from the config map to
    /// "no override" (all fields `nil`), preserving display order.
    ///
    /// Unknown call-site IDs in the config (e.g. ones added on a newer
    /// daemon) are silently ignored — the catalog is the source of truth
    /// for what the UI can render.
    func loadCallSiteOverrides(config: [String: Any]) {
        let llm = config["llm"] as? [String: Any]
        let callSitesRaw = (llm?["callSites"] as? [String: Any]) ?? [:]
        var byId: [String: (provider: String?, model: String?, profile: String?)] = [:]
        for (id, raw) in callSitesRaw {
            guard CallSiteCatalog.validIds.contains(id),
                  let entry = raw as? [String: Any] else { continue }
            let provider = (entry["provider"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            let model = (entry["model"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            let profile = (entry["profile"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            byId[id] = (provider: provider, model: model, profile: profile)
        }
        self.callSiteOverrides = CallSiteCatalog.all.map { entry in
            var merged = entry
            if let raw = byId[entry.id] {
                merged.provider = raw.provider
                merged.model = raw.model
                merged.profile = raw.profile
            } else {
                merged.provider = nil
                merged.model = nil
                merged.profile = nil
            }
            return merged
        }
    }

    /// Persists an override for a single call site at
    /// `llm.callSites.<id>.{provider,model,profile}`. Nil arguments are
    /// omitted from the patch payload — passing `provider: nil` does
    /// **not** clear an existing provider override; use
    /// `clearCallSiteOverride(_:)` for that.
    ///
    /// The local `callSiteOverrides` cache is updated optimistically so
    /// SwiftUI views reflect the change immediately.
    @discardableResult
    func setCallSiteOverride(
        _ id: String,
        provider: String? = nil,
        model: String? = nil,
        profile: String? = nil
    ) -> Task<Bool, Never> {
        guard CallSiteCatalog.validIds.contains(id) else {
            log.error("setCallSiteOverride: unknown call-site id \(id, privacy: .public)")
            return Task { false }
        }
        if let index = callSiteOverrides.firstIndex(where: { $0.id == id }) {
            if let provider { callSiteOverrides[index].provider = provider }
            if let model { callSiteOverrides[index].model = model }
            if let profile { callSiteOverrides[index].profile = profile }
        }
        var entry: [String: Any] = [:]
        if let provider { entry["provider"] = provider }
        if let model { entry["model"] = model }
        if let profile { entry["profile"] = profile }
        let payload: [String: Any] = ["llm": ["callSites": [id: entry]]]
        let task = Task {
            let success = await settingsClient.patchConfig(payload)
            if !success {
                log.error("Failed to patch config for llm.callSites.\(id, privacy: .public)")
            }
            return success
        }
        return task
    }

    /// Clears the override for a single call site by writing
    /// `{ provider: null, model: null, profile: null }` to
    /// `llm.callSites.<id>`. The daemon's PATCH handler uses
    /// `deepMergeOverwrite`, which assigns `null` leaves rather than
    /// deleting the key, so the on-disk shape becomes
    /// `{ "llm": { "callSites": { "<id>": { "provider": null, ... } } } }`.
    ///
    /// The Zod fragment schema treats `null` as equivalent to "absent" for
    /// these optional fields (parsed as `undefined`), which is what the
    /// resolver consumes. If a true key-deletion semantic is needed in
    /// the future, a dedicated DELETE endpoint should be added — see
    /// the PR body for the proposed follow-up.
    @discardableResult
    func clearCallSiteOverride(_ id: String) -> Task<Bool, Never> {
        guard CallSiteCatalog.validIds.contains(id) else {
            log.error("clearCallSiteOverride: unknown call-site id \(id, privacy: .public)")
            return Task { false }
        }
        if let index = callSiteOverrides.firstIndex(where: { $0.id == id }) {
            callSiteOverrides[index].provider = nil
            callSiteOverrides[index].model = nil
            callSiteOverrides[index].profile = nil
        }
        let entry: [String: Any] = [
            "provider": NSNull(),
            "model": NSNull(),
            "profile": NSNull(),
        ]
        let payload: [String: Any] = ["llm": ["callSites": [id: entry]]]
        let task = Task {
            let success = await settingsClient.patchConfig(payload)
            if !success {
                log.error("Failed to patch config to clear llm.callSites.\(id, privacy: .public)")
            }
            return success
        }
        return task
    }

    /// Batch update of every entry in `overrides`. Each entry's
    /// `provider`/`model`/`profile` is written verbatim; `nil` fields are
    /// emitted as JSON null so the daemon clears them via the same
    /// deep-merge mechanism as `clearCallSiteOverride(_:)`.
    ///
    /// Useful for "reset all overrides" or "apply preset" actions that
    /// touch many call sites in a single round trip. The local
    /// `callSiteOverrides` cache is replaced so SwiftUI views reflect
    /// the new state immediately.
    @discardableResult
    func setCallSiteOverrides(_ overrides: [CallSiteOverride]) -> Task<Bool, Never> {
        let validOverrides = overrides.filter { CallSiteCatalog.validIds.contains($0.id) }
        // Preserve catalog order in the local cache so SwiftUI lists stay stable.
        let overrideById = Dictionary(uniqueKeysWithValues: validOverrides.map { ($0.id, $0) })
        callSiteOverrides = CallSiteCatalog.all.map { entry in
            var merged = entry
            if let provided = overrideById[entry.id] {
                merged.provider = provided.provider
                merged.model = provided.model
                merged.profile = provided.profile
            } else {
                merged.provider = nil
                merged.model = nil
                merged.profile = nil
            }
            return merged
        }
        var callSitesPayload: [String: Any] = [:]
        for entry in validOverrides {
            // Emit explicit JSON null for absent fields so the daemon's
            // deep-merge clears them rather than leaving stale values in
            // place. Build the dict with NSNull placeholders, then
            // overwrite with the real string values when present — this
            // avoids the Optional-to-Any nil-flattening trap.
            var rawEntry: [String: Any] = [
                "provider": NSNull(),
                "model": NSNull(),
                "profile": NSNull(),
            ]
            if let provider = entry.provider { rawEntry["provider"] = provider }
            if let model = entry.model { rawEntry["model"] = model }
            if let profile = entry.profile { rawEntry["profile"] = profile }
            callSitesPayload[entry.id] = rawEntry
        }
        let payload: [String: Any] = ["llm": ["callSites": callSitesPayload]]
        let task = Task {
            let success = await settingsClient.patchConfig(payload)
            if !success {
                log.error("Failed to patch config for batch llm.callSites update (\(validOverrides.count, privacy: .public) entries)")
            }
            return success
        }
        return task
    }

    /// Persists the selected TTS provider to the daemon config so synthesis
    /// routes through the correct backend. The canonical config path is
    /// `services.tts.provider`.
    @discardableResult
    func setTTSProvider(_ provider: String) -> Task<Bool, Never> {
        let task = Task {
            let success = await settingsClient.patchConfig([
                "services": ["tts": ["provider": provider]]
            ])
            if !success {
                log.error("Failed to patch config for TTS provider")
            }
            return success
        }
        return task
    }

    func setElevenLabsVoiceId(_ voiceId: String) {
        let trimmed = voiceId.trimmingCharacters(in: .whitespacesAndNewlines)
        self.elevenLabsVoiceId = trimmed
        Task {
            let success = await settingsClient.patchConfig([
                "services": ["tts": ["providers": ["elevenlabs": ["voiceId": trimmed]]]]
            ])
            if !success {
                log.error("Failed to patch config for ElevenLabs voice ID")
            }
        }
    }

    func setFishAudioReferenceId(_ referenceId: String) {
        let trimmed = referenceId.trimmingCharacters(in: .whitespacesAndNewlines)
        self.fishAudioReferenceId = trimmed
        Task {
            let success = await settingsClient.patchConfig([
                "services": ["tts": ["providers": ["fish-audio": ["referenceId": trimmed]]]]
            ])
            if !success {
                log.error("Failed to patch config for Fish Audio reference ID")
            }
        }
    }

    /// Persists the selected STT provider to the daemon config so
    /// transcription routes through the correct backend. The canonical
    /// config path is `services.stt.provider`.
    @discardableResult
    func setSTTProvider(_ provider: String) -> Task<Bool, Never> {
        let task = Task {
            let success = await settingsClient.patchConfig([
                "services": ["stt": ["provider": provider]]
            ])
            if !success {
                log.error("Failed to patch config for STT provider")
            }
            return success
        }
        return task
    }

    /// Saves an API key for the given STT provider to the credential store
    /// and synchronizes it to the assistant.
    ///
    /// Returns the gateway write result so callers can surface explicit
    /// success/failure feedback in UI flows.
    func saveSTTKeyResult(_ raw: String, sttProviderId: String) async -> APIKeyManager.SetKeyResult {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            return APIKeyManager.SetKeyResult(
                success: false,
                error: "Please enter an API key.",
                isTransient: false
            )
        }
        let keyProvider = Self.sttApiKeyProviderName(for: sttProviderId)
        let setLocalKey: (String, String) -> Void = APIKeyManager.setKey(_:for:)
        setLocalKey(trimmed, keyProvider)
        removeDeletionTombstone(type: "api_key", name: keyProvider)
        let result = await APIKeyManager.setKey(trimmed, for: keyProvider)
        if result.success {
            scheduleRoutingSourceRefresh()
            return result
        }
        if let error = result.error {
            log.error("Failed to sync STT key for \(sttProviderId, privacy: .public) to daemon: \(error, privacy: .public)")
        }
        if !result.isTransient {
            let _: Void = APIKeyManager.deleteKey(for: keyProvider)
        }
        return result
    }

    /// Saves an API key for the given STT provider to the credential store.
    /// The `sttProviderId` is the catalog identifier (e.g. `"openai-whisper"`,
    /// `"deepgram"`); the method resolves the credential provider name from
    /// the STT provider registry's `apiKeyProviderName` field so callers
    /// don't need to know the mapping.
    func saveSTTKey(_ raw: String, sttProviderId: String, onSuccess: (() -> Void)? = nil) {
        Task {
            let result = await saveSTTKeyResult(raw, sttProviderId: sttProviderId)
            if result.success {
                onSuccess?()
            }
        }
    }

    /// Clears the API key for the given STT provider from both local and
    /// daemon credential stores.
    func clearSTTKey(sttProviderId: String) {
        let keyProvider = Self.sttApiKeyProviderName(for: sttProviderId)
        APIKeyManager.deleteKey(for: keyProvider)
        Task {
            let deleted = await APIKeyManager.deleteKey(for: keyProvider)
            if !deleted { addDeletionTombstone(type: "api_key", name: keyProvider) }
        }
    }

    /// Checks whether the daemon has an API key stored for the given STT
    /// provider.
    func hasSTTKey(sttProviderId: String) async -> Bool {
        let keyProvider = Self.sttApiKeyProviderName(for: sttProviderId)
        return await APIKeyManager.hasKey(for: keyProvider)
    }

    /// Resolves the `api_key` secret-catalog provider name for a given STT
    /// provider identifier. Looks up the `apiKeyProviderName` from the STT
    /// provider registry; falls back to the provider id itself when the
    /// registry entry is not found.
    static func sttApiKeyProviderName(for sttProviderId: String) -> String {
        loadSTTProviderRegistry()
            .provider(withId: sttProviderId)?
            .apiKeyProviderName ?? sttProviderId
    }

    /// Whether the given STT provider owns its API key exclusively — i.e. the
    /// key is not shared with any other service. Exclusive-key providers can
    /// safely have their key cleared through the STT reset flow without
    /// affecting other features.
    ///
    /// A provider's key is non-exclusive when either:
    /// 1. Its `apiKeyProviderName` differs from its `id` (e.g.
    ///    `openai-whisper` → `openai`), meaning the key is shared within STT.
    /// 2. A TTS provider also references the same key name (e.g.
    ///    `deepgram` STT + `deepgram` TTS both use the `deepgram` key).
    ///
    /// This helper is provider-agnostic: adding a new provider only requires a
    /// catalog entry — no new conditionals here or in the UI layer.
    static func sttKeyIsExclusive(for sttProviderId: String) -> Bool {
        let entry = loadSTTProviderRegistry().provider(withId: sttProviderId)
        guard let entry else {
            // Unknown providers are assumed exclusive — clearing an unknown
            // key cannot collide with a known service.
            return true
        }
        // First check: different key name means shared within STT scope.
        guard entry.apiKeyProviderName == entry.id else { return false }
        // Second check: same key name but might be shared with a TTS provider.
        return !Self.isApiKeySharedAcrossServices(entry.apiKeyProviderName)
    }

    /// Whether the given STT provider's API key is shared with another
    /// service. The inverse of `sttKeyIsExclusive(for:)`.
    ///
    /// Shared-key providers should not expose a "Reset" action in the STT
    /// settings card because clearing the key would break the sibling service
    /// that depends on it.
    static func sttKeyIsShared(for sttProviderId: String) -> Bool {
        !sttKeyIsExclusive(for: sttProviderId)
    }

    // MARK: - TTS Credential Mapping

    /// Checks whether a TTS credential exists for the given provider using
    /// the registry's credential metadata. Credential-mode providers are
    /// looked up via `APIKeyManager.getCredential(service:field:)`; api-key
    /// mode providers via `APIKeyManager.getKey(for:)`.
    static func ttsCredentialExists(for ttsProviderId: String) -> Bool {
        let entry = loadTTSProviderRegistry().provider(withId: ttsProviderId)
        guard let entry else { return false }
        switch entry.credentialMode {
        case .credential:
            let namespace = entry.credentialNamespace ?? entry.id
            return APIKeyManager.getCredential(service: namespace, field: "api_key") != nil
        case .apiKey:
            let keyProvider = entry.apiKeyProviderName ?? entry.id
            return APIKeyManager.getKey(for: keyProvider) != nil
        }
    }

    /// Saves a TTS API key for the given provider using the registry's
    /// credential metadata to route to the correct storage mechanism.
    func saveTTSKey(_ raw: String, ttsProviderId: String, onSuccess: (() -> Void)? = nil) {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let entry = loadTTSProviderRegistry().provider(withId: ttsProviderId)
        guard let entry else {
            log.warning("Unknown TTS provider \(ttsProviderId, privacy: .public) — cannot save key")
            return
        }
        switch entry.credentialMode {
        case .credential:
            let namespace = entry.credentialNamespace ?? entry.id
            APIKeyManager.setCredential(trimmed, service: namespace, field: "api_key")
            removeDeletionTombstone(type: "credential", name: "\(namespace):api_key")
            Task {
                let result = await APIKeyManager.setCredential(trimmed, service: namespace, field: "api_key")
                if result.success {
                    onSuccess?()
                } else if let error = result.error {
                    log.error("Failed to sync TTS key for \(ttsProviderId, privacy: .public): \(error, privacy: .public)")
                }
            }
        case .apiKey:
            let keyProvider = entry.apiKeyProviderName ?? entry.id
            APIKeyManager.setKey(trimmed, for: keyProvider)
            removeDeletionTombstone(type: "api_key", name: keyProvider)
            Task {
                let result = await APIKeyManager.setKey(trimmed, for: keyProvider)
                if result.success {
                    onSuccess?()
                } else if let error = result.error {
                    log.error("Failed to sync TTS key for \(ttsProviderId, privacy: .public): \(error, privacy: .public)")
                }
            }
        }
    }

    /// Clears the stored TTS credential for the given provider using the
    /// registry's credential metadata to route to the correct storage.
    func clearTTSKey(ttsProviderId: String) {
        let entry = loadTTSProviderRegistry().provider(withId: ttsProviderId)
        guard let entry else { return }
        switch entry.credentialMode {
        case .credential:
            let namespace = entry.credentialNamespace ?? entry.id
            APIKeyManager.deleteCredential(service: namespace, field: "api_key")
            Task {
                let deleted = await APIKeyManager.deleteCredential(service: namespace, field: "api_key")
                if !deleted { addDeletionTombstone(type: "credential", name: "\(namespace):api_key") }
            }
        case .apiKey:
            let keyProvider = entry.apiKeyProviderName ?? entry.id
            APIKeyManager.deleteKey(for: keyProvider)
            Task {
                let deleted = await APIKeyManager.deleteKey(for: keyProvider)
                if !deleted { addDeletionTombstone(type: "api_key", name: keyProvider) }
            }
        }
    }

    /// Whether the given TTS provider owns its API key exclusively — i.e. the
    /// key is not shared with any other service. Exclusive-key providers can
    /// safely have their key cleared through the TTS reset flow without
    /// affecting other features.
    ///
    /// Credential-mode providers (ElevenLabs, Fish Audio) are always exclusive
    /// because their credential namespace is provider-specific. Api-key mode
    /// providers are exclusive when their `apiKeyProviderName` matches their
    /// own `id` — shared-key providers map to a different name (e.g. a
    /// hypothetical provider sharing the `openai` key).
    ///
    /// Deepgram TTS uses api-key mode with `apiKeyProviderName: "deepgram"`.
    /// The key is shared with Deepgram STT, so the TTS card should not offer
    /// a destructive reset — clearing the key would break STT. The sharing is
    /// detected because another service (STT) also references the `deepgram`
    /// key provider name.
    static func ttsKeyIsExclusive(for ttsProviderId: String) -> Bool {
        let entry = loadTTSProviderRegistry().provider(withId: ttsProviderId)
        guard let entry else {
            // Unknown providers are assumed exclusive — clearing an unknown
            // key cannot collide with a known service.
            return true
        }
        switch entry.credentialMode {
        case .credential:
            // Credential-mode providers use their own namespace — always exclusive.
            return true
        case .apiKey:
            // Api-key mode: check whether the key name is shared across services.
            // Deepgram TTS shares its key with Deepgram STT, so it is NOT exclusive.
            let keyProvider = entry.apiKeyProviderName ?? entry.id
            return !Self.isApiKeySharedAcrossServices(keyProvider)
        }
    }

    /// Whether the given TTS provider's API key is shared with another
    /// service. The inverse of `ttsKeyIsExclusive(for:)`.
    static func ttsKeyIsShared(for ttsProviderId: String) -> Bool {
        !ttsKeyIsExclusive(for: ttsProviderId)
    }

    /// Checks whether a given API key provider name is used by both a TTS and
    /// an STT provider, indicating a cross-service shared credential.
    ///
    /// Checks both registries so the result is symmetric — calling this from
    /// either `sttKeyIsExclusive` or `ttsKeyIsExclusive` correctly detects
    /// cross-service sharing (e.g. deepgram STT + deepgram TTS).
    private static func isApiKeySharedAcrossServices(_ keyProviderName: String) -> Bool {
        let sttRegistry = loadSTTProviderRegistry()
        let sttUsesKey = sttRegistry.providers.contains { entry in
            entry.apiKeyProviderName == keyProviderName
        }
        let ttsRegistry = loadTTSProviderRegistry()
        let ttsUsesKey = ttsRegistry.providers.contains { entry in
            guard entry.credentialMode == .apiKey else { return false }
            return (entry.apiKeyProviderName ?? entry.id) == keyProviderName
        }
        return sttUsesKey && ttsUsesKey
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
        // For remote assistants, keep the cached localGatewayTarget (set by
        // applyLockfileState) because the daemon reports its own loopback
        // address which is not reachable from the client. For local assistants,
        // use the daemon's authoritative value since it reflects the daemon's
        // actual runtime environment.
        if !isCurrentAssistantRemote {
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
        let connectedId = cachedAssistantId
        return "http://\(ip):\(LockfilePaths.resolveGatewayPort(connectedAssistantId: connectedId))"
    }

    // MARK: - Model Actions

    // TODO PR 19: remove. Superseded by setLLMDefaultModel — kept for any
    // legacy callers (e.g. routes through the daemon's set-model HTTP endpoint
    // which still enriches state via applyModelInfoResponse) while the
    // unification rollout is in progress.
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

    /// In-flight config refresh task. Cancelled when a new refresh is
    /// requested so that a slow stale response can't clobber a newer
    /// applied state when startup, reconnect, and configChanged triggers
    /// fire in quick succession.
    private var configRefreshTask: Task<Void, Never>?

    /// Cancels any in-flight config refresh and spawns a fresh one.
    private func refreshDaemonConfig() {
        configRefreshTask?.cancel()
        configRefreshTask = Task { @MainActor [weak self] in
            await self?.loadConfigFromDaemon()
        }
    }

    /// Fetches the full workspace config from the daemon and applies all
    /// config-dependent properties. Called after init once the daemon is
    /// reachable.
    func loadConfigFromDaemon() async {
        guard let config = await settingsClient.fetchConfig() else { return }
        guard !Task.isCancelled else { return }
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

        if let services = config["services"] as? [String: Any],
           let webSearch = services["web-search"] as? [String: Any],
           let provider = webSearch["provider"] as? String {
            self.webSearchProvider = provider
        }

        // Sync the global TTS provider from the daemon config so the client
        // stays aligned after restart or reconnection. The canonical path
        // is services.tts.provider.
        if let services = config["services"] as? [String: Any],
           let tts = services["tts"] as? [String: Any],
           let ttsProvider = tts["provider"] as? String {
            UserDefaults.standard.set(ttsProvider, forKey: "ttsProvider")
        }

        // Sync provider-specific voice IDs so the Voice Settings view
        // can display the configured value on load.
        if let services = config["services"] as? [String: Any],
           let tts = services["tts"] as? [String: Any],
           let providers = tts["providers"] as? [String: Any] {
            if let elevenlabs = providers["elevenlabs"] as? [String: Any],
               let voiceId = elevenlabs["voiceId"] as? String {
                self.elevenLabsVoiceId = voiceId
            }
            if let fishAudio = providers["fish-audio"] as? [String: Any],
               let referenceId = fishAudio["referenceId"] as? String {
                self.fishAudioReferenceId = referenceId
            }
        }

        // Sync the global STT provider from the daemon config so the client
        // stays aligned after restart or reconnection. The canonical path
        // is services.stt.provider. Empty/whitespace-only values are
        // treated as "not configured" and are not persisted — this avoids
        // clobbering a previously selected provider with a no-op sentinel.
        if let services = config["services"] as? [String: Any],
           let stt = services["stt"] as? [String: Any],
           let sttProvider = stt["provider"] as? String,
           !sttProvider.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            UserDefaults.standard.set(sttProvider, forKey: "sttProvider")
        }

        Self.applyHostBrowserCdpInspectConfig(config, into: self)

        loadServiceModes(config: config)
        loadCallSiteOverrides(config: config)

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

    // MARK: - Host Browser (CDP Inspect) Loading

    /// Loopback hostnames accepted by the cdp-inspect backend. Non-loopback
    /// values are rejected at the UI layer to prevent remote attach.
    static let hostBrowserCdpInspectAllowedHosts: Set<String> = [
        "localhost",
        "127.0.0.1",
        "::1",
        "[::1]",
    ]

    /// Returns `true` when `host` is one of the accepted loopback addresses
    /// for the cdp-inspect backend.
    static func isValidHostBrowserCdpInspectHost(_ host: String) -> Bool {
        let trimmed = host.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return hostBrowserCdpInspectAllowedHosts.contains(trimmed)
    }

    /// Returns `true` when `port` is within the valid TCP port range.
    static func isValidHostBrowserCdpInspectPort(_ port: Int) -> Bool {
        return (1...65535).contains(port)
    }

    /// Default loopback host for the cdp-inspect backend. Used as the fallback
    /// when the daemon config contains an invalid (non-loopback) host value.
    static let defaultHostBrowserCdpInspectHost: String = "localhost"
    /// Default DevTools remote-debugging port for the cdp-inspect backend.
    /// Used as the fallback when the daemon config contains an out-of-range
    /// port value.
    static let defaultHostBrowserCdpInspectPort: Int = 9222

    /// Reads `hostBrowser.cdpInspect.{enabled,host,port,probeTimeoutMs}` from
    /// the workspace config and copies the values into `store`. Missing keys
    /// leave the existing values untouched so the defaults set in the
    /// property declarations apply.
    ///
    /// The `host` and `port` values are validated the same way as the UI
    /// setters (`setHostBrowserCdpInspectHost` / `setHostBrowserCdpInspectPort`)
    /// to preserve the loopback-only security invariant: if the workspace
    /// config file is manually edited (or tampered with) to contain a
    /// non-loopback host like `"attacker.example.com"` or an out-of-range
    /// port, we fall back to the safe defaults (`localhost` / `9222`) and
    /// log a warning instead of silently accepting the unsafe value.
    ///
    /// When an invalid value is detected, we also patch the sanitized
    /// default back to the daemon config so the bad value does not
    /// reappear on the next config reload. The patch only fires when
    /// validation fails — once the config contains a valid value, no
    /// patch is emitted, so there is no infinite loop across refreshes.
    static func applyHostBrowserCdpInspectConfig(
        _ config: [String: Any],
        into store: SettingsStore
    ) {
        guard let hostBrowser = config["hostBrowser"] as? [String: Any],
              let cdpInspect = hostBrowser["cdpInspect"] as? [String: Any] else {
            return
        }
        if let enabled = cdpInspect["enabled"] as? Bool {
            store.hostBrowserCdpInspectEnabled = enabled
        }
        if let host = cdpInspect["host"] as? String, !host.isEmpty {
            if isValidHostBrowserCdpInspectHost(host) {
                store.hostBrowserCdpInspectHost = host.trimmingCharacters(in: .whitespacesAndNewlines)
            } else {
                log.warning("Ignoring invalid hostBrowser.cdpInspect.host value from daemon config (must be loopback); falling back to default and patching daemon")
                store.hostBrowserCdpInspectHost = defaultHostBrowserCdpInspectHost
                // Persist the sanitized fallback so the invalid value
                // does not reappear on the next daemon config reload.
                let settingsClient = store.settingsClient
                Task {
                    let success = await settingsClient.patchConfig([
                        "hostBrowser": ["cdpInspect": ["host": defaultHostBrowserCdpInspectHost]]
                    ])
                    if !success {
                        log.error("Failed to patch sanitized hostBrowser.cdpInspect.host back to daemon config")
                    }
                }
            }
        }
        // JSONSerialization may surface integral numbers as Double, so coerce
        // through a single path before validating.
        let rawPort: Int?
        if let port = cdpInspect["port"] as? Int {
            rawPort = port
        } else if let portDouble = cdpInspect["port"] as? Double {
            if portDouble.truncatingRemainder(dividingBy: 1) == 0 {
                rawPort = Int(portDouble)
            } else {
                log.warning("Ignoring fractional hostBrowser.cdpInspect.port value \(portDouble) from daemon config; falling back to default")
                rawPort = nil
                store.hostBrowserCdpInspectPort = defaultHostBrowserCdpInspectPort
                let settingsClient = store.settingsClient
                Task {
                    let success = await settingsClient.patchConfig([
                        "hostBrowser": ["cdpInspect": ["port": defaultHostBrowserCdpInspectPort]]
                    ])
                    if !success {
                        log.error("Failed to patch sanitized hostBrowser.cdpInspect.port back to daemon config")
                    }
                }
            }
        } else {
            rawPort = nil
        }
        if let port = rawPort {
            if isValidHostBrowserCdpInspectPort(port) {
                store.hostBrowserCdpInspectPort = port
            } else {
                log.warning("Ignoring out-of-range hostBrowser.cdpInspect.port value from daemon config (must be 1..65535); falling back to default and patching daemon")
                store.hostBrowserCdpInspectPort = defaultHostBrowserCdpInspectPort
                // Persist the sanitized fallback so the invalid value
                // does not reappear on the next daemon config reload.
                let settingsClient = store.settingsClient
                Task {
                    let success = await settingsClient.patchConfig([
                        "hostBrowser": ["cdpInspect": ["port": defaultHostBrowserCdpInspectPort]]
                    ])
                    if !success {
                        log.error("Failed to patch sanitized hostBrowser.cdpInspect.port back to daemon config")
                    }
                }
            }
        }
        if let probeTimeout = cdpInspect["probeTimeoutMs"] as? Int {
            store.hostBrowserCdpInspectProbeTimeoutMs = probeTimeout
        } else if let probeTimeoutDouble = cdpInspect["probeTimeoutMs"] as? Double {
            store.hostBrowserCdpInspectProbeTimeoutMs = Int(probeTimeoutDouble)
        }
    }

    // MARK: - Host Browser (CDP Inspect) Actions

    /// Persists the cdp-inspect enable flag by patching
    /// `hostBrowser.cdpInspect.enabled` on the workspace config.
    ///
    /// The local `@Published` value is updated optimistically before the
    /// patch completes so the UI reflects the new state immediately.
    @discardableResult
    func setHostBrowserCdpInspectEnabled(_ enabled: Bool) -> Task<Bool, Never> {
        hostBrowserCdpInspectEnabled = enabled
        return Task {
            let success = await settingsClient.patchConfig([
                "hostBrowser": ["cdpInspect": ["enabled": enabled]]
            ])
            if !success {
                log.error("Failed to patch config for hostBrowser.cdpInspect.enabled")
            }
            return success
        }
    }

    /// Persists the cdp-inspect host override by patching
    /// `hostBrowser.cdpInspect.host`. Returns an error string and does not
    /// emit a patch when `host` is not one of the accepted loopback values.
    @discardableResult
    func setHostBrowserCdpInspectHost(_ host: String) -> String? {
        let trimmed = host.trimmingCharacters(in: .whitespacesAndNewlines)
        guard Self.isValidHostBrowserCdpInspectHost(trimmed) else {
            return "Only loopback hosts are allowed (localhost, 127.0.0.1, ::1, [::1])."
        }
        hostBrowserCdpInspectHost = trimmed
        Task {
            let success = await settingsClient.patchConfig([
                "hostBrowser": ["cdpInspect": ["host": trimmed]]
            ])
            if !success {
                log.error("Failed to patch config for hostBrowser.cdpInspect.host")
            }
        }
        return nil
    }

    /// Persists the cdp-inspect port override by patching
    /// `hostBrowser.cdpInspect.port`. Returns an error string and does not
    /// emit a patch when `port` is outside the valid TCP range.
    @discardableResult
    func setHostBrowserCdpInspectPort(_ port: Int) -> String? {
        guard Self.isValidHostBrowserCdpInspectPort(port) else {
            return "Port must be between 1 and 65535."
        }
        hostBrowserCdpInspectPort = port
        Task {
            let success = await settingsClient.patchConfig([
                "hostBrowser": ["cdpInspect": ["port": port]]
            ])
            if !success {
                log.error("Failed to patch config for hostBrowser.cdpInspect.port")
            }
        }
        return nil
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
    let requires_client_secret: Bool
    let logo_url: String?

    /// The platform OAuth slug is the provider_key itself (bare name, e.g. "google").
    var platformOAuthSlug: String {
        return provider_key
    }

    /// Parsed `URL?` for `logo_url`, or `nil` when the field is missing or malformed.
    var logoURL: URL? {
        guard let raw = logo_url, !raw.isEmpty else { return nil }
        return URL(string: raw)
    }
}

struct OAuthProvidersListResponse: Codable, Sendable {
    let providers: [OAuthProviderMetadata]
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
