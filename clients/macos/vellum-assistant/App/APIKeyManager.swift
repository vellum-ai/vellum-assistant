import Foundation
import VellumAssistantShared

extension Notification.Name {
    static let apiKeyManagerDidChange = Notification.Name("APIKeyManager.didChange")
    static let openDynamicWorkspace = Notification.Name("MainWindow.openDynamicWorkspace")
    static let updateDynamicWorkspace = Notification.Name("MainWindow.updateDynamicWorkspace")
    static let dismissDynamicWorkspace = Notification.Name("MainWindow.dismissDynamicWorkspace")
    static let openDocumentEditor = Notification.Name("MainWindow.openDocumentEditor")
    static let navigateToSettingsTab = Notification.Name("MainWindow.navigateToSettingsTab")
    static let activationKeyChanged = Notification.Name("activationKeyChanged")
    static let identityChanged = Notification.Name("identityChanged")
    static let shareAppCloud = Notification.Name("MainWindow.shareAppCloud")
    static let appPreviewImageCaptured = Notification.Name("MainWindow.appPreviewImageCaptured")
    static let requestAppPreview = Notification.Name("MainWindow.requestAppPreview")
    static let assistantFeatureFlagDidChange = Notification.Name("assistantFeatureFlagDidChange")
}

/// Manages API keys using UserDefaults. The daemon owns the canonical encrypted
/// store; the app syncs keys to the daemon via HTTP on save/clear/reconnect.
enum APIKeyManager {
    private static let udPrefix = "vellum_provider_"

    // MARK: - Anthropic (convenience wrappers for backward compatibility)

    static func getKey() -> String? { getKey(for: "anthropic") }
    static func setKey(_ key: String) { setKey(key, for: "anthropic") }
    static func deleteKey() { deleteKey(for: "anthropic") }

    /// Returns true if any known provider has a key configured.
    static func hasAnyKey() -> Bool {
        for provider in ["anthropic", "openai", "gemini", "fireworks"] {
            if getKey(for: provider) != nil { return true }
        }
        return false
    }

    // MARK: - Generic provider access

    static func getKey(for provider: String) -> String? {
        UserDefaults.standard.string(forKey: udPrefix + provider)
    }

    static func setKey(_ key: String, for provider: String) {
        UserDefaults.standard.set(key, forKey: udPrefix + provider)
        notifyKeyDidChange()
    }

    static func deleteKey(for provider: String) {
        UserDefaults.standard.removeObject(forKey: udPrefix + provider)
        notifyKeyDidChange()
    }

    /// Push an API key to the daemon's encrypted store via its HTTP endpoint.
    /// Waits up to 15s for the actor token if it's not yet available (e.g.
    /// during initial onboarding before JWT bootstrap completes). Failures
    /// are silently ignored — the reconnect sync will retry.
    static func syncKeyToDaemon(provider: String, value: String) {
        Task.detached {
            guard let token = await ActorTokenManager.waitForToken(timeout: 15),
                  !token.isEmpty else { return }
            let port = ProcessInfo.processInfo.environment["RUNTIME_HTTP_PORT"]
                .flatMap(Int.init) ?? 7821
            guard let url = URL(string: "http://localhost:\(port)/v1/secrets") else { return }
            var request = URLRequest(url: url)
            request.httpMethod = "POST"
            request.timeoutInterval = 5
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            let body: [String: String] = ["type": "api_key", "name": provider, "value": value]
            request.httpBody = try? JSONSerialization.data(withJSONObject: body)
            _ = try? await URLSession.shared.data(for: request)
        }
    }

    private static func notifyKeyDidChange() {
        NotificationCenter.default.post(name: .apiKeyManagerDidChange, object: nil)
    }
}
