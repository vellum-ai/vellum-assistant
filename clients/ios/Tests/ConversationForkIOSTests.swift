#if canImport(UIKit)
import SwiftUI
import XCTest

@testable import VellumAssistantShared
@testable import vellum_assistant_ios

@MainActor
final class ConversationForkIOSTests: XCTestCase {
    private let connectedCacheKey = "ios_connected_conversations_cache_v1"

    func testForkConversationPublishesSelectionAndPersistsLineageInConnectedCache() async throws {
        let (userDefaults, suiteName) = makeUserDefaults()
        defer { clear(userDefaults, suiteName: suiteName) }

        let daemonClient = GatewayConnectionManager()
        daemonClient.isConnected = true
        let forkClient = MockConversationForkClient()
        forkClient.response = makeForkedConversationItem(messageId: "msg-root")

        let store = IOSConversationStore(
            daemonClient: daemonClient,
            eventStreamClient: daemonClient.eventStreamClient,
            connectedModeOverride: true,
            conversationForkClient: forkClient,
            userDefaults: userDefaults
        )
        store.isLoadingInitialConversations = false

        let parent = IOSConversation(
            title: "Parent thread",
            conversationId: "conv-parent"
        )
        store.conversations = [parent]

        let forkedLocalId = await store.forkConversation(
            conversationLocalId: parent.id,
            throughDaemonMessageId: "msg-root"
        )
        let unwrappedForkedLocalId = try XCTUnwrap(forkedLocalId)

        XCTAssertEqual(forkClient.requests.count, 1)
        XCTAssertEqual(forkClient.requests.first?.conversationId, "conv-parent")
        XCTAssertEqual(forkClient.requests.first?.throughMessageId, "msg-root")
        XCTAssertEqual(store.selectionRequest?.conversationLocalId, unwrappedForkedLocalId)

        let forkedConversation = try XCTUnwrap(store.conversations.first(where: { $0.id == unwrappedForkedLocalId }))
        XCTAssertEqual(forkedConversation.conversationId, "conv-forked")
        XCTAssertEqual(forkedConversation.forkParent?.conversationId, "conv-parent")
        XCTAssertEqual(forkedConversation.forkParent?.messageId, "msg-root")
        XCTAssertEqual(store.conversations.first?.id, unwrappedForkedLocalId)

        let restoredStore = IOSConversationStore(
            daemonClient: daemonClient,
            eventStreamClient: daemonClient.eventStreamClient,
            connectedModeOverride: true,
            conversationForkClient: forkClient,
            userDefaults: userDefaults
        )
        let restoredFork = try XCTUnwrap(
            restoredStore.conversations.first(where: { $0.conversationId == "conv-forked" })
        )
        XCTAssertEqual(restoredFork.forkParent?.conversationId, "conv-parent")
        XCTAssertEqual(restoredFork.forkParent?.messageId, "msg-root")
        XCTAssertNotNil(userDefaults.data(forKey: connectedCacheKey))
    }

    func testConnectedCacheWithoutForkParentStillLoads() throws {
        let (userDefaults, suiteName) = makeUserDefaults()
        defer { clear(userDefaults, suiteName: suiteName) }

        let legacyConversation = LegacyPersistedConversation(
            id: UUID(),
            title: "Older cache entry",
            createdAt: Date(timeIntervalSince1970: 1_700_000_000),
            lastActivityAt: Date(timeIntervalSince1970: 1_700_000_050),
            isArchived: false,
            isPinned: true,
            displayOrder: 3,
            isPrivate: false,
            conversationId: "conv-legacy",
            scheduleJobId: nil,
            hasUnseenLatestAssistantMessage: false,
            latestAssistantMessageAt: nil,
            lastSeenAssistantMessageAt: nil
        )
        let data = try JSONEncoder().encode([legacyConversation])
        userDefaults.set(data, forKey: connectedCacheKey)

        let daemonClient = GatewayConnectionManager()
        daemonClient.isConnected = true
        let store = IOSConversationStore(
            daemonClient: daemonClient,
            eventStreamClient: daemonClient.eventStreamClient,
            connectedModeOverride: true,
            userDefaults: userDefaults
        )

        let restored = try XCTUnwrap(store.conversations.first)
        XCTAssertEqual(restored.conversationId, "conv-legacy")
        XCTAssertEqual(restored.title, "Older cache entry")
        XCTAssertNil(restored.forkParent)
    }

    func testConversationListRefreshClearsStaleForkParentFromCachedConversation() {
        let (userDefaults, suiteName) = makeUserDefaults()
        defer { clear(userDefaults, suiteName: suiteName) }

        let daemonClient = GatewayConnectionManager()
        let store = IOSConversationStore(
            daemonClient: daemonClient,
            eventStreamClient: daemonClient.eventStreamClient,
            connectedModeOverride: true,
            userDefaults: userDefaults
        )
        store.isLoadingInitialConversations = false

        let cachedConversation = IOSConversation(
            title: "Cached thread",
            conversationId: "conv-thread",
            forkParent: ConversationForkParent(
                conversationId: "conv-parent",
                messageId: "msg-parent",
                title: "Parent thread"
            )
        )
        store.conversations = [cachedConversation]

        let response = makeConversationListResponse(
            conversations: [
                ConversationListResponseItem(
                    id: "conv-thread",
                    title: "Cached thread",
                    createdAt: 1_700_000_000,
                    updatedAt: 1_700_000_100,
                    conversationType: "standard"
                )
            ]
        )
        store.handleConversationListResponse(response)

        let refreshed = store.conversations.first(where: { $0.conversationId == "conv-thread" })
        XCTAssertNil(refreshed?.forkParent)
    }

    func testExactForkCommandInterceptsCurrentPersistedTipWithoutAppendingUserBubble() async throws {
        let (userDefaults, suiteName) = makeUserDefaults()
        defer { clear(userDefaults, suiteName: suiteName) }

        let daemonClient = GatewayConnectionManager()
        daemonClient.isConnected = true
        let forkClient = MockConversationForkClient()
        forkClient.response = makeForkedConversationItem(messageId: "msg-tip")

        let store = IOSConversationStore(
            daemonClient: daemonClient,
            eventStreamClient: daemonClient.eventStreamClient,
            connectedModeOverride: true,
            conversationForkClient: forkClient,
            userDefaults: userDefaults
        )
        store.isLoadingInitialConversations = false

        let parent = IOSConversation(
            title: "Parent thread",
            conversationId: "conv-parent"
        )
        store.conversations = [parent]

        let viewModel = store.viewModel(for: parent.id)
        var persistedTip = ChatMessage(role: .assistant, text: "Persisted assistant reply")
        persistedTip.daemonMessageId = "msg-tip"
        viewModel.messages = [persistedTip]

        await waitUntil(timeout: 1.0) { viewModel.onFork != nil }

        viewModel.inputText = "/fork"
        viewModel.sendMessage()

        XCTAssertEqual(viewModel.messages.count, 1)
        XCTAssertEqual(viewModel.messages.first?.text, "Persisted assistant reply")
        XCTAssertEqual(viewModel.inputText, "")

        await waitUntil(timeout: 1.0) { store.selectionRequest != nil }

        XCTAssertEqual(forkClient.requests.count, 1)
        XCTAssertEqual(forkClient.requests.first?.conversationId, "conv-parent")
        XCTAssertEqual(forkClient.requests.first?.throughMessageId, "msg-tip")
        XCTAssertEqual(store.selectionRequest?.conversationLocalId, store.conversations.first?.id)
    }

    func testSelectionRequestTargetsCompactAndRegularNavigationState() {
        let conversationId = UUID()
        let request = ConversationSelectionRequest(conversationLocalId: conversationId)

        var compactPath: [UUID] = []
        var compactSelection: UUID?
        applyConversationSelectionRequest(
            request,
            horizontalSizeClass: .compact,
            navigationPath: &compactPath,
            selectedConversationId: &compactSelection
        )
        XCTAssertEqual(compactPath, [conversationId])
        XCTAssertNil(compactSelection)

        var regularPath: [UUID] = []
        var regularSelection: UUID?
        applyConversationSelectionRequest(
            request,
            horizontalSizeClass: .regular,
            navigationPath: &regularPath,
            selectedConversationId: &regularSelection
        )
        XCTAssertTrue(regularPath.isEmpty)
        XCTAssertEqual(regularSelection, conversationId)
    }

    private func makeUserDefaults() -> (UserDefaults, String) {
        let suiteName = "ConversationForkIOSTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defaults.removePersistentDomain(forName: suiteName)
        return (defaults, suiteName)
    }

    private func clear(_ userDefaults: UserDefaults, suiteName: String) {
        userDefaults.removePersistentDomain(forName: suiteName)
    }

    private func waitUntil(
        timeout: TimeInterval,
        file: StaticString = #filePath,
        line: UInt = #line,
        condition: @escaping () -> Bool
    ) async {
        let deadline = ContinuousClock.now + .seconds(timeout)
        while !condition() && ContinuousClock.now < deadline {
            try? await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertTrue(condition(), file: file, line: line)
    }

    private func makeForkedConversationItem(messageId: String) -> ConversationListResponseItem {
        ConversationListResponseItem(
            id: "conv-forked",
            title: "Forked thread",
            createdAt: 1_700_000_100,
            updatedAt: 1_700_000_120,
            forkParent: ConversationForkParent(
                conversationId: "conv-parent",
                messageId: messageId,
                title: "Parent thread"
            )
        )
    }

    private func makeConversationListResponse(
        conversations: [ConversationListResponseItem],
        hasMore: Bool? = nil
    ) -> ConversationListResponseMessage {
        var payload: [String: Any] = [
            "type": "conversation_list_response",
            "conversations": conversations.map { item in
                var dict: [String: Any] = [
                    "id": item.id,
                    "title": item.title,
                    "updatedAt": item.updatedAt,
                ]
                if let createdAt = item.createdAt {
                    dict["createdAt"] = createdAt
                }
                if let conversationType = item.conversationType {
                    dict["conversationType"] = conversationType
                }
                if let forkParent = item.forkParent {
                    let forkParentDict: [String: Any] = [
                        "conversationId": forkParent.conversationId,
                        "messageId": forkParent.messageId,
                        "title": forkParent.title
                    ]
                    dict["forkParent"] = forkParentDict
                }
                return dict
            }
        ]
        if let hasMore {
            payload["hasMore"] = hasMore
        }
        let data = try! JSONSerialization.data(withJSONObject: payload)
        return try! JSONDecoder().decode(ConversationListResponseMessage.self, from: data)
    }
}

@MainActor
private final class MockConversationForkClient: ConversationForkClientProtocol {
    struct Request: Equatable {
        let conversationId: String
        let throughMessageId: String?
    }

    var response: ConversationListResponseItem?
    private(set) var requests: [Request] = []

    func forkConversation(conversationId: String, throughMessageId: String?) async -> ConversationListResponseItem? {
        requests.append(Request(conversationId: conversationId, throughMessageId: throughMessageId))
        return response
    }
}

private struct LegacyPersistedConversation: Codable {
    let id: UUID
    let title: String
    let createdAt: Date
    let lastActivityAt: Date?
    let isArchived: Bool?
    let isPinned: Bool?
    let displayOrder: Int?
    let isPrivate: Bool?
    let conversationId: String?
    let scheduleJobId: String?
    let hasUnseenLatestAssistantMessage: Bool?
    let latestAssistantMessageAt: Date?
    let lastSeenAssistantMessageAt: Date?
}
#endif
