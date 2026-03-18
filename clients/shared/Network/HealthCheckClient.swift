import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "HealthCheckClient")

/// Checks assistant reachability via the authenticated gateway healthz endpoint.
///
/// Uses `GET /v1/assistants/{id}/healthz` which verifies gateway connectivity,
/// daemon availability, and JWT validity — unlike the bare `/healthz` which
/// only confirms the gateway process is alive.
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
    /// Check whether a specific assistant's gateway and daemon are reachable.
    public static func isReachable(for assistant: LockfileAssistant, timeout: TimeInterval = 3) async -> Bool {
        if assistant.isRemote {
            guard let runtimeUrl = assistant.runtimeUrl,
                  let token = ActorTokenManager.getToken(), !token.isEmpty else {
                return false
            }
            return await pingAssistantHealthz(
                baseURL: runtimeUrl,
                assistantId: assistant.assistantId,
                token: token,
                authHeader: "Authorization",
                authValue: "Bearer \(token)",
                timeout: timeout
            )
        }
        let port = assistant.gatewayPort ?? LockfilePaths.resolveGatewayPort(connectedAssistantId: assistant.assistantId)
        guard let token = ActorTokenManager.getToken(), !token.isEmpty else {
            return false
        }
        return await pingAssistantHealthz(
            baseURL: "http://127.0.0.1:\(port)",
            assistantId: assistant.assistantId,
            token: token,
            authHeader: "Authorization",
            authValue: "Bearer \(token)",
            timeout: timeout
        )
    }

    /// Check whether the assistant matching the given instance directory is reachable.
    public static func isReachable(instanceDir: String?, timeout: TimeInterval = 3) async -> Bool {
        if let instanceDir,
           let assistant = LockfileAssistant.loadAll().first(where: { $0.instanceDir == instanceDir }) {
            return await isReachable(for: assistant, timeout: timeout)
        }
        return await isReachable(timeout: timeout)
    }

    private static func pingAssistantHealthz(
        baseURL: String,
        assistantId: String,
        token: String,
        authHeader: String,
        authValue: String,
        timeout: TimeInterval
    ) async -> Bool {
        guard let url = URL(string: "\(baseURL)/v1/assistants/\(assistantId)/healthz/") else { return false }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.timeoutInterval = timeout
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(authValue, forHTTPHeaderField: authHeader)
        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            return (response as? HTTPURLResponse)?.statusCode == 200
        } catch {
            return false
        }
    }
    #endif
}
