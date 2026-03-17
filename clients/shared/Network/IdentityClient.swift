import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "IdentityClient")

/// Focused client for fetching remote assistant identity via the gateway.
@MainActor
public protocol IdentityClientProtocol {
    func fetchRemoteIdentity() async -> RemoteIdentityInfo?
    func fetchIdentity() async -> IdentityGetResponse?
}

/// Gateway-backed implementation of ``IdentityClientProtocol``.
@MainActor
public struct IdentityClient: IdentityClientProtocol {
    nonisolated public init() {}

    public func fetchRemoteIdentity() async -> RemoteIdentityInfo? {
        do {
            let response = try await GatewayHTTPClient.get(
                path: "assistants/{assistantId}/identity", timeout: 10
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

    public func fetchIdentity() async -> IdentityGetResponse? {
        do {
            let response = try await GatewayHTTPClient.get(
                path: "assistants/{assistantId}/identity", timeout: 10
            )
            guard response.isSuccess else {
                log.error("fetchIdentity failed (HTTP \(response.statusCode))")
                return nil
            }
            let patched = injectType("identity_get_response", into: response.data)
            return try JSONDecoder().decode(IdentityGetResponse.self, from: patched)
        } catch {
            log.error("fetchIdentity error: \(error.localizedDescription)")
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
