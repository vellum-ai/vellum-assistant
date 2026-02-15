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

    // MARK: - Trust Rules Coordination

    @Published var isTrustRulesSheetOpen = false
    @Published var trustRulesOpenElsewhere = false

    /// Whether the trust rules button should be disabled.
    var isTrustRulesDisabled: Bool { isTrustRulesSheetOpen || trustRulesOpenElsewhere }

    // MARK: - Private

    private weak var ambientAgent: AmbientAgent?
    private var cancellables = Set<AnyCancellable>()

    init(ambientAgent: AmbientAgent, daemonClient: DaemonClient? = nil) {
        self.ambientAgent = ambientAgent

        // Seed from UserDefaults / Keychain
        self.hasKey = APIKeyManager.getKey() != nil
        self.hasBraveKey = APIKeyManager.getKey(for: "brave") != nil

        let storedMaxSteps = UserDefaults.standard.double(forKey: "maxStepsPerSession")
        self.maxSteps = storedMaxSteps == 0 ? 50 : storedMaxSteps

        self.ambientEnabled = UserDefaults.standard.bool(forKey: "ambientAgentEnabled")

        let storedInterval = UserDefaults.standard.double(forKey: "ambientCaptureInterval")
        self.ambientInterval = storedInterval == 0 ? 30 : storedInterval

        // React to Keychain changes from other surfaces
        NotificationCenter.default.publisher(for: .apiKeyManagerDidChange)
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in self?.refreshAPIKeyState() }
            .store(in: &cancellables)

        // Track whether trust rules are open elsewhere
        daemonClient?.$isTrustRulesSheetOpen
            .receive(on: RunLoop.main)
            .sink { [weak self] isOpen in
                guard let self else { return }
                self.trustRulesOpenElsewhere = isOpen && !self.isTrustRulesSheetOpen
            }
            .store(in: &cancellables)
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
}
