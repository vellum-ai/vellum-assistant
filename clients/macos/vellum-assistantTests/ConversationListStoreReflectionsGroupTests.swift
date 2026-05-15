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

    /// Verifies that the pre-computed system/custom partitions stay in sync
    /// with `sidebarGroupEntries` and expose the same entries the inline
    /// `.filter` calls previously produced. This is the contract the sidebar
    /// view relies on to avoid allocating fresh filtered arrays per render.
    @Test
    func sidebarPartitionsSplitSystemAndCustomGroups() {
        let store = ConversationListStore()
        store.customGroupsEnabled = true
        store.groups = systemGroups() + [
            ConversationGroup(id: "custom:work", name: "Work", sortPosition: 10, isSystemGroup: false),
        ]
        store.conversations = [
            ConversationModel(title: "Regular", conversationId: "a", groupId: "system:all"),
            ConversationModel(title: "Task", conversationId: "c", groupId: "custom:work"),
        ]

        let systemIds = store.systemSidebarGroupEntries.map(\.group.id)
        let customIds = store.customSidebarGroupEntries.map(\.group.id)

        #expect(systemIds.allSatisfy { $0.hasPrefix("system:") })
        #expect(customIds == ["custom:work"])
        #expect(store.sidebarGroupEntries.count == systemIds.count + customIds.count)
    }

    @Test
    func slackConversationsGetConditionalSystemSection() {
        let store = ConversationListStore()
        store.groups = systemGroups()
        store.conversations = [
            ConversationModel(title: "Regular", conversationId: "regular", groupId: ConversationGroup.all.id),
            ConversationModel(title: "Slack", conversationId: "slack", groupId: ConversationGroup.all.id, originChannel: "slack"),
            ConversationModel(title: "Pinned Slack", conversationId: "pinned-slack", groupId: ConversationGroup.pinned.id, originChannel: "slack"),
        ]

        let systemIds = store.systemSidebarGroupEntries.map(\.group.id)
        let slackConversationIds = store.sidebarGroupEntries
            .first { $0.group.id == ConversationGroup.slack.id }?
            .conversations.compactMap(\.conversationId) ?? []
        let recentsConversationIds = store.sidebarGroupEntries
            .first { $0.group.id == ConversationGroup.all.id }?
            .conversations.compactMap(\.conversationId) ?? []
        let pinnedConversationIds = store.sidebarGroupEntries
            .first { $0.group.id == ConversationGroup.pinned.id }?
            .conversations.compactMap(\.conversationId) ?? []

        #expect(systemIds == [
            ConversationGroup.pinned.id,
            ConversationGroup.background.id,
            ConversationGroup.slack.id,
            ConversationGroup.all.id,
        ])
        #expect(slackConversationIds == ["slack"])
        #expect(recentsConversationIds == ["regular"])
        #expect(pinnedConversationIds == ["pinned-slack"])
    }

    @Test
    func slackSectionIsOmittedWhenNoSlackConversationsExist() {
        let store = ConversationListStore()
        store.groups = systemGroups()
        store.conversations = [
            ConversationModel(title: "Regular", conversationId: "regular", groupId: ConversationGroup.all.id),
        ]

        #expect(!store.systemSidebarGroupEntries.contains { $0.group.id == ConversationGroup.slack.id })
    }
}
