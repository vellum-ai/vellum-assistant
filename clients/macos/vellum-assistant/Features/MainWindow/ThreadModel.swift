import Foundation

struct ThreadModel: Identifiable, Hashable {
    let id: UUID
    let title: String
    let createdAt: Date
    /// Daemon conversation ID for restored threads. Nil for new, unsaved threads.
    let sessionId: String?
    var isArchived: Bool

    init(id: UUID = UUID(), title: String = "New Thread", createdAt: Date = Date(), sessionId: String? = nil, isArchived: Bool = false) {
        self.id = id
        self.title = title
        self.createdAt = createdAt
        self.sessionId = sessionId
        self.isArchived = isArchived
    }
}
