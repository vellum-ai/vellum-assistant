import XCTest

@testable import VellumAssistantShared

final class MultiClientSyncTests: XCTestCase {
    func testSyncTagRouterMapsKnownTagsAndIgnoresFutureTags() {
        let routes = SyncTagRouter.routes(for: [
            "assistant:self:avatar",
            "assistant:self:identity",
            "assistant:self:config",
            "assistant:self:sounds",
            "assistant:self:schedules",
            "conversations:list",
            "conversation:conv-123:metadata",
            "conversation:conv-123:messages",
            "future:resource",
        ])

        XCTAssertEqual(routes, [
            .assistantAvatar,
            .assistantIdentity,
            .assistantConfig,
            .assistantSounds,
            .assistantSchedules,
            .conversationList,
            .conversationMetadata(conversationId: "conv-123"),
            .conversationMessages(conversationId: "conv-123"),
        ])
    }

    func testSyncTagRouterDeduplicatesRoutes() {
        let routes = SyncTagRouter.routes(for: [
            "assistant:self:avatar",
            "assistant:self:avatar",
            "conversation:conv-123:messages",
            "conversation:conv-123:messages",
        ])

        XCTAssertEqual(routes, [
            .assistantAvatar,
            .conversationMessages(conversationId: "conv-123"),
        ])
    }

    func testSyncTagRouterRejectsMalformedConversationTags() {
        let routes = SyncTagRouter.routes(for: [
            "conversation::messages",
            "conversation:conv-123",
            "conversation:conv-123:messages:extra",
            "conversation:conv-123:unknown",
        ])

        XCTAssertEqual(routes, [])
    }

    func testBroadRefreshRoutesIncludeActiveConversationWhenPresent() {
        let routes = SyncTagRouter.broadRefreshRoutes(activeConversationId: "conv-active")

        XCTAssertEqual(routes, [
            .conversationList,
            .assistantAvatar,
            .assistantIdentity,
            .assistantConfig,
            .assistantSounds,
            .assistantSchedules,
            .conversationMetadata(conversationId: "conv-active"),
            .conversationMessages(conversationId: "conv-active"),
        ])
    }
}
