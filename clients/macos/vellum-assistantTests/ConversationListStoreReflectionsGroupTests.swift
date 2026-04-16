import Foundation
import Testing
@testable import VellumAssistantLib
import VellumAssistantShared

@Suite("ConversationListStore reflections in background group", .serialized)
@MainActor
struct ConversationListStoreReflectionsGroupTests {

    private func systemGroups() -> [ConversationGroup] {
        [
            ConversationGroup(id: "system:pinned", name: "Pinned", sortPosition: 0, isSystemGroup: true),
            ConversationGroup(id: "system:background", name: "Background", sortPosition: 2, isSystemGroup: true),
            ConversationGroup(id: "system:all", name: "Recents", sortPosition: 3, isSystemGroup: true),
        ]
    }

    @Test
    func autoAnalysisConversationsAppearInBackgroundGroup() {
        let store = ConversationListStore()
        store.groups = systemGroups()
        store.conversations = [
            ConversationModel(title: "Regular", conversationId: "a", groupId: "system:all"),
            ConversationModel(title: "Analysis: x", conversationId: "b", groupId: "system:background", source: "auto-analysis"),
        ]

        let backgroundEntry = store.sidebarGroupEntries.first { $0.group.id == "system:background" }
        #expect(backgroundEntry != nil)
        #expect(backgroundEntry?.conversations.contains { $0.conversationId == "b" } == true)
    }
}
