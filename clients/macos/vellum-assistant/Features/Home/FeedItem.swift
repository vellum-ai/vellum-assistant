import Foundation

/// A single item in the home feed.
struct FeedItem: Codable, Identifiable, Sendable {

    let id: String
    let type: FeedItemType
    var status: FeedItemStatus
    let title: String
    let body: String?
    let conversationId: String?
    let createdAt: Date
    let actions: [FeedAction]

    struct FeedAction: Codable, Identifiable, Sendable {
        let id: String
        let label: String
        let style: String?
    }

    enum FeedItemType: String, Codable, Sendable {
        case nudge
        case digest
        case action
        case thread
    }

    enum FeedItemStatus: String, Codable, Sendable {
        case new
        case seen
        case actedOn = "acted_on"
    }
}
