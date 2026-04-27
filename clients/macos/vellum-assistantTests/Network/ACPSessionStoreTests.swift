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

        // The wire's `acpSessionId` field carries the daemon UUID on
        // every ACP event — same value the daemon puts in
        // `ACPSessionState.id`. The seed snapshot below has a divergent
        // protocol-level `acpSessionId`, so the orphan must key off the
        // daemon UUID to match.
        store.handle(.acpSessionUpdate(ACPSessionUpdateMessage(
            acpSessionId: "sess-seeded",
            updateType: .agentMessageChunk,
            content: "early"
        )))

        // Seed returns a snapshot containing the orphan's parent session.
        // `id` is the daemon UUID; `acpSessionId` is the protocol-level
        // handle filled in once the agent's `createSession` resolved.
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
                      "acpSessionId": "acp-protocol-seeded",
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
        // Store is keyed by `state.id` (the daemon UUID) so the seeded
        // entry lands under "sess-seeded" — even though the protocol id
        // is different — and the buffered orphan flushes onto it.
        let viewModel = try! XCTUnwrap(store.sessions["sess-seeded"])
        XCTAssertEqual(viewModel.state.acpSessionId, "acp-protocol-seeded",
                       "Seed should preserve the protocol-level id, distinct from the store key")
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

        // Existing in-memory session populated via SSE. The wire's
        // `acpSessionId` field IS the daemon UUID — same value the seed
        // snapshot below carries as `id`, so the two collide on
        // `state.id` (the store's key) and the in-memory entry wins.
        store.handle(.acpSessionSpawned(ACPSessionSpawnedMessage(
            acpSessionId: "sess-existing",
            agent: "claude-code",
            parentConversationId: "conv-existing"
        )))
        let originalViewModel = try! XCTUnwrap(store.sessions["sess-existing"])

        MockACPSessionStoreURLProtocol.requestHandler = { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: nil
            )!
            // Snapshot includes both the existing in-memory session AND a
            // brand-new one. The existing entry should be left alone; the
            // new entry should be inserted. The two `id` values match the
            // daemon UUIDs the SSE pipeline already saw / will see.
            let data = Data(
                #"""
                {
                  "sessions": [
                    {
                      "id": "sess-existing",
                      "agentId": "stale",
                      "acpSessionId": "acp-protocol-existing",
                      "status": "completed",
                      "startedAt": 1
                    },
                    {
                      "id": "sess-new",
                      "agentId": "agent-x",
                      "acpSessionId": "acp-protocol-new",
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
        XCTAssertTrue(store.sessions["sess-existing"] === originalViewModel,
                      "In-memory entry should win on id collision (keyed by state.id)")
        XCTAssertEqual(originalViewModel.state.agentId, "claude-code",
                       "In-memory state should not be overwritten by stale snapshot")
        XCTAssertNotNil(store.sessions["sess-new"])
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
                    {"id":"sess-old","agentId":"a","acpSessionId":"acp-old","status":"running","startedAt":100},
                    {"id":"sess-newest","agentId":"a","acpSessionId":"acp-newest","status":"running","startedAt":300},
                    {"id":"sess-mid","agentId":"a","acpSessionId":"acp-mid","status":"running","startedAt":200}
                  ]
                }
                """#.utf8
            )
            return (response, data)
        }

        await store.seed()

        // `sessionOrder` is keyed by `state.id` (the daemon UUID) — same
        // identifier the store's `sessions` dictionary uses.
        XCTAssertEqual(store.sessionOrder, ["sess-newest", "sess-mid", "sess-old"])
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

    // MARK: - SSE → seed dedupe across diverged ids

    /// `state.id` (daemon UUID) and `state.acpSessionId` (protocol-level
    /// handle) diverge for any session that has progressed past
    /// initialization. The wire's `acpSessionId` field always carries the
    /// daemon UUID, so an SSE-spawned entry and the same session arriving
    /// later via `seed()` must collapse onto a single store entry — not
    /// stack up as two separate rows keyed by the two different
    /// identifiers.
    func test_sseSpawnThenSeed_doesNotDuplicateSession() async {
        let store = ACPSessionStore()

        // SSE spawn with the daemon UUID (the value the wire actually
        // sends — see `assistant/src/acp/session-manager.ts` line 215
        // where `acpSessionId` is set to the manager's randomUUID()).
        store.handle(.acpSessionSpawned(ACPSessionSpawnedMessage(
            acpSessionId: "sess-uuid",
            agent: "claude-code",
            parentConversationId: "conv-1"
        )))

        let spawned = try! XCTUnwrap(store.sessions["sess-uuid"])
        XCTAssertEqual(store.sessions.count, 1)

        // Now seed returns the same session — `id` matches the daemon
        // UUID we already saw, but `acpSessionId` is the (different)
        // protocol-level handle that has since been resolved.
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
                      "id": "sess-uuid",
                      "agentId": "claude-code",
                      "acpSessionId": "acp-protocol-handle",
                      "parentConversationId": "conv-1",
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

        XCTAssertEqual(store.sessions.count, 1,
                       "SSE-spawned + seeded entry for the same daemon UUID must collapse")
        XCTAssertTrue(store.sessions["sess-uuid"] === spawned,
                      "In-memory SSE-spawned view model wins on collision (no replacement)")
        XCTAssertEqual(store.sessionOrder, ["sess-uuid"])
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

    // MARK: - Delete

    func test_delete_removesSessionAndOrderEntry_onSuccess() async {
        let store = ACPSessionStore()
        store.handle(.acpSessionSpawned(ACPSessionSpawnedMessage(
            acpSessionId: "acp-1",
            agent: "a",
            parentConversationId: "c"
        )))
        store.handle(.acpSessionSpawned(ACPSessionSpawnedMessage(
            acpSessionId: "acp-2",
            agent: "a",
            parentConversationId: "c"
        )))
        XCTAssertEqual(store.sessions.count, 2)
        XCTAssertEqual(Set(store.sessionOrder), Set(["acp-1", "acp-2"]))

        MockACPSessionStoreURLProtocol.requestHandler = { request in
            XCTAssertEqual(request.httpMethod, "DELETE")
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: nil
            )!
            return (response, Data(#"{"deleted":true}"#.utf8))
        }

        let result = await store.delete(id: "acp-1")

        guard case .success(true) = result else {
            return XCTFail("Expected .success(true), got \(result)")
        }
        XCTAssertNil(store.sessions["acp-1"], "Deleted session should be removed from sessions")
        XCTAssertNotNil(store.sessions["acp-2"], "Other sessions should be left alone")
        XCTAssertFalse(store.sessionOrder.contains("acp-1"), "sessionOrder should not include deleted id")
        XCTAssertTrue(store.sessionOrder.contains("acp-2"))
    }

    /// Sessions loaded via `seed()` carry diverged `state.id` /
    /// `state.acpSessionId` values. A delete keyed by the daemon UUID
    /// (`state.id`) must hit the matching row in the store — historically
    /// the store keyed by `state.acpSessionId` and the optimistic removal
    /// silently no-op'd because the URL `:id` parameter the daemon
    /// expects is the `state.id` value. This test pins the contract.
    func test_delete_seedLoadedSession_dropsRowKeyedByDaemonUUID() async {
        let store = ACPSessionStore()

        // Seed with a session whose protocol-level handle differs from
        // its daemon UUID — the realistic shape for any session past
        // initialization.
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
                      "id": "sess-target",
                      "agentId": "claude-code",
                      "acpSessionId": "acp-protocol-target",
                      "parentConversationId": "conv-1",
                      "status": "completed",
                      "startedAt": 1700000000000,
                      "completedAt": 1700000010000
                    }
                  ]
                }
                """#.utf8
            )
            return (response, data)
        }
        await store.seed()
        XCTAssertNotNil(store.sessions["sess-target"])

        // Now arrange the DELETE response and exercise the helper.
        MockACPSessionStoreURLProtocol.requestHandler = { request in
            // The URL must carry the daemon UUID, not the protocol id.
            XCTAssertTrue(
                request.url?.path.hasSuffix("/sess-target") ?? false,
                "Delete URL must carry the daemon UUID (state.id)"
            )
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: nil
            )!
            return (response, Data(#"{"deleted":true}"#.utf8))
        }

        let result = await store.delete(id: "sess-target")
        guard case .success(true) = result else {
            return XCTFail("Expected .success(true), got \(result)")
        }
        XCTAssertNil(store.sessions["sess-target"],
                     "Delete keyed by daemon UUID must drop the seed-loaded row")
        XCTAssertFalse(store.sessionOrder.contains("sess-target"))
    }

    func test_delete_leavesStoreUntouched_onFailure() async {
        let store = ACPSessionStore()
        store.handle(.acpSessionSpawned(ACPSessionSpawnedMessage(
            acpSessionId: "acp-active",
            agent: "a",
            parentConversationId: "c"
        )))
        XCTAssertNotNil(store.sessions["acp-active"])

        // Daemon returns 409 when the session is still active — store must
        // not optimistically drop the row.
        MockACPSessionStoreURLProtocol.requestHandler = { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 409,
                httpVersion: nil,
                headerFields: nil
            )!
            return (response, Data())
        }

        let result = await store.delete(id: "acp-active")

        guard case .failure = result else {
            return XCTFail("Expected .failure, got \(result)")
        }
        XCTAssertNotNil(store.sessions["acp-active"], "Failed delete should leave the row in place")
        XCTAssertTrue(store.sessionOrder.contains("acp-active"))
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
        let primaryLockfileURL = LockfilePaths.primary
        try FileManager.default.createDirectory(
            at: primaryLockfileURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try data.write(to: primaryLockfileURL, options: .atomic)
    }
}
