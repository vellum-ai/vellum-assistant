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
    static let refreshAppsCache = Notification.Name("MainWindow.refreshAppsCache")
    static let assistantFeatureFlagDidChange = Notification.Name("assistantFeatureFlagDidChange")
    static let localBootstrapCompleted = Notification.Name("localBootstrapCompleted")
}

private let apiKeyLog = Logger(subsystem: Bundle.appBundleIdentifier, category: "APIKeyManager")

/// Manages API keys using file-based CredentialStorage. The daemon owns the
/// canonical encrypted store; the app syncs
/// keys to the daemon via HTTP on save/clear/reconnect.
enum APIKeyManager {
    private static let udPrefix = "vellum_provider_"

    private static let storage: CredentialStorage = FileCredentialStorage()

    /// Core LLM/service provider identifiers whose API keys are always
    /// synced to the daemon as `type: "api_key"`.
    private static let coreSyncableProviders = [
        "anthropic",
        "brave",
        "fireworks",
        "gemini",
        "openai",
        "openrouter",
        "perplexity",
    ]

    /// Provider identifiers whose API keys are synced to the daemon as
    /// `type: "api_key"`. Combines the core provider list with any TTS
    /// and STT providers from the shared registries that use `api_key`
    /// setup mode, so new registry entries are automatically included
    /// without code changes here.
    static let allSyncableProviders: [String] = {
        var ids = coreSyncableProviders
        let ttsApiKeyIds = loadTTSProviderRegistry().providers
            .filter { $0.setupMode == .apiKey }
            .map(\.id)
        for id in ttsApiKeyIds where !ids.contains(id) {
            ids.append(id)
        }
        let sttApiKeyNames = loadSTTProviderRegistry().providers
            .filter { $0.setupMode == .apiKey }
            .map(\.apiKeyProviderName)
        for name in sttApiKeyNames where !ids.contains(name) {
            ids.append(name)
        }
        return ids
    }()

    // MARK: - Migration from UserDefaults

    /// One-time migration: copies API keys from UserDefaults to credential
    /// storage for existing users, then removes them from UserDefaults.
    /// Safe to call multiple times — skips providers that already have a
    /// value in credential storage.
    static func migrateFromUserDefaults() {
        for provider in allSyncableProviders {
            migrateProviderFromUserDefaults(provider)
        }
        migrateElevenLabsToCredential()
    }

    /// Migrate ElevenLabs key from api_key storage to credential storage.
    /// Handles keys stored in UserDefaults or FileCredentialStorage under the
    /// old `vellum_provider_elevenlabs` account.
    private static func migrateElevenLabsToCredential() {
        let oldAccount = udPrefix + "elevenlabs"
        let newAccount = credentialPrefix + "elevenlabs:api_key"

        // First migrate from UserDefaults if present
        if let udValue = UserDefaults.standard.string(forKey: oldAccount), !udValue.isEmpty {
            if storage.get(account: newAccount) == nil {
                guard storage.set(account: newAccount, value: udValue) else { return }
            }
            UserDefaults.standard.removeObject(forKey: oldAccount)
            _ = storage.delete(account: oldAccount)
            return
        }

        // Then migrate from old FileCredentialStorage format
        if let oldValue = storage.get(account: oldAccount),
           storage.get(account: newAccount) == nil {
            guard storage.set(account: newAccount, value: oldValue) else { return }
        }
        _ = storage.delete(account: oldAccount)
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

    // MARK: - Generic provider access (sync — FileCredentialStorage)

    static func getKey(for provider: String) -> String? {
        storage.get(account: udPrefix + provider)
    }

    // MARK: - Generic provider access (async — gateway API)

    /// Result of an async key-write operation via the gateway API.
    struct SetKeyResult {
        let success: Bool
        let error: String?
        let isTransient: Bool
    }

    /// Response from a non-revealing `secrets/read` call.
    private struct SecretReadResult {
        let found: Bool
        let masked: String?
    }

    /// Calls `secrets/read` (without `reveal`) and returns existence + masked value.
    private static func readSecret(for provider: String) async -> SecretReadResult {
        do {
            let body: [String: Any] = ["type": "api_key", "name": provider]
            let response = try await GatewayHTTPClient.post(
                path: "assistants/{assistantId}/secrets/read", json: body, timeout: 5
            )
            guard response.isSuccess,
                  let json = try? JSONSerialization.jsonObject(with: response.data) as? [String: Any],
                  let found = json["found"] as? Bool else {
                return SecretReadResult(found: false, masked: nil)
            }
            let masked = json["masked"] as? String
            return SecretReadResult(found: found, masked: masked)
        } catch {
            apiKeyLog.error("readSecret(\(provider, privacy: .public)) failed: \(error.localizedDescription, privacy: .public)")
            return SecretReadResult(found: false, masked: nil)
        }
    }

    /// Check whether the assistant's secret store has a key for `provider`.
    static func hasKey(for provider: String) async -> Bool {
        await readSecret(for: provider).found
    }

    /// Read a masked API key from the assistant's secret store.
    /// Returns a display-safe string like `"sk-ant-api...Ab1x"`, or `nil`
    /// when no key is stored for the given provider.
    static func maskedKey(for provider: String) async -> String? {
        let result = await readSecret(for: provider)
        guard result.found, let masked = result.masked, !masked.isEmpty else { return nil }
        return masked
    }

    static func setKey(_ key: String, for provider: String) {
        _ = storage.set(account: udPrefix + provider, value: key)
        notifyKeyDidChange()
    }

    /// Write a key to the daemon's secret store via the gateway API.
    /// Performs server-side validation and returns the result.
    @discardableResult
    static func setKey(_ key: String, for provider: String) async -> SetKeyResult {
        do {
            let body: [String: Any] = ["type": "api_key", "name": provider, "value": key]
            let response = try await GatewayHTTPClient.post(
                path: "assistants/{assistantId}/secrets", json: body, timeout: 5
            )
            if response.isSuccess {
                return SetKeyResult(success: true, error: nil, isTransient: false)
            }
            let isServerError = response.statusCode >= 500
            if let parsed = try? JSONSerialization.jsonObject(with: response.data) as? [String: Any],
               let errorMsg = parsed["error"] as? String {
                return SetKeyResult(success: false, error: errorMsg, isTransient: isServerError)
            }
            return SetKeyResult(success: false, error: "Failed to save API key (HTTP \(response.statusCode)).", isTransient: isServerError)
        } catch {
            apiKeyLog.error("setKey(\(provider, privacy: .public)) async failed: \(error.localizedDescription, privacy: .public)")
            return SetKeyResult(success: false, error: "Could not reach assistant. Please check that it is running.", isTransient: true)
        }
    }

    static func deleteKey(for provider: String) {
        _ = storage.delete(account: udPrefix + provider)
        notifyKeyDidChange()
    }

    /// Delete a key from the daemon's secret store via the gateway API.
    /// Returns `true` when the server confirms deletion.
    @discardableResult
    static func deleteKey(for provider: String) async -> Bool {
        do {
            let body: [String: Any] = ["type": "api_key", "name": provider]
            let response = try await GatewayHTTPClient.delete(
                path: "assistants/{assistantId}/secrets", json: body, timeout: 5
            )
            return response.isSuccess
        } catch {
            apiKeyLog.error("deleteKey(\(provider, privacy: .public)) async failed: \(error.localizedDescription, privacy: .public)")
            return false
        }
    }

    // MARK: - Credential access (service:field secrets)

    private static let credentialPrefix = "vellum_credential_"

    /// Sync local read for a credential (FileCredentialStorage).
    static func getCredential(service: String, field: String) -> String? {
        storage.get(account: credentialPrefix + service + ":" + field)
    }

    /// Sync local write for a credential (FileCredentialStorage).
    static func setCredential(_ value: String, service: String, field: String) {
        _ = storage.set(account: credentialPrefix + service + ":" + field, value: value)
        notifyKeyDidChange()
    }

    /// Sync local delete for a credential (FileCredentialStorage).
    static func deleteCredential(service: String, field: String) {
        _ = storage.delete(account: credentialPrefix + service + ":" + field)
        notifyKeyDidChange()
    }

    /// Calls `secrets/read` with credential type and returns existence + masked value.
    private static func readCredentialSecret(service: String, field: String) async -> SecretReadResult {
        do {
            let body: [String: Any] = ["type": "credential", "name": "\(service):\(field)"]
            let response = try await GatewayHTTPClient.post(
                path: "assistants/{assistantId}/secrets/read", json: body, timeout: 5
            )
            guard response.isSuccess,
                  let json = try? JSONSerialization.jsonObject(with: response.data) as? [String: Any],
                  let found = json["found"] as? Bool else {
                return SecretReadResult(found: false, masked: nil)
            }
            let masked = json["masked"] as? String
            return SecretReadResult(found: found, masked: masked)
        } catch {
            apiKeyLog.error("readCredentialSecret(\(service, privacy: .public):\(field, privacy: .public)) failed: \(error.localizedDescription, privacy: .public)")
            return SecretReadResult(found: false, masked: nil)
        }
    }

    /// Check whether the assistant's secret store has a credential.
    static func hasCredential(service: String, field: String) async -> Bool {
        await readCredentialSecret(service: service, field: field).found
    }

    /// Read a masked credential from the assistant's secret store.
    static func maskedCredential(service: String, field: String) async -> String? {
        let result = await readCredentialSecret(service: service, field: field)
        guard result.found, let masked = result.masked, !masked.isEmpty else { return nil }
        return masked
    }

    /// Write a credential to the daemon's secret store via the gateway API.
    static func setCredential(_ value: String, service: String, field: String) async -> SetKeyResult {
        do {
            let body: [String: Any] = ["type": "credential", "name": "\(service):\(field)", "value": value]
            let response = try await GatewayHTTPClient.post(
                path: "assistants/{assistantId}/secrets", json: body, timeout: 5
            )
            if response.isSuccess {
                return SetKeyResult(success: true, error: nil, isTransient: false)
            }
            let isServerError = response.statusCode >= 500
            if let parsed = try? JSONSerialization.jsonObject(with: response.data) as? [String: Any],
               let errorMsg = parsed["error"] as? String {
                return SetKeyResult(success: false, error: errorMsg, isTransient: isServerError)
            }
            return SetKeyResult(success: false, error: "Failed to save credential (HTTP \(response.statusCode)).", isTransient: isServerError)
        } catch {
            apiKeyLog.error("setCredential(\(service, privacy: .public):\(field, privacy: .public)) async failed: \(error.localizedDescription, privacy: .public)")
            return SetKeyResult(success: false, error: "Could not reach assistant. Please check that it is running.", isTransient: true)
        }
    }

    /// Delete a credential from the daemon's secret store via the gateway API.
    @discardableResult
    static func deleteCredential(service: String, field: String) async -> Bool {
        do {
            let body: [String: Any] = ["type": "credential", "name": "\(service):\(field)"]
            let response = try await GatewayHTTPClient.delete(
                path: "assistants/{assistantId}/secrets", json: body, timeout: 5
            )
            return response.isSuccess
        } catch {
            apiKeyLog.error("deleteCredential(\(service, privacy: .public):\(field, privacy: .public)) async failed: \(error.localizedDescription, privacy: .public)")
            return false
        }
    }

    private static func notifyKeyDidChange() {
        NotificationCenter.default.post(name: .apiKeyManagerDidChange, object: nil)
    }
}
