import Foundation

struct ThreadModel: Identifiable, Hashable {
    let id: UUID
    let title: String
    let createdAt: Date
    /// Daemon conversation ID for restored threads. Nil for new, unsaved threads.
    var sessionId: String?
    /// Whether the thread is hidden from the tab bar (for drawer mode)
    var isHidden: Bool

    init(id: UUID = UUID(), title: String = "New Thread", createdAt: Date = Date(), sessionId: String? = nil, isHidden: Bool = false) {
        self.id = id
        self.title = title
        self.createdAt = createdAt
        self.sessionId = sessionId
        self.isHidden = isHidden
    }
}
