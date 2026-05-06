import Foundation
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "AdminAssistantClient")

/// Response payload from `GET /v1/admin/assistants/{id}/`.
///
/// Only the field consumed by the macOS client is declared. The Django
/// serializer returns additional fields (id, name, etc.); `JSONDecoder`
/// ignores undeclared keys so the lenient shape survives server additions.
public struct AdminAssistantDetailResponse: Decodable, Sendable {
    public let machine_size: String?
}

/// Focused client for admin-assistant operations routed through the platform.
///
/// Wraps the platform-scoped admin endpoints used by the Pro compute-upgrade
/// CTA in Settings. Both methods target unprefixed routes (no
/// `assistants/{assistantId}/` scope) because the path itself carries the
/// assistant id.
public enum AdminAssistantClient {
    /// Fetches admin metadata for the given assistant.
    ///
    /// Returns `nil` on any error (network, non-2xx, decoding) so callers can
    /// treat "unknown" as "show nothing" rather than surfacing transient
    /// failures in the UI.
    public static func fetchDetail(assistantId: String) async -> AdminAssistantDetailResponse? {
        do {
            let (decoded, response): (AdminAssistantDetailResponse?, GatewayHTTPClient.Response) =
                try await GatewayHTTPClient.get(
                    path: "admin/assistants/\(assistantId)/",
                    timeout: 15,
                    unprefixed: true
                ) { $0.keyDecodingStrategy = .useDefaultKeys }
            guard response.isSuccess else {
                log.error("fetchDetail failed (HTTP \(response.statusCode))")
                return nil
            }
            return decoded
        } catch {
            log.error("fetchDetail error: \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    /// Triggers the platform's pro-upgrade-machine flow for the given assistant.
    ///
    /// The 60-second timeout is intentional — the platform performs two
    /// sequential vembda calls which can be slow. Returns the success flag
    /// alongside the server-provided `detail` string (when present) so the
    /// caller can render either a confirmation or error message.
    public static func proUpgradeMachine(assistantId: String) async throws -> (success: Bool, detail: String?) {
        let response = try await GatewayHTTPClient.post(
            path: "admin/assistants/\(assistantId)/pro-upgrade-machine/",
            json: [:],
            timeout: 60,
            unprefixed: true
        )
        let detail = (try? JSONSerialization.jsonObject(with: response.data) as? [String: Any])?["detail"] as? String
        if !response.isSuccess {
            log.error("proUpgradeMachine failed (HTTP \(response.statusCode))")
        }
        return (response.isSuccess, detail)
    }
}
