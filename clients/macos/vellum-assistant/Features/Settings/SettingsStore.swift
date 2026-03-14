import AppKit
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
    @Published var maskedBraveKey: String = ""
    @Published var maskedPerplexityKey: String = ""
    @Published var maskedImageGenKey: String = ""
    @Published var maskedElevenLabsKey: String = ""

    // MARK: - Model Selection

    @Published var selectedModel: String = "claude-opus-4-6"
    @Published var configuredProviders: Set<String> = ["ollama"]
    @Published var selectedImageGenModel: String = "gemini-2.5-flash-image"

    static let availableModels: [String] = [
        "claude-opus-4-6",
        "claude-opus-4-6-fast",
        "claude-sonnet-4-6",
        "claude-haiku-4-5-20251001",
    ]

    static let modelDisplayNames: [String: String] = [
        "claude-opus-4-6": "Claude Opus 4.6",
        "claude-opus-4-6-fast": "Claude Opus 4.6 Fast",
        "claude-sonnet-4-6": "Claude Sonnet 4.6",
        "claude-haiku-4-5-20251001": "Claude Haiku 4.5",
    ]

    static let availableImageGenModels: [String] = [
        "gemini-2.5-flash-image",
        "gemini-3-pro-image-preview",
    ]

    static let imageGenModelDisplayNames: [String: String] = [
        "gemini-2.5-flash-image": "Gemini 2.5 Flash Image",
        "gemini-3-pro-image-preview": "Gemini 3 Pro Image (Preview)",
    ]

    // MARK: - Settings Values

    @Published var maxSteps: Double
    @Published var activityNotificationsEnabled: Bool
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

    // MARK: - Dev Mode

    @Published var isDevMode: Bool

    // MARK: - Trust Rules Coordination

    /// Whether any settings surface currently has a trust rules sheet open.
    /// Sourced from `DaemonClient.isTrustRulesSheetOpen` so each view can
    /// disable its button when the other surface is showing trust rules.
    @Published var isAnyTrustRulesSheetOpen = false

    // MARK: - Privacy

    /// Whether the user has opted in to sharing anonymised performance metrics (e.g. hang rate,
    /// scroll speed). Defaults to `true`. Read by the MetricKit integration (M4) to decide
    /// whether to forward payloads.
    @Published var sendPerformanceReports: Bool = UserDefaults.standard.object(forKey: "sendPerformanceReports") as? Bool ?? true

    // MARK: - Private

    private weak var daemonClient: DaemonClient?
    private var cancellables = Set<AnyCancellable>()
    private let configPath: String?

    /// Guards against stale `get` responses overwriting an optimistic
    /// toggle. Set when `setIngressEnabled` fires; cleared once a matching
    /// response arrives.
    private var pendingIngressEnabled: Bool?
    private var pendingIngressUrl: String?

    /// Last model reported by the daemon — used to skip redundant model_set calls
    /// that would otherwise reinitialize providers and evict idle sessions.
    private var lastDaemonModel: String?
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
        configPath: String? = nil,
        verificationSessionTimeoutDuration: TimeInterval = 12,
        verificationStatusPollInterval: TimeInterval = 2,
        verificationStatusPollWindow: TimeInterval = 600
    ) {
        self.daemonClient = daemonClient
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
        let storedImageGenModel = UserDefaults.standard.string(forKey: "selectedImageGenModel")
        if let storedImageGenModel, Self.availableImageGenModels.contains(storedImageGenModel) {
            self.selectedImageGenModel = storedImageGenModel
        }

        let storedMaxSteps = UserDefaults.standard.double(forKey: "maxStepsPerSession")
        self.maxSteps = storedMaxSteps == 0 ? 50 : storedMaxSteps

        // Default to enabled for notifications
        self.activityNotificationsEnabled = UserDefaults.standard.object(forKey: "activityNotificationsEnabled") as? Bool ?? true

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

        #if DEBUG
        self.isDevMode = UserDefaults.standard.object(forKey: "devModeEnabled") as? Bool ?? true
        #else
        self.isDevMode = UserDefaults.standard.bool(forKey: "devModeEnabled")
        #endif

        // Load media embed settings from workspace config
        let mediaSettings = Self.loadMediaEmbedSettings(from: configPath)
        self.mediaEmbedsEnabled = mediaSettings.enabled
        self.mediaEmbedsEnabledSince = mediaSettings.enabledSince
        self.mediaEmbedVideoAllowlistDomains = mediaSettings.domains
        self.userTimezone = Self.loadUserTimezone(from: configPath)

        // When enabledSince was defaulted to "now" (no value on disk),
        // persist it immediately so subsequent loads produce the same
        // deterministic timestamp instead of advancing each time.
        if mediaSettings.didDefaultEnabledSince {
            persistMediaEmbedState()
        }

        // React to Keychain changes from other surfaces
        NotificationCenter.default.publisher(for: .apiKeyManagerDidChange)
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in self?.refreshAPIKeyState() }
            .store(in: &cancellables)

        // Re-sync all API keys to daemon when it reconnects
        NotificationCenter.default.publisher(for: .daemonDidReconnect)
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in self?.syncAllKeysToDaemon() }
            .store(in: &cancellables)

        // maxStepsPerSession is read at session startup, so it must be persisted synchronously
        // to avoid a race where a new session reads a stale value before the debounced write fires.
        $maxSteps
            .dropFirst()
            .sink { value in UserDefaults.standard.set(value, forKey: "maxStepsPerSession") }
            .store(in: &cancellables)

        // Debounce UserDefaults writes so rapid toggle changes don't thrash disk I/O.
        // dropFirst must come before debounce: it consumes the synchronous initial emission so that
        // only genuine user-driven changes flow into debounce and are eventually persisted.
        // Placing dropFirst after debounce would cause the first real user change to be silently
        // dropped whenever it arrives within the 300ms debounce window of the initial value.
        $activityNotificationsEnabled
            .dropFirst()
            .debounce(for: .milliseconds(300), scheduler: RunLoop.main)
            .sink { value in UserDefaults.standard.set(value, forKey: "activityNotificationsEnabled") }
            .store(in: &cancellables)

        $cmdEnterToSend
            .dropFirst()
            .debounce(for: .milliseconds(300), scheduler: RunLoop.main)
            .sink { value in UserDefaults.standard.set(value, forKey: "cmdEnterToSend") }
            .store(in: &cancellables)

        $sendPerformanceReports
            .dropFirst()
            .debounce(for: .milliseconds(300), scheduler: RunLoop.main)
            .sink {
                UserDefaults.standard.set($0, forKey: "sendPerformanceReports")
                // Restart Sentry so the updated profilesSampleRate takes effect
                // (Sentry config is immutable after start). Only restart when the
                // user has opted into usage data — otherwise we'd re-enable Sentry
                // after the user explicitly disabled it.
                let collectUsageData = UserDefaults.standard.object(forKey: "collectUsageDataEnabled") as? Bool ?? true
                guard collectUsageData else { return }
                MetricKitManager.closeSentry()
                MetricKitManager.startSentry()
            }
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

        $isDevMode
            .dropFirst()
            .sink { value in UserDefaults.standard.set(value, forKey: "devModeEnabled") }
            .store(in: &cancellables)

        // Mirror DaemonClient's trust-rules-open flag so views can disable their buttons
        daemonClient?.$isTrustRulesSheetOpen
            .receive(on: RunLoop.main)
            .assign(to: &$isAnyTrustRulesSheetOpen)

        // Wire up Vercel API config response
        daemonClient?.onVercelApiConfigResponse = { [weak self] response in
            guard let self else { return }
            if response.success {
                self.hasVercelKey = response.hasToken
            }
        }

        // Wire up model info response
        daemonClient?.onModelInfo = { [weak self] response in
            guard let self else { return }
            self.lastDaemonModel = response.model
            self.selectedModel = response.model
            if let providers = response.configuredProviders {
                self.configuredProviders = Set(providers)
            }
        }

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
            self.telegramSaveInProgress = false
            if response.success {
                self.telegramHasBotToken = response.hasBotToken
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

        // Twilio config is now handled via HTTP — no callback wiring needed.

        // Wire up channel verification response
        daemonClient?.onChannelVerificationSessionResponse = { [weak self] response in
            guard let self else { return }
            guard let channel = self.resolveVerificationResponseChannel(response.channel) else { return }
            let isStatusPoll = response.success && response.secret == nil && response.instruction == nil && response.bound != true
            if !isStatusPoll {
                self.clearVerificationSessionPending(for: channel)
            }

            switch channel {
            case "telegram":
                self.telegramVerificationInProgress = false
                if response.success {
                    self.telegramVerificationIdentity = response.guardianExternalUserId
                    self.telegramVerificationUsername = Self.reflectedString(response, key: "guardianUsername")
                    self.telegramVerificationDisplayName = Self.reflectedString(response, key: "guardianDisplayName")
                    let isVerified = response.bound ?? false
                    self.telegramVerificationVerified = isVerified
                    if isVerified {
                        self.telegramVerificationInstruction = nil
                    } else if let instruction = response.instruction {
                        self.telegramVerificationInstruction = instruction
                    }
                    self.telegramVerificationError = nil
                    self.telegramVerificationAlreadyBound = false
                } else {
                    let isAlreadyBound = response.error == "already_bound"
                    self.telegramVerificationAlreadyBound = isAlreadyBound
                    self.telegramVerificationError = isAlreadyBound
                        ? "A guardian is already bound. Revoke it first or replace it."
                        : response.error
                }
            case "phone":
                self.voiceVerificationInProgress = false
                if response.success {
                    self.voiceVerificationIdentity = response.guardianExternalUserId
                    self.voiceVerificationUsername = Self.reflectedString(response, key: "guardianUsername")
                    self.voiceVerificationDisplayName = Self.reflectedString(response, key: "guardianDisplayName")
                    let isVerified = response.bound ?? false
                    self.voiceVerificationVerified = isVerified
                    if isVerified {
                        self.voiceVerificationInstruction = nil
                    } else if let instruction = response.instruction {
                        self.voiceVerificationInstruction = instruction
                    }
                    self.voiceVerificationError = nil
                    self.voiceVerificationAlreadyBound = false
                } else {
                    let isAlreadyBound = response.error == "already_bound"
                    self.voiceVerificationAlreadyBound = isAlreadyBound
                    self.voiceVerificationError = isAlreadyBound
                        ? "A guardian is already bound. Revoke it first or replace it."
                        : response.error
                }
            case "slack":
                self.slackVerificationInProgress = false
                if response.success {
                    self.slackVerificationIdentity = response.guardianExternalUserId
                    self.slackVerificationUsername = Self.reflectedString(response, key: "guardianUsername")
                    self.slackVerificationDisplayName = Self.reflectedString(response, key: "guardianDisplayName")
                    let isVerified = response.bound ?? false
                    self.slackVerificationVerified = isVerified
                    if isVerified {
                        self.slackVerificationInstruction = nil
                    } else if let instruction = response.instruction {
                        self.slackVerificationInstruction = instruction
                    }
                    self.slackVerificationError = nil
                    self.slackVerificationAlreadyBound = false
                } else {
                    let isAlreadyBound = response.error == "already_bound"
                    self.slackVerificationAlreadyBound = isAlreadyBound
                    self.slackVerificationError = isAlreadyBound
                        ? "A guardian is already bound. Revoke it first or replace it."
                        : response.error
                }
            default:
                break
            }

            // Handle outbound verification session state
            if response.success {
                if response.verificationSessionId != nil {
                    self.applyOutboundResponseState(channel: channel, response: response)
                    self.startVerificationStatusPolling(for: channel)
                } else if response.secret != nil || response.instruction != nil {
                    self.startVerificationStatusPolling(for: channel)
                } else if response.bound == true {
                    self.clearOutboundState(for: channel)
                    self.stopVerificationStatusPolling(for: channel)
                }
            } else {
                // Errors that indicate the outbound session is no longer valid
                // should clear the outbound UI state so the user isn't stuck
                // in the pending verification view.
                let terminalErrors: Set<String> = ["no_active_session", "already_bound"]
                if let error = response.error, terminalErrors.contains(error) {
                    self.clearOutboundState(for: channel)
                }
                self.stopVerificationStatusPolling(for: channel)
            }
        }

        // Refresh Vercel key state on init
        refreshVercelKeyState()

        // Fetch current model from daemon
        do {
            try daemonClient?.sendModelGet()
        } catch {
            log.error("Failed to send model get request: \(error)")
        }

        // Refresh Telegram integration status on init
        refreshTelegramStatus()

        // Refresh Twilio integration status on init
        refreshTwilioStatus()

        // Refresh channel verification status on init
        refreshChannelVerificationStatus(channel: "telegram")
        refreshChannelVerificationStatus(channel: "phone")
        refreshChannelVerificationStatus(channel: "slack")

        // Ingress config is refreshed by onAppear in SettingsPanel,
        // not here, to avoid duplicate get requests whose
        // stale responses could overwrite an optimistic toggle.
    }

    // MARK: - API Key Actions

    func saveAPIKey(_ raw: String) {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        APIKeyManager.setKey(trimmed, for: "anthropic")
        removeDeletionTombstone(type: "api_key", name: "anthropic")
        syncKeyToDaemon(provider: "anthropic", value: trimmed)
        hasKey = true
        maskedKey = Self.maskKey(trimmed)
    }

    func clearAPIKey() {
        APIKeyManager.deleteKey(for: "anthropic")
        addDeletionTombstone(type: "api_key", name: "anthropic")
        deleteKeyFromDaemon(provider: "anthropic")
        hasKey = false
        maskedKey = ""
    }

    func saveBraveKey(_ raw: String) {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        APIKeyManager.setKey(trimmed, for: "brave")
        removeDeletionTombstone(type: "api_key", name: "brave")
        syncKeyToDaemon(provider: "brave", value: trimmed)
        hasBraveKey = true
        maskedBraveKey = Self.maskKey(trimmed)
    }

    func clearBraveKey() {
        APIKeyManager.deleteKey(for: "brave")
        addDeletionTombstone(type: "api_key", name: "brave")
        deleteKeyFromDaemon(provider: "brave")
        hasBraveKey = false
        maskedBraveKey = ""
    }

    func savePerplexityKey(_ raw: String) {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        APIKeyManager.setKey(trimmed, for: "perplexity")
        removeDeletionTombstone(type: "api_key", name: "perplexity")
        syncKeyToDaemon(provider: "perplexity", value: trimmed)
        hasPerplexityKey = true
        maskedPerplexityKey = Self.maskKey(trimmed)
    }

    func clearPerplexityKey() {
        APIKeyManager.deleteKey(for: "perplexity")
        addDeletionTombstone(type: "api_key", name: "perplexity")
        deleteKeyFromDaemon(provider: "perplexity")
        hasPerplexityKey = false
        maskedPerplexityKey = ""
    }

    func saveImageGenKey(_ raw: String) {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        APIKeyManager.setKey(trimmed, for: "gemini")
        removeDeletionTombstone(type: "api_key", name: "gemini")
        syncKeyToDaemon(provider: "gemini", value: trimmed)
        hasImageGenKey = true
        maskedImageGenKey = Self.maskKey(trimmed)
    }

    func clearImageGenKey() {
        APIKeyManager.deleteKey(for: "gemini")
        addDeletionTombstone(type: "api_key", name: "gemini")
        deleteKeyFromDaemon(provider: "gemini")
        hasImageGenKey = false
        maskedImageGenKey = ""
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

    func setImageGenModel(_ model: String) {
        selectedImageGenModel = model
        UserDefaults.standard.set(model, forKey: "selectedImageGenModel")
        do {
            try daemonClient?.sendImageGenModelSet(model: model)
        } catch {
            log.error("Failed to send image gen model set: \(error)")
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
        do {
            try daemonClient?.sendVercelApiConfig(action: "get")
        } catch {
            log.error("Failed to send Vercel API config get: \(error)")
        }
    }

    // MARK: - Telegram Integration Actions

    func refreshTelegramStatus() {
        do {
            guard let daemonClient else { return }
            try daemonClient.sendTelegramConfig(action: "get")
        } catch {
            log.error("Failed to send Telegram config get: \(error)")
        }
    }

    func saveTelegramToken(botToken: String) {
        let trimmed = botToken.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        telegramSaveInProgress = true
        telegramError = nil
        do {
            guard let daemonClient else {
                telegramSaveInProgress = false
                return
            }
            try daemonClient.sendTelegramConfig(action: "set", botToken: trimmed)
        } catch {
            telegramSaveInProgress = false
            telegramError = "Failed to save: \(error.localizedDescription)"
        }
    }

    func clearTelegramCredentials() {
        telegramSaveInProgress = true
        telegramError = nil
        do {
            guard let daemonClient else {
                telegramSaveInProgress = false
                return
            }
            try daemonClient.sendTelegramConfig(action: "clear")
        } catch {
            telegramSaveInProgress = false
            log.error("Failed to send Telegram config clear: \(error)")
        }
    }

    // MARK: - Slack Channel Actions (HTTP-first)

    /// Builds an authenticated URLRequest for the daemon's runtime HTTP server (local mode)
    /// or the platform assistant proxy (managed mode).
    ///
    /// - Local: `http://localhost:{port}/{path}` with `Authorization: Bearer {jwt}`
    /// - Managed: `{platformBaseURL}/v1/assistants/{id}/{path}/` with `X-Session-Token` + `Vellum-Organization-Id`
    private func buildDaemonRequest(path: String, method: String) -> URLRequest? {
        let connectedId = UserDefaults.standard.string(forKey: "connectedAssistantId")
        let assistant = connectedId.flatMap { LockfileAssistant.loadByName($0) }
        if let assistant, assistant.isManaged {
            return Self.buildManagedAssistantProxyRequest(
                baseURL: assistant.runtimeUrl ?? AuthService.shared.baseURL,
                assistantId: assistant.assistantId,
                path: path,
                method: method,
                sessionToken: SessionTokenManager.getToken(),
                organizationId: UserDefaults.standard.string(forKey: "connectedOrganizationId")
            )
        }

        // Local mode: direct to daemon runtime HTTP server.
        // Use the lockfile assistant's daemon port so multi-instance switching
        // targets the correct daemon (not always the default 7821).
        let port = assistant?.daemonPort
            ?? Int(ProcessInfo.processInfo.environment["RUNTIME_HTTP_PORT"] ?? "")
            ?? 7821
        guard let token = ActorTokenManager.getToken(), !token.isEmpty else { return nil }
        guard let url = URL(string: "http://localhost:\(port)/\(path)") else { return nil }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 5
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        return request
    }

    /// Managed requests must fail closed without a session token so callers
    /// preserve work for later retry instead of sending unauthenticated writes.
    nonisolated static func buildManagedAssistantProxyRequest(
        baseURL: String,
        assistantId: String,
        path: String,
        method: String,
        sessionToken: String?,
        organizationId: String?
    ) -> URLRequest? {
        guard let token = sessionToken, !token.isEmpty else { return nil }
        // Strip "v1/" prefix — the platform proxy already namespaces under /v1/assistants/{id}/
        let proxyPath = path.hasPrefix("v1/") ? String(path.dropFirst(3)) : path
        // Django URL convention: trailing slash
        let trailingSlash = proxyPath.hasSuffix("/") ? "" : "/"
        guard let url = URL(string: "\(baseURL)/v1/assistants/\(assistantId)/\(proxyPath)\(trailingSlash)") else { return nil }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 5
        request.setValue(token, forHTTPHeaderField: "X-Session-Token")
        if let orgId = organizationId, !orgId.isEmpty {
            request.setValue(orgId, forHTTPHeaderField: "Vellum-Organization-Id")
        }
        return request
    }

    /// Whether the daemon HTTP endpoint is reachable (for tombstone replay gating).
    private func isDaemonHTTPAvailable() -> Bool {
        return buildDaemonRequest(path: "v1/secrets", method: "GET") != nil
    }

    // MARK: - Daemon Key Sync (HTTP)

    /// Notify the daemon that an API key was set, so it updates its encrypted store.
    private func syncKeyToDaemon(provider: String, value: String) {
        guard var request = buildDaemonRequest(path: "v1/secrets", method: "POST") else { return }
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body: [String: String] = ["type": "api_key", "name": provider, "value": value]
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        Task.detached {
            _ = try? await URLSession.shared.data(for: request)
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
    private func removeDeletionTombstone(type: String, name: String) {
        var tombstones = UserDefaults.standard.array(forKey: kPendingKeyDeletionTombstones)
            as? [[String: String]] ?? []
        tombstones.removeAll { $0["type"] == type && $0["name"] == name }
        UserDefaults.standard.set(tombstones, forKey: kPendingKeyDeletionTombstones)
    }

    /// Replay pending deletion tombstones, clearing only those successfully dispatched.
    private func replayDeletionTombstones() {
        let tombstones = UserDefaults.standard.array(forKey: kPendingKeyDeletionTombstones)
            as? [[String: String]] ?? []
        guard !tombstones.isEmpty else { return }
        // Bail out early if the HTTP endpoint is unavailable — preserve all tombstones
        // for the next reconnect attempt.
        guard isDaemonHTTPAvailable() else { return }
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
        guard var request = buildDaemonRequest(path: "v1/secrets", method: "DELETE") else { return false }
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body: [String: String] = ["type": "api_key", "name": provider]
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        Task.detached {
            _ = try? await URLSession.shared.data(for: request)
        }
        return true
    }

    /// Notify the daemon that a credential was set (type: "credential", name: "service:field").
    private func syncCredentialToDaemon(name: String, value: String) {
        guard var request = buildDaemonRequest(path: "v1/secrets", method: "POST") else { return }
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body: [String: String] = ["type": "credential", "name": name, "value": value]
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        Task.detached {
            _ = try? await URLSession.shared.data(for: request)
        }
    }

    /// Notify the daemon that a credential was deleted.
    /// Returns true if the HTTP endpoint was available and the request was dispatched.
    @discardableResult
    private func deleteCredentialFromDaemon(name: String) -> Bool {
        guard var request = buildDaemonRequest(path: "v1/secrets", method: "DELETE") else { return false }
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body: [String: String] = ["type": "credential", "name": name]
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        Task.detached {
            _ = try? await URLSession.shared.data(for: request)
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
        guard var request = buildDaemonRequest(path: "v1/integrations/slack/channel/config", method: "GET") else { return }
        request.timeoutInterval = 10
        Task {
            do {
                let (data, response) = try await URLSession.shared.data(for: request)
                guard let httpResp = response as? HTTPURLResponse else { return }
                if httpResp.statusCode == 200 {
                    if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                        self.slackChannelHasBotToken = json["hasBotToken"] as? Bool ?? false
                        self.slackChannelHasAppToken = json["hasAppToken"] as? Bool ?? false
                        self.slackChannelConnected = json["connected"] as? Bool ?? false
                        self.slackChannelBotUsername = json["botUsername"] as? String
                        self.slackChannelBotUserId = json["botUserId"] as? String
                        self.slackChannelTeamId = json["teamId"] as? String
                        self.slackChannelTeamName = json["teamName"] as? String
                        self.slackChannelError = nil
                    }
                } else if httpResp.statusCode == 404 {
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
        guard var request = buildDaemonRequest(path: "v1/integrations/slack/channel/config", method: "POST") else {
            slackChannelSaveInProgress = false
            return
        }
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 10
        let body: [String: String] = ["botToken": trimmedBot, "appToken": trimmedApp]
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        Task {
            do {
                let (data, response) = try await URLSession.shared.data(for: request)
                self.slackChannelSaveInProgress = false
                guard let httpResp = response as? HTTPURLResponse else { return }
                if (200..<300).contains(httpResp.statusCode) {
                    if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
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
                    if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                       let msg = json["error"] as? String {
                        errorMsg = msg
                    } else {
                        errorMsg = "HTTP \(httpResp.statusCode)"
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
        guard var request = buildDaemonRequest(path: "v1/integrations/slack/channel/config", method: "DELETE") else {
            slackChannelSaveInProgress = false
            return
        }
        request.timeoutInterval = 10
        Task {
            do {
                let (_, response) = try await URLSession.shared.data(for: request)
                guard let httpResp = response as? HTTPURLResponse else {
                    self.slackChannelSaveInProgress = false
                    self.fetchChannelSetupStatus()
                    return
                }
                if (200..<300).contains(httpResp.statusCode) {
                    self.slackChannelHasBotToken = false
                    self.slackChannelHasAppToken = false
                    self.slackChannelConnected = false
                    self.slackChannelBotUsername = nil
                    self.slackChannelBotUserId = nil
                    self.slackChannelTeamId = nil
                    self.slackChannelTeamName = nil
                    self.slackChannelError = nil
                    self.fetchChannelSetupStatus()
                } else {
                    self.slackChannelError = "Failed to disconnect: HTTP \(httpResp.statusCode)"
                    self.fetchChannelSetupStatus()
                }
                self.slackChannelSaveInProgress = false
            } catch {
                self.slackChannelSaveInProgress = false
                self.slackChannelError = error.localizedDescription
                self.fetchChannelSetupStatus()
                log.error("Failed to clear Slack channel config: \(error)")
            }
        }
    }

    // MARK: - Twilio Actions (HTTP)

    /// Resolve the gateway base URL and bearer token for Twilio HTTP calls.
    /// Uses httpTransport for remote connections, otherwise defaults to local gateway.
    private func resolveTwilioHTTPEndpoint() -> (baseURL: String, bearerToken: String?)? {
        if let httpTransport = daemonClient?.httpTransport {
            return (httpTransport.baseURL, httpTransport.bearerToken)
        }
        // Local mode: call the gateway directly.
        let gatewayPort = LockfilePaths.resolveGatewayPort()
        let baseURL = "http://127.0.0.1:\(gatewayPort)"
        let bearerToken = ActorTokenManager.getToken()
        return (baseURL, bearerToken)
    }

    /// Shared helper: perform a Twilio HTTP request, decode the JSON response,
    /// and apply the result to @Published properties on the main actor.
    private func performTwilioHTTPRequest(
        method: String,
        path: String,
        body: [String: Any]? = nil,
        applyPhoneNumber: Bool = false,
        applyNumbers: Bool = false
    ) async {
        guard let endpoint = resolveTwilioHTTPEndpoint(),
              let url = URL(string: "\(endpoint.baseURL)\(path)") else {
            twilioError = "No HTTP endpoint available"
            return
        }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 30
        // Use the JWT access token as the sole Authorization bearer.
        // Falls back to the legacy runtime bearer token if no JWT is available.
        if let accessToken = ActorTokenManager.getToken(), !accessToken.isEmpty {
            request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        } else if let token = endpoint.bearerToken, !token.isEmpty {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        }

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                twilioError = "Invalid response"
                return
            }
            guard (200..<300).contains(http.statusCode) else {
                let errorBody = String(data: data, encoding: .utf8) ?? "HTTP \(http.statusCode)"
                twilioError = "Request failed: \(errorBody)"
                return
            }

            // Decode the response JSON
            guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
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
                path: "/v1/integrations/twilio/config",
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
                path: "/v1/integrations/twilio/credentials",
                body: ["accountSid": trimmedSid, "authToken": trimmedToken]
            )
            twilioSaveInProgress = false
            self.fetchChannelSetupStatus()
        }
    }

    func clearTwilioCredentials() {
        twilioSaveInProgress = true
        twilioError = nil
        twilioWarning = nil
        Task {
            await performTwilioHTTPRequest(
                method: "DELETE",
                path: "/v1/integrations/twilio/credentials"
            )
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
                path: "/v1/integrations/twilio/numbers/assign",
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
                path: "/v1/integrations/twilio/numbers/provision",
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
                path: "/v1/integrations/twilio/numbers",
                applyNumbers: true
            )
            twilioListInProgress = false
        }
    }

    // MARK: - Channel Verification Actions

    func refreshChannelVerificationStatus(channel: String) {
        do {
            try daemonClient?.sendChannelVerificationSession(action: "status", channel: channel)
        } catch {
            log.error("Failed to refresh \(channel) verification status: \(error)")
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
        let sessionId = response.verificationSessionId
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
            if sessionId != telegramOutboundSessionId {
                telegramOutboundNextResendAt = nil
                telegramOutboundSendCount = 0
                telegramOutboundCode = nil
            }
            telegramOutboundSessionId = sessionId
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
            } else if sessionId != nil {
                // Bootstrap complete — clear the URL so resend becomes available
                telegramBootstrapUrl = nil
            }
        case "phone":
            if sessionId != voiceOutboundSessionId {
                voiceOutboundNextResendAt = nil
                voiceOutboundSendCount = 0
                voiceOutboundCode = nil
            }
            voiceOutboundSessionId = sessionId
            if let expiresAt { voiceOutboundExpiresAt = expiresAt }
            if let nextResendAt { voiceOutboundNextResendAt = nextResendAt }
            if let sendCount { voiceOutboundSendCount = sendCount }
            if let secret { voiceOutboundCode = secret }
        case "slack":
            if sessionId != slackOutboundSessionId {
                slackOutboundNextResendAt = nil
                slackOutboundSendCount = 0
                slackOutboundCode = nil
            }
            slackOutboundSessionId = sessionId
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
        guard let daemonClient else { return }
        let gatewayURL = localGatewayTarget
        Task {
            let status = await daemonClient.fetchIntegrationsStatus(gatewayBaseURL: gatewayURL)
            self.assistantEmail = status?.email.address
        }
    }

    // MARK: - Channel Setup Status

    func fetchChannelSetupStatus() {
        Task {
            do {
                guard let daemonClient else { return }
                let readiness = try await daemonClient.fetchChannelReadiness()
                for (channel, info) in readiness {
                    self.channelSetupStatus[channel] = info.setupStatus ?? "not_configured"
                }
            } catch {
                log.error("Failed to fetch channel setup status: \(error)")
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
        guard let daemonClient else { return }
        daemonClient.onApprovedDevicesListResponse = { [weak self] msg in
            self?.approvedDevices = msg.devices
        }
        try? daemonClient.sendApprovedDevicesList()
    }

    func removeApprovedDevice(hashedDeviceId: String) {
        guard let daemonClient else { return }
        let removed = approvedDevices.filter { $0.hashedDeviceId == hashedDeviceId }
        approvedDevices.removeAll { $0.hashedDeviceId == hashedDeviceId }
        do {
            try daemonClient.sendApprovedDeviceRemove(hashedDeviceId: hashedDeviceId)
        } catch {
            // Send failed — restore optimistically removed devices
            approvedDevices.append(contentsOf: removed)
        }
    }

    func clearAllApprovedDevices() {
        guard let daemonClient else { return }
        do {
            try daemonClient.sendApprovedDevicesClear()
            approvedDevices = []
        } catch {
            // Send failed — don't clear local state
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
        return "http://\(ip):\(LockfilePaths.resolveGatewayPort())"
    }

    // MARK: - Dev Mode Actions

    func toggleDevMode() {
        isDevMode.toggle()
    }

    // MARK: - Model Actions

    func setModel(_ model: String) {
        guard model != lastDaemonModel else { return }
        guard let daemonClient else { return }
        do {
            try daemonClient.sendModelSet(model: model)
            lastDaemonModel = model
        } catch {
            // Send failed — don't update lastDaemonModel so the next attempt isn't suppressed
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
