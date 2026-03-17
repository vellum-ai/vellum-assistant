import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "IdentityClient")

/// Focused client for fetching remote assistant identity via the gateway.
@MainActor
public protocol IdentityClientProtocol {
    func fetchRemoteIdentity() async -> RemoteIdentityInfo?
}

/// Gateway-backed implementation of ``IdentityClientProtocol``.
@MainActor
public struct IdentityClient: IdentityClientProtocol {
    nonisolated public init() {}

    public func fetchRemoteIdentity() async -> RemoteIdentityInfo? {
        do {
            let response = try await GatewayHTTPClient.get(
                path: "identity", timeout: 10
            )
            guard response.isSuccess else {
                log.error("fetchRemoteIdentity failed (HTTP \(response.statusCode))")
                return nil
            }
            return try JSONDecoder().decode(RemoteIdentityInfo.self, from: response.data)
        } catch {
            log.error("fetchRemoteIdentity error: \(error.localizedDescription)")
            return nil
        }
    }
}
