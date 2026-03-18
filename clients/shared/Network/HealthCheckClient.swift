import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "HealthCheckClient")

/// Checks assistant reachability via the authenticated gateway healthz endpoint.
///
/// All requests go through `GatewayHTTPClient` which handles URL resolution,
/// authentication, and routing for both local and remote assistants.
/// Uses `GET /v1/assistants/{id}/healthz` which verifies gateway connectivity,
/// daemon availability, and JWT validity.
@MainActor
public enum HealthCheckClient {

    /// Check whether the currently connected assistant is reachable.
    public static func isReachable(timeout: TimeInterval = 3) async -> Bool {
        do {
            let response = try await GatewayHTTPClient.get(
                path: "assistants/{assistantId}/healthz",
                timeout: timeout
            )
            return response.isSuccess
        } catch {
            return false
        }
    }

    #if os(macOS)
    /// Check whether a specific assistant is reachable via the connected gateway.
    public static func isReachable(for assistant: LockfileAssistant, timeout: TimeInterval = 3) async -> Bool {
        do {
            let response = try await GatewayHTTPClient.get(
                path: "assistants/\(assistant.assistantId)/healthz",
                timeout: timeout
            )
            return response.isSuccess
        } catch {
            return false
        }
    }

    /// Check whether the assistant matching the given instance directory is reachable.
    public static func isReachable(instanceDir: String?, timeout: TimeInterval = 3) async -> Bool {
        if let instanceDir,
           let assistant = LockfileAssistant.loadAll().first(where: { $0.instanceDir == instanceDir }) {
            return await isReachable(for: assistant, timeout: timeout)
        }
        return await isReachable(timeout: timeout)
    }
    #endif
}
