import Foundation
import VellumAssistantShared

/// Represents a conversation group for organizing conversations in the sidebar.
struct ConversationGroup: Identifiable, Hashable, Codable, Sendable {
    let id: String
    var name: String
    var sortPosition: Double
    var isSystemGroup: Bool

    static let pinned = ConversationGroup(
        id: "system:pinned", name: "Pinned", sortPosition: 0, isSystemGroup: true
    )
    static let scheduled = ConversationGroup(
        id: "system:scheduled", name: "Scheduled", sortPosition: 1, isSystemGroup: true
    )
    static let background = ConversationGroup(
        id: "system:background", name: "Background", sortPosition: 2, isSystemGroup: true
    )

    init(id: String, name: String, sortPosition: Double, isSystemGroup: Bool) {
        self.id = id
        self.name = name
        self.sortPosition = sortPosition
        self.isSystemGroup = isSystemGroup
    }

    init(from response: ConversationGroupResponse) {
        self.id = response.id
        self.name = response.name
        self.sortPosition = response.sortPosition
        self.isSystemGroup = response.isSystemGroup
    }
}
