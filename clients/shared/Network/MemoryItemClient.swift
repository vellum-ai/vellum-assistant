import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "MemoryItemClient")

/// Focused client for memory item operations routed through the gateway.
public protocol MemoryItemClientProtocol {
    func fetchMemoryItems(
        kind: String?,
        status: String?,
        search: String?,
        sort: String?,
        order: String?,
        limit: Int,
        offset: Int
    ) async -> MemoryItemsListResponse?

    func fetchMemoryItem(id: String) async -> MemoryItemPayload?

    func createMemoryItem(
        kind: String,
        subject: String,
        statement: String,
        importance: Double?
    ) async -> MemoryItemPayload?

    func updateMemoryItem(
        id: String,
        subject: String?,
        statement: String?,
        kind: String?,
        status: String?,
        importance: Double?,
        verificationState: String?
    ) async -> MemoryItemPayload?

    func deleteMemoryItem(id: String) async -> Bool
}

/// Gateway-backed implementation of ``MemoryItemClientProtocol``.
public struct MemoryItemClient: MemoryItemClientProtocol {
    nonisolated public init() {}

    public func fetchMemoryItems(
        kind: String? = nil,
        status: String? = "active",
        search: String? = nil,
        sort: String? = "lastSeenAt",
        order: String? = "desc",
        limit: Int = 100,
        offset: Int = 0
    ) async -> MemoryItemsListResponse? {
        var params: [String: String] = [
            "limit": "\(limit)",
            "offset": "\(offset)"
        ]
        if let kind { params["kind"] = kind }
        if let status { params["status"] = status }
        if let search, !search.isEmpty { params["search"] = search }
        if let sort { params["sort"] = sort }
        if let order { params["order"] = order }

        do {
            let response = try await GatewayHTTPClient.get(
                path: "assistants/{assistantId}/memory-items", params: params, timeout: 10
            )
            guard response.isSuccess else {
                log.error("fetchMemoryItems failed (HTTP \(response.statusCode))")
                return nil
            }
            return try? JSONDecoder().decode(MemoryItemsListResponse.self, from: response.data)
        } catch {
            log.error("fetchMemoryItems failed: \(error.localizedDescription)")
            return nil
        }
    }

    public func fetchMemoryItem(id: String) async -> MemoryItemPayload? {
        do {
            let response = try await GatewayHTTPClient.get(
                path: "assistants/{assistantId}/memory-items/\(id)", timeout: 10
            )
            guard response.isSuccess else {
                log.error("fetchMemoryItem failed (HTTP \(response.statusCode))")
                return nil
            }
            struct Wrapper: Decodable { let item: MemoryItemPayload }
            return try? JSONDecoder().decode(Wrapper.self, from: response.data).item
        } catch {
            log.error("fetchMemoryItem failed: \(error.localizedDescription)")
            return nil
        }
    }

    public func createMemoryItem(
        kind: String,
        subject: String,
        statement: String,
        importance: Double? = nil
    ) async -> MemoryItemPayload? {
        var body: [String: Any] = [
            "kind": kind,
            "subject": subject,
            "statement": statement
        ]
        if let importance { body["importance"] = importance }

        do {
            let response = try await GatewayHTTPClient.post(
                path: "assistants/{assistantId}/memory-items", json: body, timeout: 10
            )
            guard response.isSuccess else {
                log.error("createMemoryItem failed (HTTP \(response.statusCode))")
                return nil
            }
            struct Wrapper: Decodable { let item: MemoryItemPayload }
            return try? JSONDecoder().decode(Wrapper.self, from: response.data).item
        } catch {
            log.error("createMemoryItem failed: \(error.localizedDescription)")
            return nil
        }
    }

    public func updateMemoryItem(
        id: String,
        subject: String? = nil,
        statement: String? = nil,
        kind: String? = nil,
        status: String? = nil,
        importance: Double? = nil,
        verificationState: String? = nil
    ) async -> MemoryItemPayload? {
        var body: [String: Any] = [:]
        if let subject { body["subject"] = subject }
        if let statement { body["statement"] = statement }
        if let kind { body["kind"] = kind }
        if let status { body["status"] = status }
        if let importance { body["importance"] = importance }
        if let verificationState { body["verificationState"] = verificationState }

        do {
            let response = try await GatewayHTTPClient.patch(
                path: "assistants/{assistantId}/memory-items/\(id)", json: body, timeout: 10
            )
            guard response.isSuccess else {
                log.error("updateMemoryItem failed (HTTP \(response.statusCode))")
                return nil
            }
            struct Wrapper: Decodable { let item: MemoryItemPayload }
            return try? JSONDecoder().decode(Wrapper.self, from: response.data).item
        } catch {
            log.error("updateMemoryItem failed: \(error.localizedDescription)")
            return nil
        }
    }

    public func deleteMemoryItem(id: String) async -> Bool {
        do {
            let response = try await GatewayHTTPClient.delete(
                path: "assistants/{assistantId}/memory-items/\(id)", timeout: 10
            )
            return response.statusCode == 204
        } catch {
            log.error("deleteMemoryItem failed: \(error.localizedDescription)")
            return false
        }
    }
}
