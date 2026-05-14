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
    static let schedulesChanged = Notification.Name("schedulesChanged")
    static let shareAppCloud = Notification.Name("MainWindow.shareAppCloud")
    static let pinApp = Notification.Name("MainWindow.pinApp")
    static let unpinApp = Notification.Name("MainWindow.unpinApp")
    static let queryAppPinState = Notification.Name("MainWindow.queryAppPinState")
    static let appPreviewImageCaptured = Notification.Name("MainWindow.appPreviewImageCaptured")
    static let requestAppPreview = Notification.Name("MainWindow.requestAppPreview")
    static let refreshAppsCache = Notification.Name("MainWindow.refreshAppsCache")
    static let assistantFeatureFlagDidChange = Notification.Name("assistantFeatureFlagDidChange")
    static let localBootstrapCompleted = Notification.Name("localBootstrapCompleted")
    static let documentDidSave = Notification.Name("DocumentManager.documentDidSave")
    static let openAppFromArtifact = Notification.Name("MainWindow.openAppFromArtifact")
}

private let apiKeyLog = Logger(subsystem: Bundle.appBundleIdentifier, category: "APIKeyManager")

/// API keys live in the daemon's encrypted secret store; this type wraps
/// the gateway API for reads/writes. Credential-mode secrets (OAuth tokens
/// etc.) still live on disk via FileCredentialStorage and use the
/// credential-prefixed methods below.
enum APIKeyManager {
    private static let storage: CredentialStorage = FileCredentialStorage()

    // MARK: - Provider key access (daemon-backed)

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
        /// True when the result was produced by a network/auth error rather than
        /// a successful (not-found) response. Callers that need to distinguish
        /// "key absent" from "fetch failed" should check this field.
        var isNetworkError: Bool = false
    }

    /// Calls `secrets/read` (without `reveal`) and returns existence + masked value.
    private static func readSecret(for provider: String) async -> SecretReadResult {
        do {
            let body: [String: Any] = ["type": "api_key", "name": provider]
            let response = try await GatewayHTTPClient.post(
                path: "secrets/read", json: body, timeout: 5
            )
            guard response.isSuccess,
                  let json = try? JSONSerialization.jsonObject(with: response.data) as? [String: Any],
                  let found = json["found"] as? Bool else {
                // Any guard failure — non-success HTTP, JSON parse error, or missing
                // 'found' field — is treated as ambiguous (key status unknown), not
                // as definitively absent. keyStatus(for:) returns nil so callers
                // don't trigger auto-reset on transient or malformed responses.
                return SecretReadResult(found: false, masked: nil, isNetworkError: true)
            }
            let masked = json["masked"] as? String
            return SecretReadResult(found: found, masked: masked)
        } catch {
            apiKeyLog.error("readSecret(\(provider, privacy: .public)) failed: \(error.localizedDescription, privacy: .public)")
            return SecretReadResult(found: false, masked: nil, isNetworkError: true)
        }
    }

    /// Check whether the assistant's secret store has a key for `provider`.
    /// Returns `true` (key present), `false` (key absent), or `nil` (fetch failed —
    /// status unknown). Use this instead of `hasKey` when a fetch error should not
    /// be treated as "no key" — for example, before an auto-reset that would
    /// overwrite the user's intentional mode selection.
    static func keyStatus(for provider: String) async -> Bool? {
        let result = await readSecret(for: provider)
        if result.isNetworkError { return nil }
        return result.found
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

    /// Write a key to the daemon's secret store via the gateway API.
    /// Performs server-side validation and returns the result.
    @discardableResult
    static func setKey(_ key: String, for provider: String) async -> SetKeyResult {
        do {
            let body: [String: Any] = ["type": "api_key", "name": provider, "value": key]
            let response = try await GatewayHTTPClient.post(
                path: "secrets", json: body, timeout: 5
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

    /// Delete a key from the daemon's secret store via the gateway API.
    /// Returns `true` when the server confirms deletion.
    @discardableResult
    static func deleteKey(for provider: String) async -> Bool {
        do {
            let body: [String: Any] = ["type": "api_key", "name": provider]
            let response = try await GatewayHTTPClient.delete(
                path: "secrets", json: body, timeout: 5
            )
            return response.isSuccess
        } catch {
            apiKeyLog.error("deleteKey(\(provider, privacy: .public)) async failed: \(error.localizedDescription, privacy: .public)")
            return false
        }
    }

    /// List API-key provider names currently stored in the daemon's secret
    /// store via the gateway API. Filters out non-`api_key` entries (e.g.
    /// OAuth credentials) so callers get just the BYOK provider set.
    ///
    /// Returns `nil` on transport failure — callers should treat that as
    /// "status unknown" rather than "no keys stored", same convention as
    /// ``keyStatus(for:)``.
    static func listKeys() async -> Set<String>? {
        do {
            let response = try await GatewayHTTPClient.get(
                path: "secrets", timeout: 5
            )
            guard response.isSuccess else {
                apiKeyLog.error("listKeys failed: HTTP \(response.statusCode, privacy: .public)")
                return nil
            }
            return parseListKeysResponse(response.data)
        } catch {
            apiKeyLog.error("listKeys failed: \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    /// Parse the `GET /v1/secrets` response into the set of `api_key`
    /// provider names. Internal so tests can exercise the shape handling
    /// (notably the `secrets`/`accounts` alias and the mixed `api_key` /
    /// `credential` entry forms) without standing up a gateway.
    static func parseListKeysResponse(_ data: Data) -> Set<String>? {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        // The daemon returns both `secrets` and `accounts` as aliases of the
        // same array; prefer `secrets` and fall back for older daemons.
        let entries = (json["secrets"] as? [[String: Any]])
            ?? (json["accounts"] as? [[String: Any]])
            ?? []
        var names = Set<String>()
        for entry in entries {
            guard let type = entry["type"] as? String, type == "api_key",
                  let name = entry["name"] as? String, !name.isEmpty else {
                continue
            }
            names.insert(name)
        }
        return names
    }

    /// List credential entries from the daemon's secret store.
    /// Returns an array of (service, field) tuples for credential-type secrets,
    /// or nil on transport failure.
    static func listCredentials() async -> [(service: String, field: String)]? {
        do {
            let response = try await GatewayHTTPClient.get(path: "secrets", timeout: 5)
            guard response.isSuccess else { return nil }
            return parseListCredentialsResponse(response.data)
        } catch {
            apiKeyLog.error("listCredentials failed: \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    /// Surfaces only `credential`-type entries from the daemon's secret store.
    ///
    /// `api_key`-type entries are intentionally excluded: they back the inline
    /// API Key field at the top of the provider editor, and the credential
    /// dropdown is for picking *additional* credential references. Lumping them
    /// in caused two failure modes the dropdown couldn't recover from —
    /// `secrets/read` with `type:"credential"` returned not-found (the entry
    /// lives under `type:"api_key"`), so saving a value would write a fresh
    /// `credential`-type row alongside the original.
    static func parseListCredentialsResponse(_ data: Data) -> [(service: String, field: String)]? {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        let entries = (json["secrets"] as? [[String: Any]])
            ?? (json["accounts"] as? [[String: Any]])
            ?? []
        var results: [(service: String, field: String)] = []
        for entry in entries {
            guard let type = entry["type"] as? String, type == "credential",
                  let name = entry["name"] as? String else { continue }
            guard let colonIdx = name.lastIndex(of: ":") else { continue }
            let service = String(name[name.startIndex..<colonIdx])
            let field = String(name[name.index(after: colonIdx)...])
            if !service.isEmpty && !field.isEmpty {
                results.append((service: service, field: field))
            }
        }
        return results
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
                path: "secrets/read", json: body, timeout: 5
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
                path: "secrets", json: body, timeout: 5
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
                path: "secrets", json: body, timeout: 5
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
