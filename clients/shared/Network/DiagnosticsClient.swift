import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "DiagnosticsClient")

/// Focused client for diagnostics operations routed through the gateway.
@MainActor
public protocol DiagnosticsClientProtocol {
    func fetchEnvVars() async -> EnvVarsResponseMessage?
}

/// Gateway-backed implementation of ``DiagnosticsClientProtocol``.
@MainActor
public struct DiagnosticsClient: DiagnosticsClientProtocol {
    nonisolated public init() {}

    public func fetchEnvVars() async -> EnvVarsResponseMessage? {
        do {
            let response = try await GatewayHTTPClient.get(
                path: "assistants/{assistantId}/diagnostics/env-vars", timeout: 10
            )
            guard response.isSuccess else {
                log.error("fetchEnvVars failed (HTTP \(response.statusCode))")
                return nil
            }
            let patched = injectType("env_vars_response", into: response.data)
            return try JSONDecoder().decode(EnvVarsResponseMessage.self, from: patched)
        } catch {
            log.error("fetchEnvVars error: \(error.localizedDescription)")
            return nil
        }
    }

    // MARK: - Helpers

    private func injectType(_ type: String, into data: Data) -> Data {
        guard var json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return data
        }
        json["type"] = type
        return (try? JSONSerialization.data(withJSONObject: json)) ?? data
    }
}
