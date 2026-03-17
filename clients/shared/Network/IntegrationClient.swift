import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "IntegrationClient")

/// Focused client for integration status operations routed through the gateway.
@MainActor
public protocol IntegrationClientProtocol {
    func fetchIntegrationsStatus() async -> IntegrationsStatusResponse?
}

/// Response from the integrations status endpoint.
public struct IntegrationsStatusResponse: Decodable, Sendable {
    public struct Email: Decodable, Sendable {
        public let address: String?
    }
    public let email: Email
}

/// Gateway-backed implementation of ``IntegrationClientProtocol``.
@MainActor
public struct IntegrationClient: IntegrationClientProtocol {
    nonisolated public init() {}

    public func fetchIntegrationsStatus() async -> IntegrationsStatusResponse? {
        do {
            let response = try await GatewayHTTPClient.rawGet(
                absolutePath: "/integrations/status", timeout: 5
            )
            guard response.isSuccess else {
                log.error("fetchIntegrationsStatus failed (HTTP \(response.statusCode))")
                return nil
            }
            return try JSONDecoder().decode(IntegrationsStatusResponse.self, from: response.data)
        } catch {
            log.error("fetchIntegrationsStatus error: \(error.localizedDescription)")
            return nil
        }
    }
}
