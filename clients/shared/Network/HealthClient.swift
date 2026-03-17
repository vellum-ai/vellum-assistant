import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "HealthClient")

/// Focused client for runtime health checks routed through the gateway.
@MainActor
public protocol HealthClientProtocol {
    func checkHealth() async throws
}

/// Gateway-backed implementation of ``HealthClientProtocol``.
@MainActor
public struct HealthClient: HealthClientProtocol {
    nonisolated public init() {}

    enum HealthClientError: LocalizedError {
        case healthCheckFailed(statusCode: Int)

        var errorDescription: String? {
            switch self {
            case .healthCheckFailed(let statusCode):
                return "Health check failed (HTTP \(statusCode))"
            }
        }
    }

    /// Verify the runtime is reachable via the gateway health check endpoint.
    public func checkHealth() async throws {
        let response = try await GatewayHTTPClient.get(
            path: "assistants/{assistantId}/healthz", timeout: 10
        )
        guard response.isSuccess else {
            log.error("checkHealth failed (HTTP \(response.statusCode))")
            throw HealthClientError.healthCheckFailed(statusCode: response.statusCode)
        }
    }
}
