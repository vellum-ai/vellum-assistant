import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "SubagentClient")

/// Focused client for subagent operations routed through the gateway.
@MainActor
public protocol SubagentClientProtocol {
    func abort(subagentId: String, conversationId: String?) async -> Bool
    func fetchDetail(subagentId: String, conversationId: String) async -> SubagentDetailResponse?
}

/// Gateway-backed implementation of ``SubagentClientProtocol``.
@MainActor
public struct SubagentClient: SubagentClientProtocol {
    nonisolated public init() {}

    public func abort(subagentId: String, conversationId: String? = nil) async -> Bool {
        do {
            var body: [String: Any] = [:]
            if let conversationId { body["conversationId"] = conversationId }

            let response = try await GatewayHTTPClient.post(
                path: "assistants/{assistantId}/subagents/\(subagentId)/abort",
                json: body,
                timeout: 10
            )
            guard response.isSuccess else {
                log.error("abort failed (HTTP \(response.statusCode))")
                return false
            }
            return true
        } catch {
            log.error("abort error: \(error.localizedDescription)")
            return false
        }
    }

    public func fetchDetail(subagentId: String, conversationId: String) async -> SubagentDetailResponse? {
        do {
            let params: [String: String] = ["conversationId": conversationId]
            let response = try await GatewayHTTPClient.get(
                path: "assistants/{assistantId}/subagents/\(subagentId)",
                params: params,
                timeout: 10
            )
            guard response.isSuccess else {
                log.error("fetchDetail failed (HTTP \(response.statusCode))")
                return nil
            }
            let patched = injectType("subagent_detail_response", into: response.data)
            return try JSONDecoder().decode(SubagentDetailResponse.self, from: patched)
        } catch {
            log.error("fetchDetail error: \(error.localizedDescription)")
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
