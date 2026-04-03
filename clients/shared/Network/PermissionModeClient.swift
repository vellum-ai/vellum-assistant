import Foundation
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "PermissionModeClient")

/// Protocol for the two-axis permission mode endpoints.
///
/// - `GET /v1/permission-mode` — always available, returns current state.
/// - `PUT /v1/permission-mode` — gated on `permission-controls-v2` flag.
public protocol PermissionModeClientProtocol {
    func fetchPermissionMode() async -> PermissionModeUpdateMessage?
    func updatePermissionMode(askBeforeActing: Bool?, hostAccess: Bool?) async -> PermissionModeUpdateMessage?
}

/// Gateway-backed implementation of ``PermissionModeClientProtocol``.
public struct PermissionModeClient: PermissionModeClientProtocol {
    nonisolated public init() {}

    /// Fetches the current permission mode state.
    ///
    /// Returns the current state on success, or `nil` on failure.
    public func fetchPermissionMode() async -> PermissionModeUpdateMessage? {
        do {
            let response = try await GatewayHTTPClient.get(path: "permission-mode", quiet: true)
            guard response.isSuccess else {
                log.warning("GET /v1/permission-mode failed with status \(response.statusCode)")
                return nil
            }
            return try JSONDecoder().decode(PermissionModeUpdateMessage.self, from: response.data)
        } catch {
            log.error("Failed to fetch permission mode: \(error.localizedDescription)")
            return nil
        }
    }

    /// Updates one or both axes of the permission mode.
    ///
    /// Returns the updated state on success, or `nil` on failure (including
    /// 404 when the `permission-controls-v2` flag is off).
    public func updatePermissionMode(
        askBeforeActing: Bool? = nil,
        hostAccess: Bool? = nil
    ) async -> PermissionModeUpdateMessage? {
        var body: [String: Any] = [:]
        if let askBeforeActing {
            body["askBeforeActing"] = askBeforeActing
        }
        if let hostAccess {
            body["hostAccess"] = hostAccess
        }

        do {
            let response = try await GatewayHTTPClient.put(path: "permission-mode", json: body)
            guard response.isSuccess else {
                log.warning("PUT /v1/permission-mode failed with status \(response.statusCode)")
                return nil
            }
            return try JSONDecoder().decode(PermissionModeUpdateMessage.self, from: response.data)
        } catch {
            log.error("Failed to update permission mode: \(error.localizedDescription)")
            return nil
        }
    }
}
