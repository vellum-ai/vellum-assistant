import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

@MainActor
final class ConversationManagerHostAccessTests: XCTestCase {
    private var connectionManager: GatewayConnectionManager!
    private var mockHostAccessClient: MockConversationHostAccessClient!
    private var conversationManager: ConversationManager!

    override func setUp() {
        super.setUp()
        connectionManager = GatewayConnectionManager()
        connectionManager.isConnected = true
        mockHostAccessClient = MockConversationHostAccessClient()
        conversationManager = ConversationManager(
            connectionManager: connectionManager,
            eventStreamClient: connectionManager.eventStreamClient,
            conversationHostAccessClient: mockHostAccessClient
        )
    }

    override func tearDown() {
        conversationManager = nil
        mockHostAccessClient = nil
        connectionManager = nil
        super.tearDown()
    }

    func testSetConversationHostAccessUpdatesConversationOnSuccess() async {
        let localId = UUID()
        conversationManager.conversations = [
            ConversationModel(
                id: localId,
                title: "Host tools",
                conversationId: "conv-host",
                hostAccess: false
            )
        ]
        mockHostAccessClient.updateResponse = ConversationHostAccessResponse(
            conversationId: "conv-host",
            hostAccess: true
        )

        let success = await conversationManager.setConversationHostAccess(id: localId, enabled: true)

        XCTAssertTrue(success)
        XCTAssertEqual(
            mockHostAccessClient.updateCalls,
            [MockConversationHostAccessClient.UpdateCall(conversationId: "conv-host", hostAccess: true)]
        )
        XCTAssertTrue(conversationManager.conversations[0].hostAccess)
    }

    func testSetConversationHostAccessRevertsConversationOnFailure() async {
        let localId = UUID()
        conversationManager.conversations = [
            ConversationModel(
                id: localId,
                title: "Host tools",
                conversationId: "conv-host",
                hostAccess: false
            )
        ]
        mockHostAccessClient.updateResponse = nil

        let success = await conversationManager.setConversationHostAccess(id: localId, enabled: true)

        XCTAssertFalse(success)
        XCTAssertEqual(
            mockHostAccessClient.updateCalls,
            [MockConversationHostAccessClient.UpdateCall(conversationId: "conv-host", hostAccess: true)]
        )
        XCTAssertFalse(conversationManager.conversations[0].hostAccess)
    }

    func testConversationHostAccessUpdatedEventMergesIntoConversation() {
        let localId = UUID()
        conversationManager.conversations = [
            ConversationModel(
                id: localId,
                title: "Host tools",
                conversationId: "conv-host",
                hostAccess: false
            )
        ]

        let updatedExpectation = XCTNSPredicateExpectation(
            predicate: NSPredicate { _, _ in
                self.conversationManager.conversations.first?.hostAccess == true
            },
            object: nil
        )

        Task { @MainActor in
            await Task.yield()
            self.connectionManager.eventStreamClient.broadcastMessage(
                .conversationHostAccessUpdated(
                    ConversationHostAccessUpdatedMessage(
                        conversationId: "conv-host",
                        hostAccess: true
                    )
                )
            )
        }

        wait(for: [updatedExpectation], timeout: 1.0)
        XCTAssertTrue(conversationManager.conversations[0].hostAccess)
    }
}

private final class MockConversationHostAccessClient: ConversationHostAccessClientProtocol {
    struct UpdateCall: Equatable {
        let conversationId: String
        let hostAccess: Bool
    }

    var updateResponse: ConversationHostAccessResponse?
    private(set) var updateCalls: [UpdateCall] = []

    func fetchConversationHostAccess(conversationId: String) async -> ConversationHostAccessResponse? {
        nil
    }

    func updateConversationHostAccess(
        conversationId: String,
        hostAccess: Bool
    ) async -> ConversationHostAccessResponse? {
        updateCalls.append(UpdateCall(conversationId: conversationId, hostAccess: hostAccess))
        return updateResponse
    }
}
