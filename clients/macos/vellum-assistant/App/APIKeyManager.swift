import Foundation
import VellumAssistantShared
import os

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

/// Manages API keys via the daemon's gateway secrets API.
///
/// The daemon owns the canonical encrypted store. All reads, writes, and
/// deletes go through its HTTP secrets endpoints (`POST /v1/secrets`,
/// `POST /v1/secrets/read`, `DELETE /v1/secrets`) with `type: "api_key"`.
enum APIKeyManager {
    private static let udPrefix = "vellum_provider_"

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

    /// Returns true if any known provider has a key configured in the daemon.
    static func hasAnyKey() async -> Bool {
        for provider in allSyncableProviders {
            if await getKey(for: provider) != nil { return true }
        }
        if await getKey(for: "elevenlabs") != nil { return true }
        return false
    }

    // MARK: - Migration from UserDefaults

    /// One-time migration: copies API keys from UserDefaults to the daemon's
    /// secret store for existing users, then removes them from UserDefaults.
    /// Safe to call multiple times — skips providers whose UserDefaults key
    /// has already been cleared.
    static func migrateFromUserDefaults() async {
        for provider in allSyncableProviders {
            await migrateProviderFromUserDefaults(provider)
        }
        // ElevenLabs is stored locally only (not synced to daemon)
        await migrateProviderFromUserDefaults("elevenlabs")
    }

    /// Migrate a single provider's key from UserDefaults to the daemon.
    private static func migrateProviderFromUserDefaults(_ provider: String) async {
        let udKey = udPrefix + provider
        guard let udValue = UserDefaults.standard.string(forKey: udKey),
              !udValue.isEmpty else {
            // No value in UserDefaults — nothing to migrate. Clean up the key
            // in case it's an empty string.
            UserDefaults.standard.removeObject(forKey: udKey)
            return
        }
        // Write to daemon. Only remove from UserDefaults if the write succeeds.
        let stored = await setKey(udValue, for: provider)
        if stored {
            UserDefaults.standard.removeObject(forKey: udKey)
        }
    }

    // MARK: - Generic provider access

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

    private static func notifyKeyDidChange() {
        NotificationCenter.default.post(name: .apiKeyManagerDidChange, object: nil)
    }
}
