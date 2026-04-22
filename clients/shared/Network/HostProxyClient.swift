import Foundation
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "HostProxyClient")

/// Focused client for posting host proxy execution results back to the gateway.
public protocol HostProxyClientProtocol {
    func postBashResult(_ result: HostBashResultPayload) async -> Bool
    func postFileResult(_ result: HostFileResultPayload) async -> Bool
    func postCuResult(_ result: HostCuResultPayload) async -> Bool
    func postBrowserResult(_ result: HostBrowserResultPayload) async -> Bool
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
            // Scale the timeout for large payloads (e.g. base64-encoded images)
            // to avoid triggering Foundation's URLSession cancellation race.
            let timeout: TimeInterval = result.imageData != nil
                ? max(30, TimeInterval(body.count) / (1024 * 1024) * 5 + 30)
                : 30
            let response = try await GatewayHTTPClient.post(
                path: "assistants/{assistantId}/host-file-result",
                body: body,
                timeout: timeout
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

    public func postBrowserResult(_ result: HostBrowserResultPayload) async -> Bool {
        do {
            let body = try JSONEncoder().encode(result)
            let response = try await GatewayHTTPClient.post(
                path: "assistants/{assistantId}/host-browser-result",
                body: body,
                timeout: 30
            )
            guard response.isSuccess else {
                log.error("postBrowserResult failed (HTTP \(response.statusCode))")
                return false
            }
            return true
        } catch {
            log.error("postBrowserResult error: \(error.localizedDescription)")
            return false
        }
    }
}
