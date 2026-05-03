import Foundation
import Testing
@testable import VellumAssistantLib
import VellumAssistantShared

private let archivedTimestampsKey = "archivedConversationTimestamps"

private func clearArchiveDefaults() {
    UserDefaults.standard.removeObject(forKey: archivedTimestampsKey)
}

private func makeArchived(conversationId: String, title: String = "Test", createdAt: Date = Date()) -> ConversationModel {
    ConversationModel(
        title: title,
        createdAt: createdAt,
        conversationId: conversationId,
        isArchived: true
    )
}

@Suite("ConversationListStore archive sort", .serialized)
@MainActor
struct ConversationListStoreArchiveSortTests {

    init() {
        clearArchiveDefaults()
    }

    @Test
    func archivedConversationsSortedByArchiveTimeDescending() {
        defer { clearArchiveDefaults() }

        let store = ConversationListStore()
        let base = Date(timeIntervalSince1970: 1_700_000_000)

        store.conversations = [
            makeArchived(conversationId: "a", title: "First archived"),
            makeArchived(conversationId: "b", title: "Second archived"),
            makeArchived(conversationId: "c", title: "Third archived"),
        ]

        store.markArchived("a", at: base)
        store.markArchived("b", at: base.addingTimeInterval(1))
        store.markArchived("c", at: base.addingTimeInterval(2))

        let titles = store.archivedConversations.map(\.title)
        #expect(titles == ["Third archived", "Second archived", "First archived"])
    }

    @Test
    func replaceArchivedKeyPreservesTimestamp() {
        defer { clearArchiveDefaults() }

        let store = ConversationListStore()
        let archivedAt = Date(timeIntervalSince1970: 1_700_000_500)

        store.markArchived("synthetic", at: archivedAt)
        store.replaceArchivedKey(from: "synthetic", to: "real-server-id")

        #expect(store.archivedConversationTimestamps["synthetic"] == nil)
        #expect(store.archivedConversationTimestamps["real-server-id"] == archivedAt)
    }

    @Test
    func unmarkArchivedRemovesTimestamp() {
        defer { clearArchiveDefaults() }

        let store = ConversationListStore()
        store.markArchived("a", at: Date())
        #expect(store.archivedConversationTimestamps["a"] != nil)

        store.unmarkArchived("a")
        #expect(store.archivedConversationTimestamps["a"] == nil)
    }

    @Test
    func markArchivedBulkSharesSingleTimestamp() {
        defer { clearArchiveDefaults() }

        let store = ConversationListStore()
        let sharedTime = Date(timeIntervalSince1970: 1_700_000_999)

        store.markArchived(["x", "y", "z"], at: sharedTime)

        #expect(store.archivedConversationTimestamps["x"] == sharedTime)
        #expect(store.archivedConversationTimestamps["y"] == sharedTime)
        #expect(store.archivedConversationTimestamps["z"] == sharedTime)
    }

    @Test
    func archivedConversationIdsWrapperReflectsTimestampDict() {
        defer { clearArchiveDefaults() }

        let store = ConversationListStore()
        store.markArchived("a")
        store.markArchived("b")

        #expect(store.archivedConversationIds == ["a", "b"])
        #expect(store.isConversationArchived("a"))
        #expect(!store.isConversationArchived("c"))
    }

    @Test
    func timestampsPersistAcrossStoreInstances() {
        defer { clearArchiveDefaults() }

        let archivedAt = Date(timeIntervalSince1970: 1_700_001_234)
        do {
            let store = ConversationListStore()
            store.markArchived("persisted-id", at: archivedAt)
        }

        let reopened = ConversationListStore()
        #expect(reopened.archivedConversationTimestamps["persisted-id"] == archivedAt)
    }
}
