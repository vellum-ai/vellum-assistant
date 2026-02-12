import Foundation

struct ThreadModel: Identifiable, Hashable {
    let id: UUID
    let title: String
    let createdAt: Date

    init(id: UUID = UUID(), title: String = "New Thread", createdAt: Date = Date()) {
        self.id = id
        self.title = title
        self.createdAt = createdAt
    }
}
