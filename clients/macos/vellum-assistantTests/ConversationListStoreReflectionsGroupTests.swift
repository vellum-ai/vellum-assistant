import Foundation
import Testing
@testable import VellumAssistantLib
import VellumAssistantShared

@Suite("ConversationListStore reflections group", .serialized)
@MainActor
struct ConversationListStoreReflectionsGroupTests {

    private func systemGroups() -> [ConversationGroup] {
        [
            ConversationGroup(id: "system:pinned", name: "Pinned", sortPosition: 0, isSystemGroup: true),
            ConversationGroup(id: "system:all", name: "Recents", sortPosition: 3, isSystemGroup: true),
            ConversationGroup(id: ReflectionsSidebarSectionId.id, name: "Reflections", sortPosition: 100, isSystemGroup: true),
        ]
    }

    @Test
    func sidebarGroupEntriesExcludesReflectionsGroup_whenEmpty() {
        let store = ConversationListStore()
        store.groups = systemGroups()
        store.conversations = [
            ConversationModel(title: "Regular", conversationId: "a", groupId: "system:all")
        ]

        #expect(store.sidebarGroupEntries.allSatisfy { $0.group.id != ReflectionsSidebarSectionId.id })
    }

    @Test
    func sidebarGroupEntriesExcludesReflectionsGroup_whenPopulated() {
        let store = ConversationListStore()
        store.groups = systemGroups()
        store.conversations = [
            ConversationModel(title: "Regular", conversationId: "a", groupId: "system:all"),
            ConversationModel(title: "Analysis: x", conversationId: "b", groupId: ReflectionsSidebarSectionId.id, source: "auto-analysis"),
        ]

        #expect(store.sidebarGroupEntries.allSatisfy { $0.group.id != ReflectionsSidebarSectionId.id })
    }
}
