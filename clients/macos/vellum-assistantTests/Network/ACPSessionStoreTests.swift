import Foundation
import XCTest

@testable import VellumAssistantLib
@testable import VellumAssistantShared

private final class MockACPSessionStoreURLProtocol: URLProtocol {
    static var requestHandler: ((URLRequest) throws -> (HTTPURLResponse, Data))?

    override class func canInit(with request: URLRequest) -> Bool {
        true
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        guard let handler = Self.requestHandler else {
            XCTFail("requestHandler not set")
            return
        }

        do {
            let (response, data) = try handler(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}

@MainActor
final class ACPSessionStoreTests: XCTestCase {
    private let assistantId = "assistant-acp-store-test"
    private let gatewayPort = 7834
    private var originalPrimaryLockfileData: Data?
    private var primaryLockfileExisted = false

    override func setUpWithError() throws {
        try super.setUpWithError()
        MockACPSessionStoreURLProtocol.requestHandler = nil
        URLProtocol.registerClass(MockACPSessionStoreURLProtocol.self)

        let primaryLockfileURL = LockfilePaths.primary
        primaryLockfileExisted = FileManager.default.fileExists(atPath: primaryLockfileURL.path)
        if primaryLockfileExisted {
            originalPrimaryLockfileData = try Data(contentsOf: primaryLockfileURL)
        }

        try installLockfileFixture()
    }

    override func tearDownWithError() throws {
        URLProtocol.unregisterClass(MockACPSessionStoreURLProtocol.self)
        MockACPSessionStoreURLProtocol.requestHandler = nil

        if primaryLockfileExisted {
            try originalPrimaryLockfileData?.write(to: LockfilePaths.primary, options: .atomic)
        } else {
            try? FileManager.default.removeItem(at: LockfilePaths.primary)
        }

        try super.tearDownWithError()
    }

    // MARK: - Lifecycle: spawn → update → completed

    func test_spawnedUpdateCompleted_transitionsState() {
        let store = ACPSessionStore()

        store.handle(.acpSessionSpawned(ACPSessionSpawnedMessage(
            acpSessionId: "acp-1",
            agent: "claude-code",
            parentConversationId: "conv-1"
        )))

        XCTAssertEqual(store.sessions.count, 1)
        let viewModel = try! XCTUnwrap(store.sessions["acp-1"])
        XCTAssertEqual(viewModel.state.status, .running)
        XCTAssertEqual(viewModel.state.parentConversationId, "conv-1")
        XCTAssertEqual(store.sessionOrder, ["acp-1"])

        store.handle(.acpSessionUpdate(ACPSessionUpdateMessage(
            acpSessionId: "acp-1",
            updateType: .agentMessageChunk,
            content: "Hello"
        )))

        XCTAssertEqual(viewModel.events.count, 1)
        XCTAssertEqual(viewModel.events.first?.content, "Hello")

        store.handle(.acpSessionCompleted(ACPSessionCompletedMessage(
            acpSessionId: "acp-1",
            stopReason: .endTurn
        )))

        XCTAssertEqual(viewModel.state.status, .completed)
        XCTAssertEqual(viewModel.state.stopReason, .endTurn)
        XCTAssertNotNil(viewModel.state.completedAt)
    }

    func test_completed_withCancelledStopReason_setsCancelledStatus() {
        let store = ACPSessionStore()
        store.handle(.acpSessionSpawned(ACPSessionSpawnedMessage(
            acpSessionId: "acp-1",
            agent: "a",
            parentConversationId: "c"
        )))

        store.handle(.acpSessionCompleted(ACPSessionCompletedMessage(
            acpSessionId: "acp-1",
            stopReason: .cancelled
        )))

        let viewModel = try! XCTUnwrap(store.sessions["acp-1"])
        XCTAssertEqual(viewModel.state.status, .cancelled)
        XCTAssertEqual(viewModel.state.stopReason, .cancelled)
    }

    func test_error_setsFailedStatusAndErrorString() {
        let store = ACPSessionStore()
        store.handle(.acpSessionSpawned(ACPSessionSpawnedMessage(
            acpSessionId: "acp-1",
            agent: "a",
            parentConversationId: "c"
        )))

        store.handle(.acpSessionError(ACPSessionErrorMessage(
            acpSessionId: "acp-1",
            error: "agent crashed"
        )))

        let viewModel = try! XCTUnwrap(store.sessions["acp-1"])
        XCTAssertEqual(viewModel.state.status, .failed)
        XCTAssertEqual(viewModel.state.error, "agent crashed")
        XCTAssertNotNil(viewModel.state.completedAt)
    }

    // MARK: - Orphan buffering and stitching

    func test_updateBeforeSpawn_isBufferedAndAppliedOnSpawn() {
        let store = ACPSessionStore()

        // Update arrives first, before any spawn — buffered as orphan.
        store.handle(.acpSessionUpdate(ACPSessionUpdateMessage(
            acpSessionId: "acp-1",
            updateType: .agentMessageChunk,
            content: "early"
        )))

        XCTAssertTrue(store.sessions.isEmpty, "Update without parent should not create a session")

        // Spawn arrives — orphan is drained onto the new view model.
        store.handle(.acpSessionSpawned(ACPSessionSpawnedMessage(
            acpSessionId: "acp-1",
            agent: "a",
            parentConversationId: "c"
        )))

        let viewModel = try! XCTUnwrap(store.sessions["acp-1"])
        XCTAssertEqual(viewModel.events.count, 1)
        XCTAssertEqual(viewModel.events.first?.content, "early")
    }

    func test_updateBeforeSpawn_isStitchedOnSeed() async {
        let store = ACPSessionStore()

        store.handle(.acpSessionUpdate(ACPSessionUpdateMessage(
            acpSessionId: "acp-seeded",
            updateType: .agentMessageChunk,
            content: "early"
        )))

        // Seed returns a snapshot containing the orphan's parent session.
        MockACPSessionStoreURLProtocol.requestHandler = { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: nil
            )!
            let data = Data(
                #"""
                {
                  "sessions": [
                    {
                      "id": "sess-seeded",
                      "agentId": "claude-code",
                      "acpSessionId": "acp-seeded",
                      "parentConversationId": "conv-seeded",
                      "status": "running",
                      "startedAt": 1700000000000
                    }
                  ]
                }
                """#.utf8
            )
            return (response, data)
        }

        await store.seed()

        XCTAssertEqual(store.seedState, .loaded)
        let viewModel = try! XCTUnwrap(store.sessions["acp-seeded"])
        XCTAssertEqual(viewModel.events.count, 1)
        XCTAssertEqual(viewModel.events.first?.content, "early")
    }

    func test_orphanBuffer_capsAtPerSessionLimit() {
        let store = ACPSessionStore()
        let sessionId = "acp-cap"

        // Push 1.5x the cap so the oldest are forced out.
        let total = ACPSessionStore.orphanCapPerSession + 50
        for index in 0..<total {
            store.handle(.acpSessionUpdate(ACPSessionUpdateMessage(
                acpSessionId: sessionId,
                updateType: .agentMessageChunk,
                content: "msg-\(index)"
            )))
        }

        // Spawn drains the bounded buffer.
        store.handle(.acpSessionSpawned(ACPSessionSpawnedMessage(
            acpSessionId: sessionId,
            agent: "a",
            parentConversationId: "c"
        )))

        let viewModel = try! XCTUnwrap(store.sessions[sessionId])
        XCTAssertEqual(viewModel.events.count, ACPSessionStore.orphanCapPerSession)
        // Oldest entries should have been dropped — first kept event is index 50.
        XCTAssertEqual(viewModel.events.first?.content, "msg-50")
        XCTAssertEqual(viewModel.events.last?.content, "msg-\(total - 1)")
    }

    // MARK: - Seed merge / dedupe

    func test_seed_mergesSnapshotIntoSessions_inMemoryWinsOnCollision() async {
        let store = ACPSessionStore()

        // Existing in-memory session populated via SSE.
        store.handle(.acpSessionSpawned(ACPSessionSpawnedMessage(
            acpSessionId: "acp-existing",
            agent: "claude-code",
            parentConversationId: "conv-existing"
        )))
        let originalViewModel = try! XCTUnwrap(store.sessions["acp-existing"])

        MockACPSessionStoreURLProtocol.requestHandler = { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: nil
            )!
            // Snapshot includes both the existing in-memory session AND a
            // brand-new one. The existing entry should be left alone; the
            // new entry should be inserted.
            let data = Data(
                #"""
                {
                  "sessions": [
                    {
                      "id": "sess-a",
                      "agentId": "stale",
                      "acpSessionId": "acp-existing",
                      "status": "completed",
                      "startedAt": 1
                    },
                    {
                      "id": "sess-b",
                      "agentId": "agent-x",
                      "acpSessionId": "acp-new",
                      "status": "running",
                      "startedAt": 2000000000000
                    }
                  ]
                }
                """#.utf8
            )
            return (response, data)
        }

        await store.seed()

        XCTAssertEqual(store.seedState, .loaded)
        XCTAssertEqual(store.sessions.count, 2)
        // Existing view model should be the SAME instance — not replaced.
        XCTAssertTrue(store.sessions["acp-existing"] === originalViewModel,
                      "In-memory entry should win on id collision")
        XCTAssertEqual(originalViewModel.state.agentId, "claude-code",
                       "In-memory state should not be overwritten by stale snapshot")
        XCTAssertNotNil(store.sessions["acp-new"])
    }

    func test_seed_sortsSessionOrderByStartedAtDescending() async {
        let store = ACPSessionStore()
        MockACPSessionStoreURLProtocol.requestHandler = { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: nil
            )!
            let data = Data(
                #"""
                {
                  "sessions": [
                    {"id":"s1","agentId":"a","acpSessionId":"acp-old","status":"running","startedAt":100},
                    {"id":"s2","agentId":"a","acpSessionId":"acp-newest","status":"running","startedAt":300},
                    {"id":"s3","agentId":"a","acpSessionId":"acp-mid","status":"running","startedAt":200}
                  ]
                }
                """#.utf8
            )
            return (response, data)
        }

        await store.seed()

        XCTAssertEqual(store.sessionOrder, ["acp-newest", "acp-mid", "acp-old"])
    }

    func test_seed_recordsErrorOnTransportFailure() async {
        let store = ACPSessionStore()
        MockACPSessionStoreURLProtocol.requestHandler = { _ in
            throw NSError(domain: "test", code: -1, userInfo: nil)
        }

        await store.seed()

        guard case .error = store.seedState else {
            return XCTFail("Expected .error seedState, got \(store.seedState)")
        }
    }

    // MARK: - Events buffer cap

    func test_eventsBuffer_capsAt500_dropsOldest() {
        let store = ACPSessionStore()
        store.handle(.acpSessionSpawned(ACPSessionSpawnedMessage(
            acpSessionId: "acp-1",
            agent: "a",
            parentConversationId: "c"
        )))

        for index in 0..<600 {
            store.handle(.acpSessionUpdate(ACPSessionUpdateMessage(
                acpSessionId: "acp-1",
                updateType: .agentMessageChunk,
                content: "msg-\(index)"
            )))
        }

        let viewModel = try! XCTUnwrap(store.sessions["acp-1"])
        XCTAssertEqual(viewModel.events.count, ACPSessionStore.eventsCapPerSession)
        // Oldest 100 should have been dropped — first kept event is index 100.
        XCTAssertEqual(viewModel.events.first?.content, "msg-100")
        XCTAssertEqual(viewModel.events.last?.content, "msg-599")
    }

    // MARK: - Spawn dedupe

    func test_duplicateSpawn_doesNotReplaceExistingViewModel() {
        let store = ACPSessionStore()
        store.handle(.acpSessionSpawned(ACPSessionSpawnedMessage(
            acpSessionId: "acp-1",
            agent: "a",
            parentConversationId: "c"
        )))
        let original = try! XCTUnwrap(store.sessions["acp-1"])
        original.appendEvent(ACPSessionUpdateMessage(
            acpSessionId: "acp-1",
            updateType: .agentMessageChunk,
            content: "x"
        ))

        // A second spawn for the same id (e.g. resume after reconnect) must
        // not blow away the accumulated events.
        store.handle(.acpSessionSpawned(ACPSessionSpawnedMessage(
            acpSessionId: "acp-1",
            agent: "a",
            parentConversationId: "c"
        )))

        let after = try! XCTUnwrap(store.sessions["acp-1"])
        XCTAssertTrue(after === original, "Duplicate spawn should not replace the view model")
        XCTAssertEqual(after.events.count, 1)
    }

    // MARK: - Helpers

    private func installLockfileFixture() throws {
        let lockfile: [String: Any] = [
            "activeAssistant": assistantId,
            "assistants": [
                [
                    "assistantId": assistantId,
                    "cloud": "local",
                    "hatchedAt": "2026-03-19T12:00:00Z",
                    "resources": [
                        "gatewayPort": gatewayPort,
                    ],
                ],
            ],
        ]
        let data = try JSONSerialization.data(withJSONObject: lockfile, options: [.sortedKeys])
        try data.write(to: LockfilePaths.primary, options: .atomic)
    }
}
