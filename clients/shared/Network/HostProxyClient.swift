import Foundation
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "HostProxyClient")

/// Focused client for posting host proxy execution results back to the gateway.
public protocol HostProxyClientProtocol {
    func postBashResult(_ result: HostBashResultPayload) async -> Bool
    func postFileResult(_ result: HostFileResultPayload) async -> Bool
    func postCuResult(_ result: HostCuResultPayload) async -> Bool
    func postAppControlResult(_ result: HostAppControlResultPayload) async -> Bool
    func postBrowserResult(_ result: HostBrowserResultPayload) async -> Bool
    func postTransferResult(_ result: HostTransferResultPayload) async -> Bool
    func pullTransferContent(transferId: String) async throws -> Data
    func pushTransferContent(transferId: String, data: Data, sha256: String, sourcePath: String) async throws -> Bool
}

/// Gateway-backed implementation of ``HostProxyClientProtocol``.
public struct HostProxyClient: HostProxyClientProtocol {
    nonisolated public init() {}

    public func postBashResult(_ result: HostBashResultPayload) async -> Bool {
        do {
            let body = try JSONEncoder().encode(result)
            let response = try await GatewayHTTPClient.post(
                path: "host-bash-result",
                body: body,
                extraHeaders: ["X-Vellum-Client-Id": DeviceIdStore.getOrCreate()],
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
                path: "host-file-result",
                body: body,
                extraHeaders: ["X-Vellum-Client-Id": DeviceIdStore.getOrCreate()],
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
                path: "host-cu-result",
                body: body,
                extraHeaders: ["X-Vellum-Client-Id": DeviceIdStore.getOrCreate()],
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

    public func postAppControlResult(_ result: HostAppControlResultPayload) async -> Bool {
        do {
            let body = try JSONEncoder().encode(result)
            // pngBase64 may be present (~1-2 MB for full-window screenshots);
            // scale the timeout so large payloads don't trigger URLSession's
            // cancellation race, mirroring postFileResult's behaviour.
            let timeout: TimeInterval = result.pngBase64 != nil
                ? max(30, TimeInterval(body.count) / (1024 * 1024) * 5 + 30)
                : 30
            let response = try await GatewayHTTPClient.post(
                path: "host-app-control-result",
                body: body,
                timeout: timeout
            )
            guard response.isSuccess else {
                log.error("postAppControlResult failed (HTTP \(response.statusCode))")
                return false
            }
            return true
        } catch {
            log.error("postAppControlResult error: \(error.localizedDescription)")
            return false
        }
    }

    public func postBrowserResult(_ result: HostBrowserResultPayload) async -> Bool {
        do {
            let body = try JSONEncoder().encode(result)
            let response = try await GatewayHTTPClient.post(
                path: "host-browser-result",
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

    public func postTransferResult(_ result: HostTransferResultPayload) async -> Bool {
        do {
            let body = try JSONEncoder().encode(result)
            // Scale timeout based on payload size for large transfer results.
            let timeout: TimeInterval = max(30, TimeInterval(body.count) / (1024 * 1024) * 5 + 30)
            let response = try await GatewayHTTPClient.post(
                path: "host-transfer-result",
                body: body,
                extraHeaders: ["X-Vellum-Client-Id": DeviceIdStore.getOrCreate()],
                timeout: timeout
            )
            guard response.isSuccess else {
                log.error("postTransferResult failed (HTTP \(response.statusCode))")
                return false
            }
            return true
        } catch {
            log.error("postTransferResult error: \(error.localizedDescription)")
            return false
        }
    }

    public func pullTransferContent(transferId: String) async throws -> Data {
        // Use a generous timeout — large files may take a while to download.
        let response = try await GatewayHTTPClient.get(
            path: "transfers/\(transferId)/content",
            timeout: 300,
            extraHeaders: ["X-Vellum-Client-Id": DeviceIdStore.getOrCreate()]
        )
        guard response.isSuccess else {
            throw TransferError.pullFailed(statusCode: response.statusCode)
        }
        return response.data
    }

    public func pushTransferContent(transferId: String, data: Data, sha256: String, sourcePath: String) async throws -> Bool {
        // Scale timeout by data size: ~5s per MB with a 30s minimum.
        let timeout: TimeInterval = max(30, TimeInterval(data.count) / (1024 * 1024) * 5 + 30)
        let response = try await GatewayHTTPClient.put(
            path: "transfers/\(transferId)/content",
            body: data,
            params: ["sourcePath": sourcePath],
            contentType: "application/octet-stream",
            extraHeaders: ["X-Transfer-SHA256": sha256, "X-Vellum-Client-Id": DeviceIdStore.getOrCreate()],
            timeout: timeout
        )
        guard response.isSuccess else {
            log.error("pushTransferContent failed (HTTP \(response.statusCode))")
            return false
        }
        return true
    }

    enum TransferError: LocalizedError {
        case pullFailed(statusCode: Int)

        var errorDescription: String? {
            switch self {
            case .pullFailed(let statusCode):
                return "Failed to pull transfer content (HTTP \(statusCode))"
            }
        }
    }
}
