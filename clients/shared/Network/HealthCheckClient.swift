import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "HealthCheckClient")

/// Checks assistant reachability via the gateway healthz endpoint.
///
/// For the connected assistant, uses `GatewayHTTPClient` to hit the
/// authenticated `GET /v1/assistants/{id}/healthz` which verifies
/// gateway connectivity, daemon availability, and JWT validity.
///
/// For non-connected local assistants, hits the unauthenticated
/// `GET /healthz` on the assistant's own gateway port because each
/// local gateway has its own JWT signing key and we only hold a token
/// for the currently connected assistant.
@MainActor
public enum HealthCheckClient {

    /// Check whether the currently connected assistant is reachable
    /// using the authenticated healthz endpoint via `GatewayHTTPClient`.
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
    /// Check whether a specific assistant's gateway is reachable.
    ///
    /// For remote assistants, delegates to the connected-assistant path
    /// through `GatewayHTTPClient`. For local assistants, pings the
    /// unauthenticated `/healthz` on the assistant's own gateway port.
    public static func isReachable(for assistant: LockfileAssistant, timeout: TimeInterval = 3) async -> Bool {
        if assistant.isRemote {
            return await isReachable(timeout: timeout)
        }
        let port = assistant.gatewayPort ?? LockfilePaths.resolveGatewayPort(connectedAssistantId: assistant.assistantId)
        return await pingGatewayHealthz(port: port, timeout: timeout)
    }

    /// Check whether the assistant matching the given instance directory is reachable.
    public static func isReachable(instanceDir: String?, timeout: TimeInterval = 3) async -> Bool {
        if let instanceDir,
           let assistant = LockfileAssistant.loadAll().first(where: { $0.instanceDir == instanceDir }) {
            return await isReachable(for: assistant, timeout: timeout)
        }
        return await isReachable(timeout: timeout)
    }

    private static func pingGatewayHealthz(port: Int, timeout: TimeInterval) async -> Bool {
        guard let url = URL(string: "http://127.0.0.1:\(port)/healthz") else { return false }
        var request = URLRequest(url: url)
        request.timeoutInterval = timeout
        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            return (response as? HTTPURLResponse)?.statusCode == 200
        } catch {
            return false
        }
    }
    #endif
}
