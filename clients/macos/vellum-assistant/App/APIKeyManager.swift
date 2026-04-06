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
    static let configChanged = Notification.Name("configChanged")
    static let shareAppCloud = Notification.Name("MainWindow.shareAppCloud")
    static let pinApp = Notification.Name("MainWindow.pinApp")
    static let unpinApp = Notification.Name("MainWindow.unpinApp")
    static let queryAppPinState = Notification.Name("MainWindow.queryAppPinState")
    static let appPreviewImageCaptured = Notification.Name("MainWindow.appPreviewImageCaptured")
    static let requestAppPreview = Notification.Name("MainWindow.requestAppPreview")
    static let assistantFeatureFlagDidChange = Notification.Name("assistantFeatureFlagDidChange")
    static let localBootstrapCompleted = Notification.Name("localBootstrapCompleted")
}

/// Manages API keys using gateway-backed CredentialStorage. The daemon owns the
/// canonical encrypted store; the app syncs
/// keys to the daemon via HTTP on save/clear/reconnect.
enum APIKeyManager {
    private static let udPrefix = "vellum_provider_"

    private static let storage: CredentialStorage = GatewayCredentialStorage()

    /// Provider identifiers whose API keys are synced to the daemon as
    /// `type: "api_key"`.
    static let allSyncableProviders = [
        "anthropic",
        "brave",
        "fireworks",
        "gemini",
        "openai",
        "openrouter",
        "perplexity",
    ]

    /// Returns true if any known provider has a key configured.
    static func hasAnyKey() -> Bool {
        for provider in allSyncableProviders {
            if getKey(for: provider) != nil { return true }
        }
        if getKey(for: "elevenlabs") != nil { return true }
        return false
    }

    // MARK: - Migration from UserDefaults

    /// One-time migration: copies API keys from UserDefaults to credential
    /// storage for existing users, then removes them from UserDefaults.
    /// Safe to call multiple times — skips providers that already have a
    /// value in credential storage.
    static func migrateFromUserDefaults() {
        for provider in allSyncableProviders {
            migrateProviderFromUserDefaults(provider)
        }
        // ElevenLabs is stored locally only (not synced to daemon)
        migrateProviderFromUserDefaults("elevenlabs")
    }

    /// Migrate a single provider's key from UserDefaults to credential storage.
    private static func migrateProviderFromUserDefaults(_ provider: String) {
        let udKey = udPrefix + provider
        if let udValue = UserDefaults.standard.string(forKey: udKey),
           !udValue.isEmpty,
           storage.get(account: udKey) == nil {
            // Only remove from UserDefaults if the credential store
            // write succeeds. A transient credential storage failure should
            // not destroy the user's only copy of the key.
            guard storage.set(account: udKey, value: udValue) else { return }
        }
        // Safe to remove: either the key was successfully migrated,
        // the credential store already had a value, or UserDefaults
        // had no value to preserve.
        UserDefaults.standard.removeObject(forKey: udKey)
    }

    // MARK: - Generic provider access

    static func getKey(for provider: String) -> String? {
        storage.get(account: udPrefix + provider)
    }

    static func setKey(_ key: String, for provider: String) {
        _ = storage.set(account: udPrefix + provider, value: key)
        notifyKeyDidChange()
    }

    static func deleteKey(for provider: String) {
        _ = storage.delete(account: udPrefix + provider)
        notifyKeyDidChange()
    }

    /// Push an API key to the daemon's encrypted store via the gateway.
    /// Waits up to 15s for the actor token if it's not yet available (e.g.
    /// during initial onboarding before JWT bootstrap completes). Failures
    /// are silently ignored — the reconnect sync will retry.
    static func syncKeyToDaemon(provider: String, value: String) {
        Task {
            guard let _ = await ActorTokenManager.waitForToken(timeout: 15) else { return }
            let body: [String: Any] = ["type": "api_key", "name": provider, "value": value]
            _ = try? await GatewayHTTPClient.post(
                path: "assistants/{assistantId}/secrets", json: body, timeout: 5
            )
        }
    }

    private static func notifyKeyDidChange() {
        NotificationCenter.default.post(name: .apiKeyManagerDidChange, object: nil)
    }
}
