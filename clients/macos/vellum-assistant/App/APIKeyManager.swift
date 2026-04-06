import Foundation
import os
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

private let apiKeyLog = Logger(subsystem: Bundle.appBundleIdentifier, category: "APIKeyManager")

/// Manages API keys via both local file-based storage and the daemon's
/// gateway secrets API.
///
/// **Sync methods** (no `async`) read/write the local `FileCredentialStorage`.
/// These are the legacy path and will be removed once all callers are migrated.
///
/// **Async methods** read/write via the daemon's HTTP secrets endpoints
/// (`POST /v1/secrets`, `POST /v1/secrets/read`, `DELETE /v1/secrets`).
/// Callers should prefer the async overloads. Swift picks the correct
/// overload based on whether the call site uses `await`.
enum APIKeyManager {
    private static let udPrefix = "vellum_provider_"

    private static let storage: CredentialStorage = FileCredentialStorage()

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

    // MARK: - Sync (legacy — FileCredentialStorage)

    /// Returns true if any known provider has a key configured (sync/local).
    static func hasAnyKey() -> Bool {
        for provider in allSyncableProviders {
            if getKey(for: provider) != nil { return true }
        }
        if getKey(for: "elevenlabs") != nil { return true }
        return false
    }

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

    // MARK: - Async (gateway API)

    /// Returns true if any known provider has a key in the daemon (async).
    static func hasAnyKey() async -> Bool {
        for provider in allSyncableProviders {
            if await getKey(for: provider) != nil { return true }
        }
        if await getKey(for: "elevenlabs") != nil { return true }
        return false
    }

    /// Read an API key from the daemon's secret store.
    static func getKey(for provider: String) async -> String? {
        do {
            let body: [String: Any] = ["type": "api_key", "name": provider, "reveal": true]
            let response = try await GatewayHTTPClient.post(
                path: "assistants/{assistantId}/secrets/read", json: body, timeout: 5
            )
            guard response.isSuccess,
                  let json = try? JSONSerialization.jsonObject(with: response.data) as? [String: Any],
                  let found = json["found"] as? Bool, found,
                  let value = json["value"] as? String, !value.isEmpty else {
                return nil
            }
            return value
        } catch {
            apiKeyLog.error("getKey(\(provider, privacy: .public)) failed: \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    /// Write an API key to the daemon's secret store.
    @discardableResult
    static func setKey(_ key: String, for provider: String) async -> Bool {
        do {
            let body: [String: Any] = ["type": "api_key", "name": provider, "value": key]
            let response = try await GatewayHTTPClient.post(
                path: "assistants/{assistantId}/secrets", json: body, timeout: 5
            )
            if response.isSuccess {
                notifyKeyDidChange()
                return true
            }
            apiKeyLog.warning("setKey(\(provider, privacy: .public)) returned status \(response.statusCode)")
            return false
        } catch {
            apiKeyLog.error("setKey(\(provider, privacy: .public)) failed: \(error.localizedDescription, privacy: .public)")
            return false
        }
    }

    /// Delete an API key from the daemon's secret store.
    @discardableResult
    static func deleteKey(for provider: String) async -> Bool {
        do {
            let body: [String: Any] = ["type": "api_key", "name": provider]
            let response = try await GatewayHTTPClient.delete(
                path: "assistants/{assistantId}/secrets", json: body, timeout: 5
            )
            if response.isSuccess || response.statusCode == 404 {
                notifyKeyDidChange()
                return true
            }
            apiKeyLog.warning("deleteKey(\(provider, privacy: .public)) returned status \(response.statusCode)")
            return false
        } catch {
            apiKeyLog.error("deleteKey(\(provider, privacy: .public)) failed: \(error.localizedDescription, privacy: .public)")
            return false
        }
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

    // MARK: - Daemon sync (legacy fire-and-forget)

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
