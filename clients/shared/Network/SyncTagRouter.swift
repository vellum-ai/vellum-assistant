import Foundation

/// Native-side interpretation of generic `sync_changed` tags.
///
/// Tags describe stale resources; routes describe which local cache/reload
/// path should react. Unknown tags are intentionally ignored so newer daemons
/// can add resources without breaking older clients.
public enum SyncTagRoute: Hashable, Sendable {
    case conversationList
    case conversationMetadata(conversationId: String)
    case conversationMessages(conversationId: String)
    case assistantAvatar
    case assistantIdentity
    case assistantConfig
    case assistantSounds
    case assistantSchedules
}

public enum SyncTagRouter {
    public static func routes(for tags: [String]) -> [SyncTagRoute] {
        var seen = Set<SyncTagRoute>()
        var routes: [SyncTagRoute] = []

        for tag in tags {
            guard let route = route(for: tag) else { continue }
            guard seen.insert(route).inserted else { continue }
            routes.append(route)
        }

        return routes
    }

    public static func broadRefreshRoutes(activeConversationId: String?) -> [SyncTagRoute] {
        var routes: [SyncTagRoute] = [
            .conversationList,
            .assistantAvatar,
            .assistantIdentity,
            .assistantConfig,
            .assistantSounds,
            .assistantSchedules,
        ]

        if let activeConversationId, !activeConversationId.isEmpty {
            routes.append(.conversationMetadata(conversationId: activeConversationId))
            routes.append(.conversationMessages(conversationId: activeConversationId))
        }

        return routes
    }

    private static func route(for tag: String) -> SyncTagRoute? {
        switch tag {
        case "conversations:list":
            return .conversationList
        case "assistant:self:avatar":
            return .assistantAvatar
        case "assistant:self:identity":
            return .assistantIdentity
        case "assistant:self:config":
            return .assistantConfig
        case "assistant:self:sounds":
            return .assistantSounds
        case "assistant:self:schedules":
            return .assistantSchedules
        default:
            return conversationRoute(for: tag)
        }
    }

    private static func conversationRoute(for tag: String) -> SyncTagRoute? {
        let parts = tag.split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count == 3, parts[0] == "conversation", !parts[1].isEmpty else {
            return nil
        }

        let conversationId = String(parts[1])
        switch parts[2] {
        case "metadata":
            return .conversationMetadata(conversationId: conversationId)
        case "messages":
            return .conversationMessages(conversationId: conversationId)
        default:
            return nil
        }
    }
}
