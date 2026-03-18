import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "TraceEventClient")

/// Focused client for trace event history operations routed through the gateway.
@MainActor
public protocol TraceEventClientProtocol {
    func fetchHistory(conversationId: String) async throws -> [TraceEventMessage]
}

/// Gateway-backed implementation of ``TraceEventClientProtocol``.
@MainActor
public struct TraceEventClient: TraceEventClientProtocol {
    nonisolated public init() {}

    public func fetchHistory(conversationId: String) async throws -> [TraceEventMessage] {
        let response = try await GatewayHTTPClient.get(
            path: "assistants/{assistantId}/trace-events",
            params: ["conversationId": conversationId],
            timeout: 10
        )
        guard response.isSuccess else {
            log.error("fetchHistory failed (HTTP \(response.statusCode))")
            return []
        }
        let decoded = try JSONDecoder().decode(TraceEventsHistoryResponse.self, from: response.data)
        return decoded.events
    }
}
