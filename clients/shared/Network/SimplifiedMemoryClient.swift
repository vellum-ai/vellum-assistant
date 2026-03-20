import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "SimplifiedMemoryClient")

/// Focused client for simplified memory operations routed through the gateway.
@MainActor
public protocol SimplifiedMemoryClientProtocol {
    func fetchMemories(search: String?, limit: Int, offset: Int) async -> MemoriesListResponse?
    func createObservation(content: String) async -> MemoryObservationPayload?
    func deleteObservation(id: String) async -> Bool
}

/// Gateway-backed implementation of ``SimplifiedMemoryClientProtocol``.
@MainActor
public struct SimplifiedMemoryClient: SimplifiedMemoryClientProtocol {
    nonisolated public init() {}

    public func fetchMemories(
        search: String? = nil,
        limit: Int = 100,
        offset: Int = 0
    ) async -> MemoriesListResponse? {
        var params: [String: String] = [
            "limit": "\(limit)",
            "offset": "\(offset)"
        ]
        if let search, !search.isEmpty { params["search"] = search }

        do {
            let response = try await GatewayHTTPClient.get(
                path: "assistants/{assistantId}/memories", params: params, timeout: 10
            )
            guard response.isSuccess else {
                log.error("fetchMemories failed (HTTP \(response.statusCode))")
                return nil
            }
            return try? JSONDecoder().decode(MemoriesListResponse.self, from: response.data)
        } catch {
            log.error("fetchMemories failed: \(error.localizedDescription)")
            return nil
        }
    }

    public func createObservation(content: String) async -> MemoryObservationPayload? {
        let body: [String: Any] = ["content": content]

        do {
            let response = try await GatewayHTTPClient.post(
                path: "assistants/{assistantId}/memories", json: body, timeout: 10
            )
            guard response.isSuccess else {
                log.error("createObservation failed (HTTP \(response.statusCode))")
                return nil
            }
            struct Wrapper: Decodable { let observation: MemoryObservationPayload }
            return try? JSONDecoder().decode(Wrapper.self, from: response.data).observation
        } catch {
            log.error("createObservation failed: \(error.localizedDescription)")
            return nil
        }
    }

    public func deleteObservation(id: String) async -> Bool {
        do {
            let response = try await GatewayHTTPClient.delete(
                path: "assistants/{assistantId}/memories/\(id)", timeout: 10
            )
            return response.statusCode == 204
        } catch {
            log.error("deleteObservation failed: \(error.localizedDescription)")
            return false
        }
    }
}
