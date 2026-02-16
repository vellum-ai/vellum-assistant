import Combine
import Foundation
import VellumAssistantShared

/// Single source of truth for settings state shared between `SettingsView`
/// (standalone window) and `SettingsPanel` (main window side panel).
@MainActor
public final class SettingsStore: ObservableObject {
    // MARK: - API Key State

    @Published var hasKey: Bool
    @Published var hasBraveKey: Bool
    @Published var hasVercelKey: Bool = false

    // MARK: - Settings Values

    @Published var maxSteps: Double {
        didSet { UserDefaults.standard.set(maxSteps, forKey: "maxStepsPerSession") }
    }
    @Published var ambientEnabled: Bool {
        didSet {
            UserDefaults.standard.set(ambientEnabled, forKey: "ambientAgentEnabled")
            ambientAgent?.isEnabled = ambientEnabled
        }
    }
    @Published var ambientInterval: Double {
        didSet {
            UserDefaults.standard.set(ambientInterval, forKey: "ambientCaptureInterval")
            ambientAgent?.captureIntervalSeconds = ambientInterval
        }
    }
    @Published var activityNotificationsEnabled: Bool {
        didSet {
            UserDefaults.standard.set(activityNotificationsEnabled, forKey: "activityNotificationsEnabled")
        }
    }

    // MARK: - Trust Rules Coordination

    /// Whether any settings surface currently has a trust rules sheet open.
    /// Sourced from `DaemonClient.isTrustRulesSheetOpen` so each view can
    /// disable its button when the other surface is showing trust rules.
    @Published var isAnyTrustRulesSheetOpen = false

    // MARK: - Private

    private weak var ambientAgent: AmbientAgent?
    private weak var daemonClient: DaemonClient?
    private var cancellables = Set<AnyCancellable>()

    init(ambientAgent: AmbientAgent, daemonClient: DaemonClient? = nil) {
        self.ambientAgent = ambientAgent
        self.daemonClient = daemonClient

        // Seed from UserDefaults / Keychain
        self.hasKey = APIKeyManager.getKey() != nil
        self.hasBraveKey = APIKeyManager.getKey(for: "brave") != nil

        let storedMaxSteps = UserDefaults.standard.double(forKey: "maxStepsPerSession")
        self.maxSteps = storedMaxSteps == 0 ? 50 : storedMaxSteps

        self.ambientEnabled = UserDefaults.standard.bool(forKey: "ambientAgentEnabled")

        let storedInterval = UserDefaults.standard.double(forKey: "ambientCaptureInterval")
        self.ambientInterval = storedInterval == 0 ? 30 : storedInterval

        // Default to enabled for notifications
        self.activityNotificationsEnabled = UserDefaults.standard.object(forKey: "activityNotificationsEnabled") as? Bool ?? true

        // React to Keychain changes from other surfaces
        NotificationCenter.default.publisher(for: .apiKeyManagerDidChange)
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in self?.refreshAPIKeyState() }
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

        // Refresh Vercel key state on init
        refreshVercelKeyState()
    }

    // MARK: - API Key Actions

    func saveAPIKey(_ raw: String) {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        APIKeyManager.setKey(trimmed)
        hasKey = true
    }

    func clearAPIKey() {
        APIKeyManager.deleteKey()
        hasKey = false
    }

    func saveBraveKey(_ raw: String) {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        APIKeyManager.setKey(trimmed, for: "brave")
        hasBraveKey = true
    }

    func clearBraveKey() {
        APIKeyManager.deleteKey(for: "brave")
        hasBraveKey = false
    }

    func refreshAPIKeyState() {
        hasKey = APIKeyManager.getKey() != nil
        hasBraveKey = APIKeyManager.getKey(for: "brave") != nil
    }

    func saveVercelKey(_ raw: String) {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        try? daemonClient?.sendVercelApiConfig(action: "set", apiToken: trimmed)
    }

    func clearVercelKey() {
        try? daemonClient?.sendVercelApiConfig(action: "delete")
    }

    func refreshVercelKeyState() {
        try? daemonClient?.sendVercelApiConfig(action: "get")
    }
}
