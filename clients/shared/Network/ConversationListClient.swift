import Foundation
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "ConversationListClient")

/// Focused client for conversation list and management operations via the gateway.
public protocol ConversationListClientProtocol {
    func fetchConversationList(offset: Int, limit: Int, conversationType: String?) async -> ConversationListResponse?
    func switchConversation(conversationId: String) async -> Bool
    func renameConversation(conversationId: String, name: String) async -> Bool
    func clearAllConversations() async -> Bool
    func cancelGeneration(conversationId: String) async -> Bool
    func undoLastMessage(conversationId: String) async -> Int?
    func searchConversations(query: String, limit: Int?, maxMessagesPerConversation: Int?) async -> ConversationSearchResponse?
    func reorderConversations(updates: [ReorderConversationsRequestUpdate]) async -> Bool
    func sendConversationSeen(_ signal: ConversationSeenSignal) async -> Bool
}

/// Gateway-backed implementation of ``ConversationListClientProtocol``.
public struct ConversationListClient: ConversationListClientProtocol {
    nonisolated public init() {}

    public func fetchConversationList(offset: Int = 0, limit: Int = 50, conversationType: String? = nil) async -> ConversationListResponse? {
        do {
            var params: [String: String] = [
                "limit": "\(limit)",
                "offset": "\(offset)",
            ]
            if offset == 0 { params.removeValue(forKey: "offset") }
            if let conversationType { params["conversationType"] = conversationType }

            let response = try await GatewayHTTPClient.get(
                path: "assistants/{assistantId}/conversations", params: params, timeout: 15
            )
            guard response.isSuccess else {
                log.error("fetchConversationList failed (HTTP \(response.statusCode))")
                return nil
            }
            let decoded = try JSONDecoder().decode(HTTPConversationsListResponse.self, from: response.data)
            let items = decoded.conversations.map {
                ConversationListResponseItem(
                    id: $0.id, title: $0.title,
                    createdAt: $0.createdAt ?? $0.updatedAt,
                    updatedAt: $0.updatedAt,
                    conversationType: $0.conversationType,
                    source: $0.source,
                    scheduleJobId: $0.scheduleJobId,
                    channelBinding: $0.channelBinding,
                    conversationOriginChannel: $0.conversationOriginChannel,
                    conversationOriginInterface: $0.conversationOriginInterface,
                    assistantAttention: $0.assistantAttention,
                    displayOrder: $0.displayOrder,
                    isPinned: $0.isPinned,
                    groupId: $0.groupId,
                    forkParent: $0.forkParent
                )
            }
            return ConversationListResponse(
                type: "conversation_list_response",
                conversations: items,
                hasMore: decoded.hasMore,
                groups: decoded.groups
            )
        } catch {
            log.error("fetchConversationList error: \(error.localizedDescription)")
            return nil
        }
    }

    // MARK: - Conversation Management

    public func switchConversation(conversationId: String) async -> Bool {
        do {
            let response = try await GatewayHTTPClient.post(
                path: "assistants/{assistantId}/conversations/switch",
                json: ["conversationId": conversationId],
                timeout: 10
            )
            guard response.isSuccess else {
                log.error("switchConversation failed (HTTP \(response.statusCode))")
                return false
            }
            return true
        } catch {
            log.error("switchConversation error: \(error.localizedDescription)")
            return false
        }
    }

    public func renameConversation(conversationId: String, name: String) async -> Bool {
        do {
            let response = try await GatewayHTTPClient.patch(
                path: "assistants/{assistantId}/conversations/\(conversationId)/name",
                json: ["name": name],
                timeout: 10
            )
            guard response.isSuccess else {
                log.error("renameConversation failed (HTTP \(response.statusCode))")
                return false
            }
            return true
        } catch {
            log.error("renameConversation error: \(error.localizedDescription)")
            return false
        }
    }

    public func clearAllConversations() async -> Bool {
        do {
            let response = try await GatewayHTTPClient.delete(
                path: "assistants/{assistantId}/conversations",
                timeout: 10
            )
            guard response.isSuccess || response.statusCode == 204 else {
                log.error("clearAllConversations failed (HTTP \(response.statusCode))")
                return false
            }
            return true
        } catch {
            log.error("clearAllConversations error: \(error.localizedDescription)")
            return false
        }
    }

    public func cancelGeneration(conversationId: String) async -> Bool {
        do {
            let response = try await GatewayHTTPClient.post(
                path: "assistants/{assistantId}/conversations/\(conversationId)/cancel",
                json: [:] as [String: String],
                timeout: 10
            )
            guard response.isSuccess || response.statusCode == 202 else {
                log.error("cancelGeneration failed (HTTP \(response.statusCode))")
                return false
            }
            return true
        } catch {
            log.error("cancelGeneration error: \(error.localizedDescription)")
            return false
        }
    }

    /// Returns the number of messages removed, or `nil` on failure.
    public func undoLastMessage(conversationId: String) async -> Int? {
        do {
            let response = try await GatewayHTTPClient.post(
                path: "assistants/{assistantId}/conversations/\(conversationId)/undo",
                json: [:] as [String: String],
                timeout: 10
            )
            guard response.isSuccess else {
                log.error("undoLastMessage failed (HTTP \(response.statusCode))")
                return nil
            }
            if let json = try? JSONSerialization.jsonObject(with: response.data) as? [String: Any],
               let removedCount = json["removedCount"] as? Int {
                return removedCount
            }
            return 0
        } catch {
            log.error("undoLastMessage error: \(error.localizedDescription)")
            return nil
        }
    }

    public func searchConversations(query: String, limit: Int? = nil, maxMessagesPerConversation: Int? = nil) async -> ConversationSearchResponse? {
        do {
            var params: [String: String] = ["q": query]
            if let limit { params["limit"] = "\(limit)" }
            if let maxMessagesPerConversation { params["maxMessagesPerConversation"] = "\(maxMessagesPerConversation)" }

            let response = try await GatewayHTTPClient.get(
                path: "assistants/{assistantId}/conversations/search",
                params: params,
                timeout: 15
            )
            guard response.isSuccess else {
                log.error("searchConversations failed (HTTP \(response.statusCode))")
                return nil
            }
            return try JSONDecoder().decode(HTTPConversationSearchResponse.self, from: response.data).toPublic(query: query)
        } catch {
            log.error("searchConversations error: \(error.localizedDescription)")
            return nil
        }
    }

    public func reorderConversations(updates: [ReorderConversationsRequestUpdate]) async -> Bool {
        do {
            let body: [String: Any] = [
                "updates": updates.map { u in
                    var entry: [String: Any] = [
                        "conversationId": u.conversationId,
                        "isPinned": u.isPinned
                    ]
                    if let order = u.displayOrder {
                        entry["displayOrder"] = order
                    }

                    #if os(macOS)
                    // macOS always sends groupId key: JSON null for ungrouped, string for grouped.
                    // This lets the server distinguish "explicitly ungrouped" (null) from "old client" (key absent).
                    entry["groupId"] = u.groupId as Any
                    #endif
                    // iOS: key is omitted entirely -- server treats as old client, preserves existing group_id.

                    return entry
                }
            ]
            let response = try await GatewayHTTPClient.post(
                path: "assistants/{assistantId}/conversations/reorder",
                json: body,
                timeout: 10
            )
            guard response.isSuccess else {
                log.error("reorderConversations failed (HTTP \(response.statusCode))")
                return false
            }
            return true
        } catch {
            log.error("reorderConversations error: \(error.localizedDescription)")
            return false
        }
    }

    // MARK: - Group Management

    public func fetchGroups() async -> [ConversationGroupResponse]? {
        do {
            let response = try await GatewayHTTPClient.get(
                path: "assistants/{assistantId}/groups",
                timeout: 15
            )
            guard response.isSuccess else {
                log.error("fetchGroups failed (HTTP \(response.statusCode))")
                return nil
            }
            struct GroupsResponse: Decodable {
                let groups: [ConversationGroupResponse]
            }
            let decoded = try JSONDecoder().decode(GroupsResponse.self, from: response.data)
            return decoded.groups
        } catch {
            log.error("fetchGroups error: \(error.localizedDescription)")
            return nil
        }
    }

    public func createGroup(name: String) async -> ConversationGroupResponse? {
        do {
            let response = try await GatewayHTTPClient.post(
                path: "assistants/{assistantId}/groups",
                json: ["name": name],
                timeout: 10
            )
            guard response.isSuccess || response.statusCode == 201 else {
                log.error("createGroup failed (HTTP \(response.statusCode))")
                return nil
            }
            return try JSONDecoder().decode(ConversationGroupResponse.self, from: response.data)
        } catch {
            log.error("createGroup error: \(error.localizedDescription)")
            return nil
        }
    }

    public func updateGroup(groupId: String, name: String?, sortPosition: Double?) async -> Bool {
        do {
            var body: [String: Any] = [:]
            if let name { body["name"] = name }
            if let sortPosition { body["sortPosition"] = sortPosition }

            let response = try await GatewayHTTPClient.patch(
                path: "assistants/{assistantId}/groups/\(groupId)",
                json: body,
                timeout: 10
            )
            guard response.isSuccess else {
                log.error("updateGroup failed (HTTP \(response.statusCode))")
                return false
            }
            return true
        } catch {
            log.error("updateGroup error: \(error.localizedDescription)")
            return false
        }
    }

    public func deleteGroup(groupId: String) async -> Bool {
        do {
            let response = try await GatewayHTTPClient.delete(
                path: "assistants/{assistantId}/groups/\(groupId)",
                timeout: 10
            )
            guard response.isSuccess || response.statusCode == 204 else {
                log.error("deleteGroup failed (HTTP \(response.statusCode))")
                return false
            }
            return true
        } catch {
            log.error("deleteGroup error: \(error.localizedDescription)")
            return false
        }
    }

    public func reorderGroups(updates: [(groupId: String, sortPosition: Double)]) async -> Bool {
        do {
            let body: [String: Any] = [
                "updates": updates.map { [
                    "groupId": $0.groupId,
                    "sortPosition": $0.sortPosition
                ] as [String: Any] }
            ]
            let response = try await GatewayHTTPClient.post(
                path: "assistants/{assistantId}/groups/reorder",
                json: body,
                timeout: 10
            )
            guard response.isSuccess else {
                log.error("reorderGroups failed (HTTP \(response.statusCode))")
                return false
            }
            return true
        } catch {
            log.error("reorderGroups error: \(error.localizedDescription)")
            return false
        }
    }

    public func sendConversationSeen(_ signal: ConversationSeenSignal) async -> Bool {
        do {
            var body: [String: Any] = [
                "conversationId": signal.conversationId,
                "sourceChannel": signal.sourceChannel,
                "signalType": signal.signalType,
                "confidence": signal.confidence,
                "source": signal.source
            ]
            if let evidenceText = signal.evidenceText {
                body["evidenceText"] = evidenceText
            }
            if let observedAt = signal.observedAt {
                body["observedAt"] = observedAt
            }

            let response = try await GatewayHTTPClient.post(
                path: "assistants/{assistantId}/conversations/seen",
                json: body,
                timeout: 10
            )
            guard response.isSuccess else {
                log.error("sendConversationSeen failed (HTTP \(response.statusCode))")
                return false
            }
            return true
        } catch {
            log.error("sendConversationSeen error: \(error.localizedDescription)")
            return false
        }
    }
}

// MARK: - Private HTTP Response DTOs

/// Mirrors the HTTP API's conversation list response shape. The public
/// ``ConversationListResponse`` type requires a `type` discriminant that
/// the HTTP endpoint omits, so we decode into this private DTO first.
private struct HTTPConversationsListResponse: Decodable {
    struct Conversation: Decodable {
        let id: String
        let title: String
        let createdAt: Int?
        let updatedAt: Int
        let conversationType: String?
        let source: String?
        let scheduleJobId: String?
        let channelBinding: ChannelBinding?
        let conversationOriginChannel: String?
        let conversationOriginInterface: String?
        let assistantAttention: AssistantAttention?
        let displayOrder: Double?
        let isPinned: Bool?
        let groupId: String?
        let forkParent: ConversationForkParent?
    }
    let conversations: [Conversation]
    let hasMore: Bool?
    let groups: [ConversationGroupResponse]?
}

/// The HTTP search endpoint omits the `type` discriminator, so we decode
/// into this private DTO and map to the public type.
private struct HTTPConversationSearchResponse: Decodable {
    let results: [ConversationSearchResultItem]

    func toPublic(query: String) -> ConversationSearchResponse {
        ConversationSearchResponse(
            type: "conversation_search_response",
            query: query,
            results: results
        )
    }
}
