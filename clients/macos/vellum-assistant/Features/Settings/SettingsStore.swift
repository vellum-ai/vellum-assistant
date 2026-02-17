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
    @Published var maskedKey: String = ""
    @Published var maskedBraveKey: String = ""

    // MARK: - Settings Values

    @Published var maxSteps: Double {
        didSet { UserDefaults.standard.set(maxSteps, forKey: "maxStepsPerSession") }
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

    private weak var daemonClient: DaemonClient?
    private var cancellables = Set<AnyCancellable>()

    init(daemonClient: DaemonClient? = nil) {
        self.daemonClient = daemonClient

        // Seed from UserDefaults / Keychain
        let anthropicKey = APIKeyManager.getKey()
        self.hasKey = anthropicKey != nil
        self.maskedKey = Self.maskKey(anthropicKey)
        let braveKey = APIKeyManager.getKey(for: "brave")
        self.hasBraveKey = braveKey != nil
        self.maskedBraveKey = Self.maskKey(braveKey)

        let storedMaxSteps = UserDefaults.standard.double(forKey: "maxStepsPerSession")
        self.maxSteps = storedMaxSteps == 0 ? 50 : storedMaxSteps

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

    func refreshAPIKeyState() {
        let anthropicKey = APIKeyManager.getKey()
        hasKey = anthropicKey != nil
        maskedKey = Self.maskKey(anthropicKey)

        let braveKey = APIKeyManager.getKey(for: "brave")
        hasBraveKey = braveKey != nil
        maskedBraveKey = Self.maskKey(braveKey)
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
        try? daemonClient?.sendVercelApiConfig(action: "set", apiToken: trimmed)
    }

    func clearVercelKey() {
        try? daemonClient?.sendVercelApiConfig(action: "delete")
    }

    func refreshVercelKeyState() {
        try? daemonClient?.sendVercelApiConfig(action: "get")
    }
}
