#if os(macOS)
import Foundation
import VellumAssistantShared
import os

private let log = Logger(
    subsystem: Bundle.appBundleIdentifier,
    category: "GatewayCredentialStorage"
)

/// Gateway-backed CredentialStorage implementation.
///
/// Routes credential reads and writes through the daemon's secrets API
/// (`POST /v1/secrets`, `POST /v1/secrets/read`, `DELETE /v1/secrets`)
/// so that credentials stored in the assistant's `~/.vellum/protected/`
/// directory are accessed via the gateway rather than direct disk I/O.
///
/// The synchronous ``CredentialStorage`` methods delegate to
/// ``FileCredentialStorage`` so existing non-async callers continue to
/// work.  Async callers should prefer the explicit `getAsync` / `setAsync`
/// / `deleteAsync` methods which hit the gateway first and fall back to
/// the file store on error.
struct GatewayCredentialStorage: CredentialStorage {

    private let fileStorage = FileCredentialStorage()

    // MARK: - Account ↔ Gateway Mapping

    /// Maps a flat credential-storage account name to the gateway secrets
    /// API `(type, name)` pair.
    ///
    /// Account name conventions used by callers:
    /// - `vellum_provider_{provider}`  → type: `api_key`, name: `{provider}`
    ///
    /// The following account types are **not** routed through the gateway
    /// because the daemon's secrets API uses a single key per `(service, field)`
    /// and cannot represent the per-instance scoping these accounts need:
    /// - `vellum_assistant_credential_{id}` — scoped by runtime assistant ID
    /// - `vellum_platform_id_{runtimeId}_{orgId}_{userId}` — scoped by runtime/org/user
    ///
    /// Returns `nil` for unrecognised or unroutable account names (the gateway
    /// won't be consulted and the file store handles them directly).
    private static func gatewayMapping(for account: String) -> (type: String, name: String)? {
        if account.hasPrefix("vellum_provider_") {
            let provider = String(account.dropFirst("vellum_provider_".count))
            guard !provider.isEmpty else { return nil }
            return ("api_key", provider)
        }
        // vellum_assistant_credential_{id} and vellum_platform_id_{…} are
        // NOT routed through the gateway — the daemon's secrets API stores
        // credentials under a single (service, field) key and can't represent
        // the per-instance scoping these accounts require.  They remain
        // file-only until the gateway supports scoped credential keys.
        return nil
    }

    // MARK: - Synchronous CredentialStorage (file-backed)

    func get(account: String) -> String? {
        fileStorage.get(account: account)
    }

    func set(account: String, value: String) -> Bool {
        fileStorage.set(account: account, value: value)
    }

    func delete(account: String) -> Bool {
        fileStorage.delete(account: account)
    }

    // MARK: - Async Gateway Methods

    /// Reads a credential value from the gateway secrets API.
    /// Falls back to ``FileCredentialStorage`` when the gateway is
    /// unreachable or returns an error.
    func getAsync(account: String) async -> String? {
        guard let mapping = Self.gatewayMapping(for: account) else {
            return fileStorage.get(account: account)
        }
        do {
            let response = try await GatewayHTTPClient.post(
                path: "secrets/read",
                json: ["type": mapping.type, "name": mapping.name, "reveal": true],
                timeout: 5
            )
            if response.isSuccess,
               let json = try? JSONSerialization.jsonObject(with: response.data) as? [String: Any],
               let found = json["found"] as? Bool, found,
               let value = json["value"] as? String {
                // Update the file cache so sync callers see the latest value.
                _ = fileStorage.set(account: account, value: value)
                return value
            }
            // Gateway returned not-found or non-success — fall through to file.
        } catch {
            log.warning("Gateway credential read failed for '\(account, privacy: .public)', falling back to file: \(error.localizedDescription, privacy: .public)")
        }
        return fileStorage.get(account: account)
    }

    /// Writes a credential value through the gateway secrets API.
    /// Also writes to the file store as a local cache so sync callers
    /// can read the value immediately.
    func setAsync(account: String, value: String) async -> Bool {
        // Always write the local file cache first so sync callers have
        // immediate access, even if the gateway call fails.
        let fileResult = fileStorage.set(account: account, value: value)

        guard let mapping = Self.gatewayMapping(for: account) else {
            return fileResult
        }
        do {
            let response = try await GatewayHTTPClient.post(
                path: "secrets",
                json: ["type": mapping.type, "name": mapping.name, "value": value],
                timeout: 5
            )
            if response.isSuccess {
                log.info("Credential '\(account, privacy: .public)' written via gateway")
                return true
            }
            log.warning("Gateway credential write failed for '\(account, privacy: .public)': HTTP \(response.statusCode, privacy: .public)")
        } catch {
            log.warning("Gateway credential write failed for '\(account, privacy: .public)', file cache preserved: \(error.localizedDescription, privacy: .public)")
        }
        return fileResult
    }

    /// Deletes a credential from the gateway secrets API and the local
    /// file cache.
    func deleteAsync(account: String) async -> Bool {
        // Delete from file cache first.
        let fileResult = fileStorage.delete(account: account)

        guard let mapping = Self.gatewayMapping(for: account) else {
            return fileResult
        }
        do {
            let response = try await GatewayHTTPClient.delete(
                path: "secrets",
                json: ["type": mapping.type, "name": mapping.name],
                timeout: 5
            )
            if response.isSuccess || response.statusCode == 404 {
                log.info("Credential '\(account, privacy: .public)' deleted via gateway")
                return true
            }
            log.warning("Gateway credential delete failed for '\(account, privacy: .public)': HTTP \(response.statusCode, privacy: .public)")
        } catch {
            log.warning("Gateway credential delete failed for '\(account, privacy: .public)': \(error.localizedDescription, privacy: .public)")
        }
        return fileResult
    }
}
#endif
