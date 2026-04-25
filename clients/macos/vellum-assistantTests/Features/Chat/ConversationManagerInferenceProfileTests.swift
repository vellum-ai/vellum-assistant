import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

@MainActor
final class ConversationManagerInferenceProfileTests: XCTestCase {
    private var connectionManager: GatewayConnectionManager!
    private var mockProfileClient: MockConversationInferenceProfileClient!
    private var conversationManager: ConversationManager!

    override func setUp() {
        super.setUp()
        connectionManager = GatewayConnectionManager()
        connectionManager.isConnected = true
        mockProfileClient = MockConversationInferenceProfileClient()
        conversationManager = ConversationManager(
            connectionManager: connectionManager,
            eventStreamClient: connectionManager.eventStreamClient,
            conversationInferenceProfileClient: mockProfileClient
        )
    }

    override func tearDown() {
        conversationManager = nil
        mockProfileClient = nil
        connectionManager = nil
        super.tearDown()
    }

    // MARK: - Setter

    func testSetConversationInferenceProfileUpdatesConversationOnSuccess() async {
        let localId = UUID()
        conversationManager.conversations = [
            ConversationModel(
                id: localId,
                title: "Profile target",
                conversationId: "conv-1",
                inferenceProfile: nil
            )
        ]
        mockProfileClient.setResponse = ConversationInferenceProfileResponse(
            conversationId: "conv-1",
            profile: "balanced"
        )

        let success = await conversationManager.setConversationInferenceProfile(
            id: localId,
            profile: "balanced"
        )

        XCTAssertTrue(success)
        XCTAssertEqual(
            mockProfileClient.setCalls,
            [MockConversationInferenceProfileClient.SetCall(conversationId: "conv-1", profile: "balanced")]
        )
        XCTAssertEqual(conversationManager.conversations[0].inferenceProfile, "balanced")
    }

    func testSetConversationInferenceProfileClearsOverrideWithNil() async {
        let localId = UUID()
        conversationManager.conversations = [
            ConversationModel(
                id: localId,
                title: "Profile target",
                conversationId: "conv-1",
                inferenceProfile: "balanced"
            )
        ]
        mockProfileClient.setResponse = ConversationInferenceProfileResponse(
            conversationId: "conv-1",
            profile: nil
        )

        let success = await conversationManager.setConversationInferenceProfile(
            id: localId,
            profile: nil
        )

        XCTAssertTrue(success)
        XCTAssertEqual(
            mockProfileClient.setCalls,
            [MockConversationInferenceProfileClient.SetCall(conversationId: "conv-1", profile: nil)]
        )
        XCTAssertNil(conversationManager.conversations[0].inferenceProfile)
    }

    func testSetConversationInferenceProfileRevertsOnFailure() async {
        let localId = UUID()
        conversationManager.conversations = [
            ConversationModel(
                id: localId,
                title: "Profile target",
                conversationId: "conv-1",
                inferenceProfile: "balanced"
            )
        ]
        mockProfileClient.setResponse = nil

        let success = await conversationManager.setConversationInferenceProfile(
            id: localId,
            profile: "quality-optimized"
        )

        XCTAssertFalse(success)
        XCTAssertEqual(
            mockProfileClient.setCalls,
            [MockConversationInferenceProfileClient.SetCall(conversationId: "conv-1", profile: "quality-optimized")]
        )
        // Local model rolls back to the previous value when the daemon rejects the change.
        XCTAssertEqual(conversationManager.conversations[0].inferenceProfile, "balanced")
    }

    func testSetConversationInferenceProfileNoOpsWhenAlreadyMatching() async {
        let localId = UUID()
        conversationManager.conversations = [
            ConversationModel(
                id: localId,
                title: "Profile target",
                conversationId: "conv-1",
                inferenceProfile: "balanced"
            )
        ]

        let success = await conversationManager.setConversationInferenceProfile(
            id: localId,
            profile: "balanced"
        )

        XCTAssertTrue(success)
        XCTAssertTrue(mockProfileClient.setCalls.isEmpty)
        XCTAssertEqual(conversationManager.conversations[0].inferenceProfile, "balanced")
    }

    func testSetConversationInferenceProfileRequiresConversationId() async {
        // A conversation that has not yet been backfilled with a daemon-side
        // conversationId can't be persisted server-side, so the call fails fast
        // and leaves the local model alone.
        let localId = UUID()
        conversationManager.conversations = [
            ConversationModel(
                id: localId,
                title: "No daemon id yet",
                conversationId: nil,
                inferenceProfile: nil
            )
        ]

        let success = await conversationManager.setConversationInferenceProfile(
            id: localId,
            profile: "balanced"
        )

        XCTAssertFalse(success)
        XCTAssertTrue(mockProfileClient.setCalls.isEmpty)
        XCTAssertNil(conversationManager.conversations[0].inferenceProfile)
    }

    // MARK: - Event-hub convergence

    func testConversationInferenceProfileUpdatedEventMergesIntoConversation() async throws {
        let localId = UUID()
        conversationManager.conversations = [
            ConversationModel(
                id: localId,
                title: "External update target",
                conversationId: "conv-2",
                inferenceProfile: nil
            )
        ]

        connectionManager.eventStreamClient.broadcastMessage(
            .conversationInferenceProfileUpdated(
                ConversationInferenceProfileUpdatedMessage(
                    conversationId: "conv-2",
                    profile: "quality-optimized"
                )
            )
        )

        try await waitForCondition {
            self.conversationManager.conversations.first?.inferenceProfile == "quality-optimized"
        }

        XCTAssertEqual(conversationManager.conversations[0].inferenceProfile, "quality-optimized")
    }

    func testConversationInferenceProfileUpdatedEventClearsLocalOverride() async throws {
        let localId = UUID()
        conversationManager.conversations = [
            ConversationModel(
                id: localId,
                title: "External clear target",
                conversationId: "conv-3",
                inferenceProfile: "balanced"
            )
        ]

        connectionManager.eventStreamClient.broadcastMessage(
            .conversationInferenceProfileUpdated(
                ConversationInferenceProfileUpdatedMessage(
                    conversationId: "conv-3",
                    profile: nil
                )
            )
        )

        try await waitForCondition {
            self.conversationManager.conversations.first?.inferenceProfile == nil
        }

        XCTAssertNil(conversationManager.conversations[0].inferenceProfile)
    }

    /// Polls `condition` on the MainActor until it returns true or the
    /// timeout elapses. ConversationManager wires its event-stream
    /// subscription in a `Task { ... for await ... }` during init; the
    /// loop only begins iterating after the runtime schedules that Task,
    /// so a `broadcastMessage` issued immediately after `init` needs a
    /// few main-queue turns before it lands. `XCTNSPredicateExpectation`
    /// is unreliable for this race in `@MainActor` test classes — polling
    /// drains the queue deterministically.
    private func waitForCondition(
        timeout: TimeInterval = 1.0,
        _ condition: () -> Bool,
        file: StaticString = #file,
        line: UInt = #line
    ) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return }
            try await Task.sleep(nanoseconds: 5_000_000)
        }
        XCTFail("waitForCondition timed out after \(timeout)s", file: file, line: line)
    }
}

private final class MockConversationInferenceProfileClient: ConversationInferenceProfileClientProtocol {
    struct SetCall: Equatable {
        let conversationId: String
        let profile: String?
    }

    var setResponse: ConversationInferenceProfileResponse?
    private(set) var setCalls: [SetCall] = []

    func setConversationInferenceProfile(
        conversationId: String,
        profile: String?
    ) async -> ConversationInferenceProfileResponse? {
        setCalls.append(SetCall(conversationId: conversationId, profile: profile))
        return setResponse
    }
}
