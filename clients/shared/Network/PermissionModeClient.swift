import Foundation
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "PermissionModeClient")

/// HTTP client for the two-axis permission mode endpoints.
///
/// - `GET /v1/permission-mode` — always available, returns current state.
/// - `PUT /v1/permission-mode` — gated on `permission-controls-v2` flag.
public struct PermissionModeClient {
    nonisolated public init() {}

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
