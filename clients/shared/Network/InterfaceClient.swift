import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "InterfaceClient")

/// Focused client for fetching interface files routed through the gateway.
@MainActor
public protocol InterfaceClientProtocol {
    /// Fetch an interface file via `GET /v1/interfaces/<path>`.
    /// Returns the file content as a string, or `nil` if the file does not exist.
    func fetchInterfaceFile(path: String) async -> String?
}

/// Gateway-backed implementation of ``InterfaceClientProtocol``.
@MainActor
public struct InterfaceClient: InterfaceClientProtocol {
    nonisolated public init() {}

    public func fetchInterfaceFile(path: String) async -> String? {
        let response = try? await GatewayHTTPClient.get(
            path: "assistants/{assistantId}/interfaces/\(path)", timeout: 5
        )
        guard let response, response.isSuccess else {
            if let statusCode = response?.statusCode {
                log.error("Fetch interface file failed (HTTP \(statusCode))")
            }
            return nil
        }
        return String(data: response.data, encoding: .utf8)
    }
}
