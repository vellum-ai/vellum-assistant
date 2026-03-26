import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "HostProxyClient")

/// Focused client for posting host proxy execution results back to the gateway.
public protocol HostProxyClientProtocol {
    func postBashResult(_ result: HostBashResultPayload) async -> Bool
    func postFileResult(_ result: HostFileResultPayload) async -> Bool
    func postCuResult(_ result: HostCuResultPayload) async -> Bool
}

/// Gateway-backed implementation of ``HostProxyClientProtocol``.
public struct HostProxyClient: HostProxyClientProtocol {
    nonisolated public init() {}

    public func postBashResult(_ result: HostBashResultPayload) async -> Bool {
        do {
            let body = try JSONEncoder().encode(result)
            let response = try await GatewayHTTPClient.post(
                path: "assistants/{assistantId}/host-bash-result",
                body: body,
                timeout: 30
            )
            guard response.isSuccess else {
                log.error("postBashResult failed (HTTP \(response.statusCode))")
                return false
            }
            return true
        } catch {
            log.error("postBashResult error: \(error.localizedDescription)")
            return false
        }
    }

    public func postFileResult(_ result: HostFileResultPayload) async -> Bool {
        do {
            let body = try JSONEncoder().encode(result)
            let response = try await GatewayHTTPClient.post(
                path: "assistants/{assistantId}/host-file-result",
                body: body,
                timeout: 30
            )
            guard response.isSuccess else {
                log.error("postFileResult failed (HTTP \(response.statusCode))")
                return false
            }
            return true
        } catch {
            log.error("postFileResult error: \(error.localizedDescription)")
            return false
        }
    }

    public func postCuResult(_ result: HostCuResultPayload) async -> Bool {
        do {
            let body = try JSONEncoder().encode(result)
            let response = try await GatewayHTTPClient.post(
                path: "assistants/{assistantId}/host-cu-result",
                body: body,
                timeout: 30
            )
            guard response.isSuccess else {
                log.error("postCuResult failed (HTTP \(response.statusCode))")
                return false
            }
            return true
        } catch {
            log.error("postCuResult error: \(error.localizedDescription)")
            return false
        }
    }
}
