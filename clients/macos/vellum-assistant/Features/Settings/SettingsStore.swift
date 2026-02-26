import Carbon.HIToolbox
import Combine
import Foundation
import os
import VellumAssistantShared

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "SettingsStore")

// MARK: - Activity Log Entry model

/// A single recorded child-profile action surfaced in the parent's Activity Log view.
public struct ActivityLogEntry: Codable, Identifiable {
    public let id: String
    /// ISO 8601 timestamp of when the action occurred.
    public let timestamp: String
    /// Broad category: "tool_call", "request", or "approval_request".
    public let actionType: String
    /// Human-readable description of what happened.
    public let description: String
}

/// Single source of truth for settings state shared between `SettingsPanel`
/// (main window side panel) and its extracted tab views.
@MainActor
public final class SettingsStore: ObservableObject {
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

    // MARK: - Media Embed Settings

    @Published var mediaEmbedsEnabled: Bool
    @Published var mediaEmbedsEnabledSince: Date?
    @Published var mediaEmbedVideoAllowlistDomains: [String]

    // MARK: - Twitter Integration State

    @Published var twitterMode: String = "local_byo"
    @Published var twitterManagedAvailable: Bool = false
    @Published var twitterLocalClientConfigured: Bool = false
    @Published var twitterConnected: Bool = false
    @Published var twitterAccountInfo: String?
    @Published var twitterAuthInProgress: Bool = false
    @Published var twitterAuthError: String?

    // MARK: - Telegram Integration State

    @Published var telegramHasBotToken: Bool = false
    @Published var telegramBotUsername: String?
    @Published var telegramConnected: Bool = false
    @Published var telegramHasWebhookSecret: Bool = false
    @Published var telegramSaveInProgress: Bool = false
    @Published var telegramError: String?

    // MARK: - Twilio SMS Integration State

    @Published var twilioHasCredentials: Bool = false
    @Published var twilioPhoneNumber: String?
    @Published var twilioNumbers: [TwilioNumberInfo] = []
    @Published var twilioSaveInProgress: Bool = false
    @Published var twilioListInProgress: Bool = false
    @Published var twilioWarning: String?
    @Published var twilioError: String?

    // MARK: - Channel Guardian State (Telegram)

    @Published var telegramGuardianIdentity: String?
    @Published var telegramGuardianUsername: String?
    @Published var telegramGuardianDisplayName: String?
    @Published var telegramGuardianVerified: Bool = false
    @Published var telegramGuardianVerificationInProgress: Bool = false
    @Published var telegramGuardianInstruction: String?
    @Published var telegramGuardianError: String?
    @Published var telegramGuardianAlreadyBound: Bool = false

    // MARK: - Channel Guardian State (SMS)

    @Published var smsGuardianIdentity: String?
    @Published var smsGuardianUsername: String?
    @Published var smsGuardianDisplayName: String?
    @Published var smsGuardianVerified: Bool = false
    @Published var smsGuardianVerificationInProgress: Bool = false
    @Published var smsGuardianInstruction: String?
    @Published var smsGuardianError: String?
    @Published var smsGuardianAlreadyBound: Bool = false

    // MARK: - Channel Guardian State (Voice)

    @Published var voiceGuardianIdentity: String?
    @Published var voiceGuardianUsername: String?
    @Published var voiceGuardianDisplayName: String?
    @Published var voiceGuardianVerified: Bool = false
    @Published var voiceGuardianVerificationInProgress: Bool = false
    @Published var voiceGuardianInstruction: String?
    @Published var voiceGuardianError: String?
    @Published var voiceGuardianAlreadyBound: Bool = false

    // MARK: - Outbound Guardian Session State (Telegram)

    @Published var telegramOutboundSessionId: String?
    @Published var telegramOutboundExpiresAt: Date?
    @Published var telegramOutboundNextResendAt: Date?
    @Published var telegramOutboundSendCount: Int = 0
    @Published var telegramBootstrapUrl: String?
    @Published var telegramOutboundCode: String?

    // MARK: - Outbound Guardian Session State (SMS)

    @Published var smsOutboundSessionId: String?
    @Published var smsOutboundExpiresAt: Date?
    @Published var smsOutboundNextResendAt: Date?
    @Published var smsOutboundSendCount: Int = 0
    @Published var smsOutboundCode: String?

    // MARK: - Outbound Guardian Session State (Voice)

    @Published var voiceOutboundSessionId: String?
    @Published var voiceOutboundExpiresAt: Date?
    @Published var voiceOutboundNextResendAt: Date?
    @Published var voiceOutboundSendCount: Int = 0
    @Published var voiceOutboundCode: String?

    // MARK: - Email Integration State

    @Published var assistantEmail: String?

    // MARK: - Platform Config State

    @Published var platformBaseUrl: String = ""
    private var pendingPlatformUrl: String?

    // MARK: - Ingress Config State

    @Published var ingressEnabled: Bool = false
    @Published var ingressPublicBaseUrl: String = ""
    /// Read-only gateway target derived from daemon config (GATEWAY_PORT env var, default 7830).
    @Published var localGatewayTarget: String = "http://127.0.0.1:7830"

    /// Set to `true` once the first ingress config IPC response arrives, so the
    /// view layer can defer diagnostics until the real config values are available.
    @Published var ingressConfigLoaded: Bool = false

    // MARK: - Connection Health Check State

    @Published var gatewayReachable: Bool?
    @Published var ingressReachable: Bool?
    @Published var gatewayLastChecked: Date?
    @Published var isCheckingGateway: Bool = false
    @Published var isCheckingTunnel: Bool = false
    @Published var tunnelLastChecked: Date?

    @Published var vellumPlatformReachable: Bool?
    @Published var vellumPlatformError: String?
    @Published var isCheckingVellumPlatform: Bool = false
    @Published var platformLastChecked: Date?

    // MARK: - Parental Control Profile State

    /// The currently active profile. "parental" means full access; "child" means restricted mode.
    @Published var activeProfile: String = "parental"
    /// Set when a profile switch fails so the UI can surface the error.
    @Published var profileSwitchError: String?

    /// Whether parental controls are currently enabled. Kept in sync via IPC responses.
    @Published var isParentalEnabled: Bool = false

    /// Allowlisted app names for the child profile. Empty means all apps are allowed.
    @Published var allowedApps: [String] = []
    /// Allowlisted widget names for the child profile. Empty means all widgets are allowed.
    @Published var allowedWidgets: [String] = []
    /// Allowlisted integration names for the child profile. Empty means all integrations are blocked.
    @Published var allowedIntegrations: [String] = []

    /// Per-app daily time limits in minutes (0 = unlimited). Keyed by app name.
    @Published var appTimeLimits: [String: Int] = [:]
    /// Minutes each allowlisted app has been used today. Keyed by app name.
    @Published var appUsageToday: [String: Int] = [:]

    /// Activity log entries recorded while the child profile was active.
    @Published var activityLog: [ActivityLogEntry] = []

    // MARK: - Dev Mode

    @Published var isDevMode: Bool

    // MARK: - Trust Rules Coordination

    /// Whether any settings surface currently has a trust rules sheet open.
    /// Sourced from `DaemonClient.isTrustRulesSheetOpen` so each view can
    /// disable its button when the other surface is showing trust rules.
    @Published var isAnyTrustRulesSheetOpen = false

    // MARK: - Private

    private weak var daemonClient: DaemonClient?
    private var cancellables = Set<AnyCancellable>()
    private let configPath: String?

    /// Guards against stale IPC `get` responses overwriting an optimistic
    /// toggle. Set when `setIngressEnabled` fires; cleared once a matching
    /// response arrives.
    private var pendingIngressEnabled: Bool?
    private var pendingIngressUrl: String?

    /// Last model reported by the daemon — used to skip redundant model_set calls
    /// that would otherwise reinitialize providers and evict idle sessions.
    private var lastDaemonModel: String?
    private var twilioAssistantScope: String {
        let stored = UserDefaults.standard.string(forKey: "connectedAssistantId")?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if let stored, !stored.isEmpty {
            return stored
        }
        return "self"
    }
    private var twilioPhoneRefreshPending = false
    private var twilioNumbersRefreshPending = false
    private var pendingGuardianChallengeChannel: String?
    private var guardianChallengeTimeoutWorkItem: DispatchWorkItem?
    private var guardianStatusPollingWorkItems: [String: DispatchWorkItem] = [:]
    private var guardianStatusPollingDeadlines: [String: Date] = [:]
    private let guardianChallengeTimeoutDuration: TimeInterval
    private let guardianStatusPollInterval: TimeInterval
    private let guardianStatusPollWindow: TimeInterval
    private var guardianAssistantScope: String {
        let stored = UserDefaults.standard.string(forKey: "connectedAssistantId")?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if let stored, !stored.isEmpty {
            return stored
        }
        return "self"
    }

    private static func reflectedString(_ value: Any, key: String) -> String? {
        for child in Mirror(reflecting: value).children {
            guard child.label == key else { continue }
            return child.value as? String
        }
        return nil
    }

    init(
        daemonClient: DaemonClient? = nil,
        configPath: String? = nil,
        guardianChallengeTimeoutDuration: TimeInterval = 12,
        guardianStatusPollInterval: TimeInterval = 2,
        guardianStatusPollWindow: TimeInterval = 600
    ) {
        self.daemonClient = daemonClient
        self.configPath = configPath
        self.guardianChallengeTimeoutDuration = max(0.05, guardianChallengeTimeoutDuration)
        self.guardianStatusPollInterval = max(0.05, guardianStatusPollInterval)
        self.guardianStatusPollWindow = max(self.guardianStatusPollInterval, guardianStatusPollWindow)

        // Seed from UserDefaults / Keychain
        let anthropicKey = APIKeyManager.getKey()
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

        self.globalHotkeyShortcut = UserDefaults.standard.string(forKey: "globalHotkeyShortcut") ?? "cmd+shift+g"
        self.quickInputHotkeyShortcut = UserDefaults.standard.string(forKey: "quickInputHotkeyShortcut") ?? "cmd+shift+/"
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

        // Wire up Vercel API config IPC response
        daemonClient?.onVercelApiConfigResponse = { [weak self] response in
            guard let self else { return }
            if response.success {
                self.hasVercelKey = response.hasToken
            }
        }

        // Wire up model info IPC response
        daemonClient?.onModelInfo = { [weak self] response in
            guard let self else { return }
            self.lastDaemonModel = response.model
            self.selectedModel = response.model
            if let providers = response.configuredProviders {
                self.configuredProviders = Set(providers)
            }
        }

        // Wire up Twitter integration config IPC response
        daemonClient?.onTwitterIntegrationConfigResponse = { [weak self] response in
            guard let self else { return }
            if response.success {
                self.twitterMode = response.mode ?? "local_byo"
                self.twitterManagedAvailable = response.managedAvailable
                self.twitterLocalClientConfigured = response.localClientConfigured
                self.twitterConnected = response.connected
                self.twitterAccountInfo = response.accountInfo
            }
        }

        // Wire up ingress config IPC response
        daemonClient?.onIngressConfigResponse = { [weak self] response in
            guard let self else { return }
            self.localGatewayTarget = response.localGatewayTarget
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

        // Wire up platform config IPC response
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

        // Wire up Twitter auth result IPC response
        daemonClient?.onTwitterAuthResult = { [weak self] response in
            guard let self else { return }
            self.twitterAuthInProgress = false
            if response.success {
                self.twitterConnected = true
                self.twitterAccountInfo = response.accountInfo
                self.twitterAuthError = nil
            } else {
                self.twitterAuthError = response.error
            }
            self.refreshTwitterStatus()
        }

        // Wire up Telegram config IPC response
        daemonClient?.onTelegramConfigResponse = { [weak self] response in
            guard let self else { return }
            self.telegramSaveInProgress = false
            if response.success {
                self.telegramHasBotToken = response.hasBotToken
                self.telegramBotUsername = response.botUsername
                self.telegramConnected = response.connected
                self.telegramHasWebhookSecret = response.hasWebhookSecret
                self.telegramError = nil
            } else {
                self.telegramError = response.error
            }
        }

        // Wire up Twilio config IPC response
        daemonClient?.onTwilioConfigResponse = { [weak self] response in
            guard let self else { return }
            self.twilioSaveInProgress = false
            self.twilioListInProgress = false
            if response.success {
                self.twilioHasCredentials = response.hasCredentials
                if !response.hasCredentials {
                    // Credentials were confirmed removed — clear derived state
                    self.twilioPhoneNumber = nil
                    self.twilioNumbers = []
                } else if self.twilioPhoneRefreshPending || response.phoneNumber != nil {
                    self.twilioPhoneNumber = response.phoneNumber
                }
                if response.hasCredentials {
                    if self.twilioNumbersRefreshPending {
                        self.twilioNumbers = response.numbers ?? []
                    } else if let numbers = response.numbers {
                        self.twilioNumbers = numbers
                    }
                }
                self.twilioWarning = response.warning
                self.twilioError = nil
            } else {
                self.twilioWarning = response.warning
                self.twilioError = response.error
            }
            self.twilioPhoneRefreshPending = false
            self.twilioNumbersRefreshPending = false
        }

        // Wire up guardian verification IPC response
        daemonClient?.onGuardianVerificationResponse = { [weak self] response in
            guard let self else { return }
            guard let channel = self.resolveGuardianResponseChannel(response.channel) else { return }
            let isStatusPoll = response.success && response.secret == nil && response.instruction == nil && response.bound != true
            if !isStatusPoll {
                self.clearGuardianChallengePending(for: channel)
            }

            switch channel {
            case "telegram":
                self.telegramGuardianVerificationInProgress = false
                if response.success {
                    self.telegramGuardianIdentity = response.guardianExternalUserId
                    self.telegramGuardianUsername = Self.reflectedString(response, key: "guardianUsername")
                    self.telegramGuardianDisplayName = Self.reflectedString(response, key: "guardianDisplayName")
                    let isVerified = response.bound ?? false
                    self.telegramGuardianVerified = isVerified
                    if isVerified {
                        self.telegramGuardianInstruction = nil
                    } else if let instruction = response.instruction {
                        self.telegramGuardianInstruction = instruction
                    }
                    self.telegramGuardianError = nil
                    self.telegramGuardianAlreadyBound = false
                } else {
                    let isAlreadyBound = response.error == "already_bound"
                    self.telegramGuardianAlreadyBound = isAlreadyBound
                    self.telegramGuardianError = isAlreadyBound
                        ? "A guardian is already bound. Revoke it first or replace it."
                        : response.error
                }
            case "sms":
                self.smsGuardianVerificationInProgress = false
                if response.success {
                    self.smsGuardianIdentity = response.guardianExternalUserId
                    self.smsGuardianUsername = Self.reflectedString(response, key: "guardianUsername")
                    self.smsGuardianDisplayName = Self.reflectedString(response, key: "guardianDisplayName")
                    let isVerified = response.bound ?? false
                    self.smsGuardianVerified = isVerified
                    if isVerified {
                        self.smsGuardianInstruction = nil
                    } else if let instruction = response.instruction {
                        self.smsGuardianInstruction = instruction
                    }
                    self.smsGuardianError = nil
                    self.smsGuardianAlreadyBound = false
                } else {
                    let isAlreadyBound = response.error == "already_bound"
                    self.smsGuardianAlreadyBound = isAlreadyBound
                    self.smsGuardianError = isAlreadyBound
                        ? "A guardian is already bound. Revoke it first or replace it."
                        : response.error
                }
            case "voice":
                self.voiceGuardianVerificationInProgress = false
                if response.success {
                    self.voiceGuardianIdentity = response.guardianExternalUserId
                    self.voiceGuardianUsername = Self.reflectedString(response, key: "guardianUsername")
                    self.voiceGuardianDisplayName = Self.reflectedString(response, key: "guardianDisplayName")
                    let isVerified = response.bound ?? false
                    self.voiceGuardianVerified = isVerified
                    if isVerified {
                        self.voiceGuardianInstruction = nil
                    } else if let instruction = response.instruction {
                        self.voiceGuardianInstruction = instruction
                    }
                    self.voiceGuardianError = nil
                    self.voiceGuardianAlreadyBound = false
                } else {
                    let isAlreadyBound = response.error == "already_bound"
                    self.voiceGuardianAlreadyBound = isAlreadyBound
                    self.voiceGuardianError = isAlreadyBound
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
                    self.startGuardianStatusPolling(for: channel)
                } else if response.secret != nil || response.instruction != nil {
                    self.startGuardianStatusPolling(for: channel)
                } else if response.bound == true {
                    self.clearOutboundState(for: channel)
                    self.stopGuardianStatusPolling(for: channel)
                }
            } else {
                // Errors that indicate the outbound session is no longer valid
                // should clear the outbound UI state so the user isn't stuck
                // in the pending verification view.
                let terminalErrors: Set<String> = ["no_active_session", "already_bound"]
                if let error = response.error, terminalErrors.contains(error) {
                    self.clearOutboundState(for: channel)
                }
                self.stopGuardianStatusPolling(for: channel)
            }
        }

        // Wire up parental control get response — pick up activeProfile and isParentalEnabled
        // from the initial settings load so the settings gate is correctly seeded on cold start.
        daemonClient?.onParentalControlGetResponse = { [weak self] response in
            guard let self else { return }
            if let profile = response.activeProfile {
                self.activeProfile = profile
            }
            self.isParentalEnabled = response.enabled
        }

        // Wire up profile get response.
        daemonClient?.onParentalControlProfileGetResponse = { [weak self] response in
            guard let self else { return }
            self.activeProfile = response.activeProfile
        }

        // Wire up profile switch response.
        daemonClient?.onParentalControlProfileSwitchResponse = { [weak self] response in
            guard let self else { return }
            if response.success {
                self.activeProfile = response.activeProfile
                self.profileSwitchError = nil
            } else {
                self.profileSwitchError = response.error
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

        // Refresh Twitter integration status on init
        refreshTwitterStatus()

        // Refresh Telegram integration status on init
        refreshTelegramStatus()

        // Refresh Twilio integration status on init
        refreshTwilioStatus()

        // Refresh channel guardian status on init
        refreshChannelGuardianStatus(channel: "telegram")
        refreshChannelGuardianStatus(channel: "sms")
        refreshChannelGuardianStatus(channel: "voice")

        // Fetch the current active parental profile on init.
        do {
            try daemonClient?.sendParentalControlProfileGet()
        } catch {
            log.error("Failed to send parental control profile get request: \(error)")
        }

        // Eagerly fetch parental control settings on init so isParentalEnabled is
        // populated before the user can attempt to open the Settings panel. Without
        // this, the cold-start gate in AppDelegate.showSettingsWindow always sees
        // the default false value and allows settings access in child mode.
        do {
            try daemonClient?.sendParentalControlGet()
        } catch {
            log.error("Failed to send parental control get request on init: \(error)")
        }

        // Ingress config is refreshed by onAppear in SettingsPanel,
        // not here, to avoid duplicate get requests whose
        // stale responses could overwrite an optimistic toggle.
    }

    // MARK: - API Key Actions

    func saveAPIKey(_ raw: String) {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        APIKeyManager.setKey(trimmed)
        hasKey = true
        maskedKey = Self.maskKey(trimmed)
    }

    func clearAPIKey() {
        APIKeyManager.deleteKey()
        hasKey = false
        maskedKey = ""
    }

    func saveBraveKey(_ raw: String) {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        APIKeyManager.setKey(trimmed, for: "brave")
        hasBraveKey = true
        maskedBraveKey = Self.maskKey(trimmed)
    }

    func clearBraveKey() {
        APIKeyManager.deleteKey(for: "brave")
        hasBraveKey = false
        maskedBraveKey = ""
    }

    func savePerplexityKey(_ raw: String) {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        APIKeyManager.setKey(trimmed, for: "perplexity")
        hasPerplexityKey = true
        maskedPerplexityKey = Self.maskKey(trimmed)
    }

    func clearPerplexityKey() {
        APIKeyManager.deleteKey(for: "perplexity")
        hasPerplexityKey = false
        maskedPerplexityKey = ""
    }

    func saveImageGenKey(_ raw: String) {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        APIKeyManager.setKey(trimmed, for: "gemini")
        hasImageGenKey = true
        maskedImageGenKey = Self.maskKey(trimmed)
    }

    func clearImageGenKey() {
        APIKeyManager.deleteKey(for: "gemini")
        hasImageGenKey = false
        maskedImageGenKey = ""
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
        let anthropicKey = APIKeyManager.getKey()
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

    // MARK: - Twitter Integration Actions

    func refreshTwitterStatus() {
        do {
            try daemonClient?.send(TwitterIntegrationConfigRequestMessage(action: "get"))
        } catch {
            log.error("Failed to send Twitter integration config get: \(error)")
        }
    }

    func setTwitterMode(_ mode: String) {
        do {
            try daemonClient?.send(TwitterIntegrationConfigRequestMessage(action: "set_mode", mode: mode))
        } catch {
            log.error("Failed to send Twitter set_mode: \(error)")
        }
    }

    func saveTwitterLocalClient(clientId: String, clientSecret: String?) {
        let trimmedId = clientId.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedSecret = clientSecret?.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            try daemonClient?.send(TwitterIntegrationConfigRequestMessage(
                action: "set_local_client",
                clientId: trimmedId,
                clientSecret: trimmedSecret
            ))
        } catch {
            log.error("Failed to send Twitter set_local_client: \(error)")
        }
    }

    func clearTwitterLocalClient() {
        twitterAuthInProgress = false
        do {
            try daemonClient?.send(TwitterIntegrationConfigRequestMessage(action: "clear_local_client"))
        } catch {
            log.error("Failed to send Twitter clear_local_client: \(error)")
        }
    }

    func connectTwitter() {
        twitterAuthInProgress = true
        twitterAuthError = nil
        do {
            guard let daemonClient else {
                twitterAuthInProgress = false
                return
            }
            try daemonClient.send(TwitterAuthStartMessage())
        } catch {
            twitterAuthInProgress = false
        }
    }

    func disconnectTwitter() {
        twitterAuthInProgress = false
        do {
            try daemonClient?.send(TwitterIntegrationConfigRequestMessage(action: "disconnect"))
        } catch {
            log.error("Failed to send Twitter disconnect: \(error)")
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
        do {
            guard let daemonClient else { return }
            try daemonClient.sendTelegramConfig(action: "clear")
        } catch {
            log.error("Failed to send Telegram config clear: \(error)")
        }
    }

    // MARK: - Twilio SMS Actions

    func refreshTwilioStatus() {
        twilioSaveInProgress = true
        twilioPhoneRefreshPending = true
        twilioError = nil
        do {
            guard let daemonClient else {
                twilioSaveInProgress = false
                twilioPhoneRefreshPending = false
                return
            }
            try daemonClient.sendTwilioConfig(action: "get", assistantId: twilioAssistantScope)
        } catch {
            twilioSaveInProgress = false
            twilioPhoneRefreshPending = false
            twilioError = "Failed to load Twilio config: \(error.localizedDescription)"
        }
    }

    func saveTwilioCredentials(accountSid: String, authToken: String) {
        let trimmedSid = accountSid.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedToken = authToken.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedSid.isEmpty, !trimmedToken.isEmpty else { return }
        twilioSaveInProgress = true
        twilioError = nil
        twilioWarning = nil
        do {
            guard let daemonClient else {
                twilioSaveInProgress = false
                return
            }
            try daemonClient.sendTwilioConfig(
                action: "set_credentials",
                accountSid: trimmedSid,
                authToken: trimmedToken,
                assistantId: twilioAssistantScope
            )
        } catch {
            twilioSaveInProgress = false
            twilioError = "Failed to save Twilio credentials: \(error.localizedDescription)"
        }
    }

    func clearTwilioCredentials() {
        twilioSaveInProgress = true
        twilioError = nil
        twilioWarning = nil
        do {
            guard let daemonClient else {
                twilioSaveInProgress = false
                return
            }
            try daemonClient.sendTwilioConfig(action: "clear_credentials", assistantId: twilioAssistantScope)
        } catch {
            twilioSaveInProgress = false
            twilioError = "Failed to clear Twilio credentials: \(error.localizedDescription)"
        }
    }

    func assignTwilioNumber(phoneNumber: String) {
        let trimmed = phoneNumber.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        twilioSaveInProgress = true
        twilioPhoneRefreshPending = true
        twilioError = nil
        twilioWarning = nil
        do {
            guard let daemonClient else {
                twilioSaveInProgress = false
                twilioPhoneRefreshPending = false
                return
            }
            try daemonClient.sendTwilioConfig(
                action: "assign_number",
                phoneNumber: trimmed,
                assistantId: twilioAssistantScope
            )
        } catch {
            twilioSaveInProgress = false
            twilioPhoneRefreshPending = false
            twilioError = "Failed to assign Twilio number: \(error.localizedDescription)"
        }
    }

    func provisionTwilioNumber(areaCode: String?, country: String?) {
        let trimmedAreaCode = areaCode?.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedCountry = country?.trimmingCharacters(in: .whitespacesAndNewlines)
        twilioSaveInProgress = true
        twilioPhoneRefreshPending = true
        twilioError = nil
        twilioWarning = nil
        do {
            guard let daemonClient else {
                twilioSaveInProgress = false
                twilioPhoneRefreshPending = false
                return
            }
            try daemonClient.sendTwilioConfig(
                action: "provision_number",
                areaCode: (trimmedAreaCode?.isEmpty == false) ? trimmedAreaCode : nil,
                country: (trimmedCountry?.isEmpty == false) ? trimmedCountry?.uppercased() : nil,
                assistantId: twilioAssistantScope
            )
        } catch {
            twilioSaveInProgress = false
            twilioPhoneRefreshPending = false
            twilioError = "Failed to provision Twilio number: \(error.localizedDescription)"
        }
    }

    func refreshTwilioNumbers() {
        twilioListInProgress = true
        twilioNumbersRefreshPending = true
        twilioError = nil
        do {
            guard let daemonClient else {
                twilioListInProgress = false
                twilioNumbersRefreshPending = false
                return
            }
            try daemonClient.sendTwilioConfig(action: "list_numbers", assistantId: twilioAssistantScope)
        } catch {
            twilioListInProgress = false
            twilioNumbersRefreshPending = false
            twilioError = "Failed to load Twilio numbers: \(error.localizedDescription)"
        }
    }

    // MARK: - Channel Guardian Actions

    func refreshChannelGuardianStatus(channel: String) {
        do {
            try daemonClient?.sendGuardianVerification(action: "status", channel: channel, assistantId: guardianAssistantScope)
        } catch {
            log.error("Failed to refresh \(channel) guardian status: \(error)")
        }
    }

    func startChannelGuardianVerification(channel: String, rebind: Bool = false) {
        stopGuardianStatusPolling(for: channel)
        switch channel {
        case "telegram":
            telegramGuardianVerificationInProgress = true
            telegramGuardianError = nil
            telegramGuardianAlreadyBound = false
            telegramGuardianInstruction = nil
        case "sms":
            smsGuardianVerificationInProgress = true
            smsGuardianError = nil
            smsGuardianAlreadyBound = false
            smsGuardianInstruction = nil
        case "voice":
            voiceGuardianVerificationInProgress = true
            voiceGuardianError = nil
            voiceGuardianAlreadyBound = false
            voiceGuardianInstruction = nil
        default:
            return
        }
        do {
            guard let daemonClient else {
                clearGuardianChallengePending(for: channel)
                switch channel {
                case "telegram":
                    telegramGuardianVerificationInProgress = false
                    telegramGuardianError = "Daemon is not connected. Reconnect and try again."
                case "sms":
                    smsGuardianVerificationInProgress = false
                    smsGuardianError = "Daemon is not connected. Reconnect and try again."
                case "voice":
                    voiceGuardianVerificationInProgress = false
                    voiceGuardianError = "Daemon is not connected. Reconnect and try again."
                default:
                    break
                }
                return
            }
            pendingGuardianChallengeChannel = channel
            armGuardianChallengeTimeout(for: channel)
            try daemonClient.sendGuardianVerification(
                action: "create_challenge",
                channel: channel,
                assistantId: guardianAssistantScope,
                rebind: rebind ? true : nil
            )
        } catch {
            log.error("Failed to start \(channel) guardian verification: \(error)")
            clearGuardianChallengePending(for: channel)
            switch channel {
            case "telegram":
                telegramGuardianVerificationInProgress = false
                telegramGuardianError = "Failed to start verification. Try again."
            case "sms":
                smsGuardianVerificationInProgress = false
                smsGuardianError = "Failed to start verification. Try again."
            case "voice":
                voiceGuardianVerificationInProgress = false
                voiceGuardianError = "Failed to start verification. Try again."
            default:
                break
            }
        }
    }

    func cancelGuardianChallenge(channel: String) {
        stopGuardianStatusPolling(for: channel)
        clearGuardianChallengePending(for: channel)
        switch channel {
        case "telegram":
            telegramGuardianVerificationInProgress = false
            telegramGuardianInstruction = nil
        case "sms":
            smsGuardianVerificationInProgress = false
            smsGuardianInstruction = nil
        case "voice":
            voiceGuardianVerificationInProgress = false
            voiceGuardianInstruction = nil
        default:
            break
        }
        // Invalidate the pending challenge token on the backend so it can't be used after cancellation
        do {
            try daemonClient?.sendGuardianVerification(action: "revoke", channel: channel, assistantId: guardianAssistantScope)
        } catch {
            log.error("Failed to revoke \(channel) guardian challenge on cancel: \(error)")
        }
    }

    func revokeChannelGuardian(channel: String) {
        stopGuardianStatusPolling(for: channel)
        // Eagerly clear instruction so the "Verify Guardian" button reappears
        // immediately instead of waiting for the daemon's response (which
        // looks identical to a status poll and won't clear it).
        switch channel {
        case "telegram":
            telegramGuardianInstruction = nil
        case "sms":
            smsGuardianInstruction = nil
        case "voice":
            voiceGuardianInstruction = nil
        default:
            break
        }
        do {
            try daemonClient?.sendGuardianVerification(action: "revoke", channel: channel, assistantId: guardianAssistantScope)
        } catch {
            log.error("Failed to revoke \(channel) guardian: \(error)")
        }
    }

    // MARK: - Outbound Guardian Actions

    func startOutboundGuardianVerification(channel: String, destination: String) {
        clearOutboundState(for: channel)
        stopGuardianStatusPolling(for: channel)
        switch channel {
        case "telegram":
            telegramGuardianVerificationInProgress = true
            telegramGuardianError = nil
            telegramGuardianAlreadyBound = false
        case "sms":
            smsGuardianVerificationInProgress = true
            smsGuardianError = nil
            smsGuardianAlreadyBound = false
        case "voice":
            voiceGuardianVerificationInProgress = true
            voiceGuardianError = nil
            voiceGuardianAlreadyBound = false
        default:
            return
        }
        do {
            guard let daemonClient else {
                switch channel {
                case "telegram":
                    telegramGuardianVerificationInProgress = false
                    telegramGuardianError = "Daemon is not connected. Reconnect and try again."
                case "sms":
                    smsGuardianVerificationInProgress = false
                    smsGuardianError = "Daemon is not connected. Reconnect and try again."
                case "voice":
                    voiceGuardianVerificationInProgress = false
                    voiceGuardianError = "Daemon is not connected. Reconnect and try again."
                default:
                    break
                }
                return
            }
            try daemonClient.sendGuardianVerification(
                action: "start_outbound",
                channel: channel,
                assistantId: guardianAssistantScope,
                destination: destination
            )
        } catch {
            log.error("Failed to start outbound \(channel) guardian verification: \(error)")
            switch channel {
            case "telegram":
                telegramGuardianVerificationInProgress = false
                telegramGuardianError = "Failed to start verification. Try again."
            case "sms":
                smsGuardianVerificationInProgress = false
                smsGuardianError = "Failed to start verification. Try again."
            case "voice":
                voiceGuardianVerificationInProgress = false
                voiceGuardianError = "Failed to start verification. Try again."
            default:
                break
            }
        }
    }

    func resendOutboundGuardian(channel: String) {
        do {
            try daemonClient?.sendGuardianVerification(
                action: "resend_outbound",
                channel: channel,
                assistantId: guardianAssistantScope
            )
        } catch {
            log.error("Failed to resend outbound \(channel) guardian verification: \(error)")
        }
    }

    func cancelOutboundGuardian(channel: String) {
        stopGuardianStatusPolling(for: channel)
        clearOutboundState(for: channel)
        switch channel {
        case "telegram":
            telegramGuardianVerificationInProgress = false
        case "sms":
            smsGuardianVerificationInProgress = false
        case "voice":
            voiceGuardianVerificationInProgress = false
        default:
            break
        }
        do {
            try daemonClient?.sendGuardianVerification(
                action: "cancel_outbound",
                channel: channel,
                assistantId: guardianAssistantScope
            )
        } catch {
            log.error("Failed to cancel outbound \(channel) guardian verification: \(error)")
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
        case "sms":
            smsOutboundSessionId = nil
            smsOutboundExpiresAt = nil
            smsOutboundNextResendAt = nil
            smsOutboundSendCount = 0
            smsOutboundCode = nil
        case "voice":
            voiceOutboundSessionId = nil
            voiceOutboundExpiresAt = nil
            voiceOutboundNextResendAt = nil
            voiceOutboundSendCount = 0
            voiceOutboundCode = nil
        default:
            break
        }
    }

    private func applyOutboundResponseState(channel: String, response: GuardianVerificationResponseMessage) {
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
        case "sms":
            if sessionId != smsOutboundSessionId {
                smsOutboundNextResendAt = nil
                smsOutboundSendCount = 0
                smsOutboundCode = nil
            }
            smsOutboundSessionId = sessionId
            if let expiresAt { smsOutboundExpiresAt = expiresAt }
            if let nextResendAt { smsOutboundNextResendAt = nextResendAt }
            if let sendCount { smsOutboundSendCount = sendCount }
            if let secret { smsOutboundCode = secret }
        case "voice":
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
        default:
            break
        }
    }

    private func resolveGuardianResponseChannel(_ channel: String?) -> String? {
        if let channel {
            return channel
        }
        if let pendingGuardianChallengeChannel {
            return pendingGuardianChallengeChannel
        }
        // Disambiguate when exactly one channel has verification in progress
        let inProgressChannels = [
            ("telegram", telegramGuardianVerificationInProgress),
            ("sms", smsGuardianVerificationInProgress),
            ("voice", voiceGuardianVerificationInProgress),
        ].filter(\.1)
        if inProgressChannels.count == 1 {
            return inProgressChannels.first?.0
        }
        return nil
    }

    private func clearGuardianChallengePending(for channel: String) {
        if pendingGuardianChallengeChannel == channel {
            pendingGuardianChallengeChannel = nil
            guardianChallengeTimeoutWorkItem?.cancel()
            guardianChallengeTimeoutWorkItem = nil
        }
        // Clear stale instruction so the "Verify Guardian" button reappears
        // when a challenge is no longer active (timeout, revoke, or error).
        switch channel {
        case "telegram":
            telegramGuardianInstruction = nil
        case "sms":
            smsGuardianInstruction = nil
        case "voice":
            voiceGuardianInstruction = nil
        default:
            break
        }
    }

    private func armGuardianChallengeTimeout(for channel: String) {
        guardianChallengeTimeoutWorkItem?.cancel()
        let workItem = DispatchWorkItem { [weak self] in
            guard let self else { return }
            guard self.pendingGuardianChallengeChannel == channel else { return }
            self.pendingGuardianChallengeChannel = nil
            switch channel {
            case "telegram":
                self.telegramGuardianVerificationInProgress = false
                self.telegramGuardianInstruction = nil
                if self.telegramGuardianError == nil {
                    self.telegramGuardianError = "Timed out waiting for verification instructions. Try again."
                }
            case "sms":
                self.smsGuardianVerificationInProgress = false
                self.smsGuardianInstruction = nil
                if self.smsGuardianError == nil {
                    self.smsGuardianError = "Timed out waiting for verification instructions. Try again."
                }
            case "voice":
                self.voiceGuardianVerificationInProgress = false
                self.voiceGuardianInstruction = nil
                if self.voiceGuardianError == nil {
                    self.voiceGuardianError = "Timed out waiting for verification instructions. Try again."
                }
            default:
                break
            }
        }
        guardianChallengeTimeoutWorkItem = workItem
        DispatchQueue.main.asyncAfter(deadline: .now() + guardianChallengeTimeoutDuration, execute: workItem)
    }

    private func startGuardianStatusPolling(for channel: String) {
        guard channel == "telegram" || channel == "sms" || channel == "voice" else { return }
        stopGuardianStatusPolling(for: channel)
        guardianStatusPollingDeadlines[channel] = Date().addingTimeInterval(guardianStatusPollWindow)
        scheduleGuardianStatusPoll(for: channel, delay: guardianStatusPollInterval)
    }

    private func stopGuardianStatusPolling(for channel: String) {
        guardianStatusPollingWorkItems[channel]?.cancel()
        guardianStatusPollingWorkItems[channel] = nil
        guardianStatusPollingDeadlines[channel] = nil
    }

    private func scheduleGuardianStatusPoll(for channel: String, delay: TimeInterval) {
        let workItem = DispatchWorkItem { [weak self] in
            guard let self else { return }
            guard let deadline = self.guardianStatusPollingDeadlines[channel] else { return }
            if Date() >= deadline {
                self.stopGuardianStatusPolling(for: channel)
                return
            }
            self.refreshChannelGuardianStatus(channel: channel)
            self.scheduleGuardianStatusPoll(for: channel, delay: self.guardianStatusPollInterval)
        }
        guardianStatusPollingWorkItems[channel]?.cancel()
        guardianStatusPollingWorkItems[channel] = workItem
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
        vellumPlatformReachable = nil
        vellumPlatformError = nil
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
            // IPC send failed — roll back the optimistic update
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

    // MARK: - Platform Health Check

    func checkVellumPlatform() async {
        isCheckingVellumPlatform = true
        defer {
            isCheckingVellumPlatform = false
            platformLastChecked = Date()
        }

        let baseUrl = platformBaseUrl.isEmpty ? AuthService.shared.baseURL : platformBaseUrl
        let normalized = baseUrl.hasSuffix("/") ? String(baseUrl.dropLast()) : baseUrl
        guard let url = URL(string: "\(normalized)/healthz") else {
            vellumPlatformReachable = false
            vellumPlatformError = "Invalid URL"
            return
        }
        var request = URLRequest(url: url)
        request.timeoutInterval = 5
        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            if let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) {
                vellumPlatformReachable = true
                vellumPlatformError = nil
            } else {
                let code = (response as? HTTPURLResponse)?.statusCode ?? 0
                vellumPlatformReachable = false
                vellumPlatformError = "HTTP \(code)"
            }
        } catch {
            vellumPlatformReachable = false
            vellumPlatformError = "Could not connect"
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
            // IPC failed — restore optimistically removed devices
            approvedDevices.append(contentsOf: removed)
        }
    }

    func clearAllApprovedDevices() {
        guard let daemonClient else { return }
        do {
            try daemonClient.sendApprovedDevicesClear()
            approvedDevices = []
        } catch {
            // IPC failed — don't clear local state
        }
    }

    // MARK: - iOS Pairing

    /// Gateway URL for iOS pairing.
    var resolvedIosGatewayUrl: String {
        ingressPublicBaseUrl
    }

    /// Bearer token for iOS pairing.
    var resolvedIosBearerToken: String {
        readHttpToken() ?? ""
    }

    /// LAN pairing URL for the gateway (port 7830), or nil if no LAN IP available.
    var lanPairingUrl: String? {
        guard let ip = LANIPHelper.currentLANAddress() else { return nil }
        return "http://\(ip):7830"
    }

    // MARK: - Dev Mode Actions

    func toggleDevMode() {
        isDevMode.toggle()
    }

    // MARK: - Parental Control Profile Actions

    /// Switch the active profile.
    ///
    /// When switching to "parental" and a PIN is set the caller must supply the
    /// current PIN. On success `activeProfile` is updated; on failure
    /// `profileSwitchError` is set so the UI can display the reason.
    func switchProfile(to targetProfile: String, pin: String?) async {
        profileSwitchError = nil
        guard let daemonClient else { return }
        let stream = daemonClient.subscribe()
        do {
            try daemonClient.sendParentalControlProfileSwitch(targetProfile: targetProfile, pin: pin)
        } catch {
            profileSwitchError = error.localizedDescription
            return
        }

        let response: ParentalControlProfileSwitchResponseMessage? = await withTaskGroup(
            of: ParentalControlProfileSwitchResponseMessage?.self
        ) { group in
            group.addTask {
                for await message in stream {
                    if case .parentalControlProfileSwitchResponse(let msg) = message { return msg }
                }
                return nil
            }
            group.addTask {
                try? await Task.sleep(nanoseconds: 8_000_000_000)
                return nil
            }
            let first = await group.next() ?? nil
            group.cancelAll()
            return first
        }

        if let r = response {
            if r.success {
                activeProfile = r.activeProfile
            } else {
                profileSwitchError = r.error
            }
        } else {
            profileSwitchError = "No response from daemon."
        }
    }

    // MARK: - Parental Activity Log Actions

    /// Request the full activity log from the daemon and populate `activityLog`.
    func loadActivityLog() {
        guard let daemonClient else { return }
        let stream = daemonClient.subscribe()
        Task {
            do {
                try daemonClient.sendParentalActivityLogList()
            } catch {
                log.error("Failed to send parental_activity_log_list: \(error)")
                return
            }

            let response: ParentalActivityLogListResponseMessage? = await withTaskGroup(
                of: ParentalActivityLogListResponseMessage?.self
            ) { group in
                group.addTask {
                    for await message in stream {
                        if case .parentalActivityLogListResponse(let msg) = message { return msg }
                    }
                    return nil
                }
                group.addTask {
                    try? await Task.sleep(nanoseconds: 8_000_000_000)
                    return nil
                }
                let first = await group.next() ?? nil
                group.cancelAll()
                return first
            }

            guard let r = response else { return }
            let decoded = r.entries.map { entry in
                ActivityLogEntry(
                    id: entry.id,
                    timestamp: entry.timestamp,
                    actionType: entry.actionType,
                    description: entry.description
                )
            }
            await MainActor.run {
                self.activityLog = decoded
            }
        }
    }

    /// Clear all activity log entries on both daemon and local state.
    /// `pin` must be provided when parental controls are enabled and a PIN is set.
    func clearActivityLogEntries(pin: String? = nil) {
        guard let daemonClient else { return }
        Task {
            do {
                try daemonClient.sendParentalActivityLogClear(pin: pin)
            } catch {
                log.error("Failed to send parental_activity_log_clear: \(error)")
            }
            // Optimistically clear local state; the daemon confirms via response
            // but we don't need to block on it for the UX.
            await MainActor.run {
                self.activityLog = []
            }
        }
    }

    // MARK: - Integration Allowlist Actions

    /// Load the current integration allowlist from the daemon. PIN is required when parental controls are enabled.
    func loadAllowedIntegrations(pin: String) {
        guard let daemonClient else { return }
        let stream = daemonClient.subscribe()
        Task {
            do {
                try daemonClient.sendParentalIntegrationAllowlistGet(pin: pin)
            } catch {
                log.error("Failed to send parental_integration_allowlist_get: \(error)")
                return
            }

            let response: ParentalIntegrationAllowlistGetResponseMessage? = await withTaskGroup(
                of: ParentalIntegrationAllowlistGetResponseMessage?.self
            ) { group in
                group.addTask {
                    for await message in stream {
                        if case .parentalIntegrationAllowlistGetResponse(let msg) = message { return msg }
                    }
                    return nil
                }
                group.addTask {
                    try? await Task.sleep(nanoseconds: 8_000_000_000)
                    return nil
                }
                let first = await group.next() ?? nil
                group.cancelAll()
                return first
            }

            guard let r = response, r.success else { return }
            await MainActor.run {
                self.allowedIntegrations = r.allowedIntegrations
            }
        }
    }

    /// Update the integration allowlist on the daemon and sync local state.
    /// `pin` is required when parental controls are enabled and a PIN is set.
    func updateAllowedIntegrations(pin: String, integrations: [String]) {
        guard let daemonClient else { return }
        let stream = daemonClient.subscribe()
        Task {
            do {
                try daemonClient.sendParentalIntegrationAllowlistUpdate(pin: pin, allowedIntegrations: integrations)
            } catch {
                log.error("Failed to send parental_integration_allowlist_update: \(error)")
                return
            }

            let response: ParentalIntegrationAllowlistUpdateResponseMessage? = await withTaskGroup(
                of: ParentalIntegrationAllowlistUpdateResponseMessage?.self
            ) { group in
                group.addTask {
                    for await message in stream {
                        if case .parentalIntegrationAllowlistUpdateResponse(let msg) = message { return msg }
                    }
                    return nil
                }
                group.addTask {
                    try? await Task.sleep(nanoseconds: 8_000_000_000)
                    return nil
                }
                let first = await group.next() ?? nil
                group.cancelAll()
                return first
            }

            guard let r = response, r.success else { return }
            await MainActor.run {
                self.allowedIntegrations = integrations
            }
        }
    }

    // MARK: - Parental App Time Limit Actions

    /// Fetch per-app time limits and today's usage from the daemon and update published state.
    func loadAppTimeLimits(pin: String) {
        guard let daemonClient else { return }
        let stream = daemonClient.subscribe()
        Task {
            do {
                try daemonClient.sendParentalAppTimeLimitGet(pin: pin)
            } catch {
                log.error("Failed to send parental_app_time_limit_get: \(error)")
                return
            }

            let response: ParentalAppTimeLimitGetResponseMessage? = await withTaskGroup(
                of: ParentalAppTimeLimitGetResponseMessage?.self
            ) { group in
                group.addTask {
                    for await message in stream {
                        if case .parentalAppTimeLimitGetResponse(let msg) = message { return msg }
                    }
                    return nil
                }
                group.addTask {
                    try? await Task.sleep(nanoseconds: 8_000_000_000)
                    return nil
                }
                let first = await group.next() ?? nil
                group.cancelAll()
                return first
            }

            await MainActor.run {
                if let r = response, r.success {
                    self.appTimeLimits = r.limits
                    self.appUsageToday = r.usage
                }
            }
        }
    }

    /// Set the daily time limit for a single app and refresh local state.
    func setAppTimeLimit(appName: String, minutes: Int, pin: String) {
        guard let daemonClient else { return }
        let stream = daemonClient.subscribe()
        Task {
            do {
                try daemonClient.sendParentalAppTimeLimitSet(pin: pin, appName: appName, limitMinutes: minutes)
            } catch {
                log.error("Failed to send parental_app_time_limit_set: \(error)")
                return
            }

            let response: ParentalAppTimeLimitSetResponseMessage? = await withTaskGroup(
                of: ParentalAppTimeLimitSetResponseMessage?.self
            ) { group in
                group.addTask {
                    for await message in stream {
                        if case .parentalAppTimeLimitSetResponse(let msg) = message { return msg }
                    }
                    return nil
                }
                group.addTask {
                    try? await Task.sleep(nanoseconds: 8_000_000_000)
                    return nil
                }
                let first = await group.next() ?? nil
                group.cancelAll()
                return first
            }

            await MainActor.run {
                if let r = response, r.success {
                    self.appTimeLimits[appName] = minutes
                }
            }
        }
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

}
