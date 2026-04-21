import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

/// Unit tests for ``HomeFeedStore`` — exercised with ``MockHomeFeedClient``
/// and a scripted `AsyncStream<ServerMessage>` so the tests stay hermetic
/// (no network, no gateway, no daemon).
@MainActor
final class HomeFeedStoreTests: XCTestCase {

    // MARK: - Fixtures

    private func makeFeedItem(
        id: String = "item-1",
        type: FeedItemType = .nudge,
        status: FeedItemStatus = .new,
        title: String = "Fixture title",
        priority: Int = 60,
        source: FeedItemSource? = .gmail,
        author: FeedItemAuthor = .assistant,
        timestamp: Date = Date(timeIntervalSince1970: 1_760_000_000),
        createdAt: Date = Date(timeIntervalSince1970: 1_760_000_000)
    ) -> FeedItem {
        FeedItem(
            id: id,
            type: type,
            priority: priority,
            title: title,
            summary: "Fixture summary",
            source: source,
            timestamp: timestamp,
            status: status,
            expiresAt: nil,
            minTimeAway: nil,
            actions: nil,
            author: author,
            createdAt: createdAt
        )
    }

    private func makeBanner(newCount: Int = 1) -> ContextBanner {
        ContextBanner(
            greeting: "Good afternoon, Alex",
            timeAwayLabel: "Away for 2 hours",
            newCount: newCount
        )
    }

    private func makeResponse(
        items: [FeedItem],
        banner: ContextBanner? = nil,
        suggestedPrompts: [SuggestedPrompt] = []
    ) -> HomeFeedResponse {
        HomeFeedResponse(
            items: items,
            updatedAt: Date(timeIntervalSince1970: 1_760_000_100),
            contextBanner: banner ?? ContextBanner(
                greeting: "Good afternoon, Alex",
                timeAwayLabel: "Away for 2 hours",
                newCount: items.filter { $0.status == .new }.count
            ),
            suggestedPrompts: suggestedPrompts,
            lowPriorityCollapsed: LowPriorityCollapsed(count: 0, itemIds: [])
        )
    }

    private func makeSuggestedPrompt(
        id: String = "sp-1",
        label: String = "Try this",
        icon: String? = "lucide-sparkles",
        prompt: String = "Help me with this",
        source: SuggestedPromptSource = .assistant
    ) -> SuggestedPrompt {
        SuggestedPrompt(id: id, label: label, icon: icon, prompt: prompt, source: source)
    }

    private func makeStore(
        client: HomeFeedClient
    ) -> (HomeFeedStore, AsyncStream<ServerMessage>.Continuation) {
        let (stream, continuation) = AsyncStream<ServerMessage>.makeStream()
        let store = HomeFeedStore(client: client, messageStream: stream)
        return (store, continuation)
    }

    // MARK: - Tests

    func testLoadPopulatesItemsOnSuccess() async {
        let expected = makeResponse(items: [
            makeFeedItem(id: "a", status: .new, title: "First"),
            makeFeedItem(id: "b", status: .seen, title: "Second"),
        ])
        let client = MockHomeFeedClient(response: expected)
        let (store, _) = makeStore(client: client)

        XCTAssertTrue(store.items.isEmpty, "items should start empty")
        XCTAssertNil(store.contextBanner)

        await store.load()

        XCTAssertEqual(store.items.map { $0.id }, ["a", "b"])
        XCTAssertEqual(store.contextBanner?.newCount, 1)
        XCTAssertEqual(store.newItemCount, 1)
        XCTAssertFalse(store.isLoading)
        XCTAssertNotNil(store.lastLoadedAt)
        XCTAssertEqual(client.fetchCallCount, 1)
    }

    func testLoadLeavesItemsUnchangedOnFailure() async {
        let seeded = makeResponse(items: [makeFeedItem(id: "seed")])
        let client = MockHomeFeedClient(response: seeded)
        let (store, _) = makeStore(client: client)

        await store.load()
        XCTAssertEqual(store.items.map { $0.id }, ["seed"])

        client.setFetchError(HomeFeedClientError.httpError(statusCode: 500))
        await store.load()

        XCTAssertEqual(store.items.map { $0.id }, ["seed"],
                       "items must not be blanked on transport failure")
        XCTAssertFalse(store.isLoading)
    }

    func testLoadPopulatesSuggestedPromptsOnSuccess() async {
        let prompts = [
            makeSuggestedPrompt(id: "sp-1", label: "Baby names", prompt: "Suggest baby names for a boy"),
            makeSuggestedPrompt(id: "sp-2", label: "Spring cleaning", prompt: "Help me plan spring cleaning", source: .deterministic),
        ]
        let response = makeResponse(
            items: [makeFeedItem(id: "a")],
            suggestedPrompts: prompts
        )
        let client = MockHomeFeedClient(response: response)
        let (store, _) = makeStore(client: client)

        XCTAssertTrue(store.suggestedPrompts.isEmpty, "suggestedPrompts should start empty")

        await store.load()

        XCTAssertEqual(store.suggestedPrompts.map { $0.id }, ["sp-1", "sp-2"])
        XCTAssertEqual(store.suggestedPrompts.first?.prompt, "Suggest baby names for a boy")
        XCTAssertEqual(store.suggestedPrompts.last?.source, .deterministic)
    }

    func testLoadLeavesSuggestedPromptsUnchangedOnFailure() async {
        let seeded = makeResponse(
            items: [makeFeedItem(id: "seed")],
            suggestedPrompts: [makeSuggestedPrompt(id: "kept")]
        )
        let client = MockHomeFeedClient(response: seeded)
        let (store, _) = makeStore(client: client)

        await store.load()
        XCTAssertEqual(store.suggestedPrompts.map { $0.id }, ["kept"])

        client.setFetchError(HomeFeedClientError.httpError(statusCode: 500))
        await store.load()

        XCTAssertEqual(store.suggestedPrompts.map { $0.id }, ["kept"],
                       "suggestedPrompts must not be blanked on transport failure")
    }

    func testOutOfOrderResponsesPreserveLatest() async {
        // First `load()` sleeps inside `fetchFeed`, so the second `load()`
        // can issue, return synchronously with the newer response, and then
        // the first `load()` unblocks with the stale response. The generation
        // token must cause the stale first result to be discarded.
        let stale = makeResponse(items: [makeFeedItem(id: "stale")])
        let fresh = makeResponse(items: [makeFeedItem(id: "fresh")])
        let client = MockHomeFeedClient(response: stale)
        let (store, _) = makeStore(client: client)

        // 200 ms delay on the next fetch (the upcoming first `load()`).
        client.setNextFetchDelay(nanoseconds: 200_000_000)

        async let first: Void = store.load()

        // Ensure the first fetch has entered its delay before we mutate
        // the mock and issue the second call.
        try? await Task.sleep(nanoseconds: 30_000_000) // 30 ms
        client.setResponse(fresh)
        await store.load()

        XCTAssertEqual(store.items.map { $0.id }, ["fresh"],
                       "newer load() result should be applied before awaiting the first")

        // Now let the first (stale) call unblock and finish. Its result
        // should be dropped by the generation check.
        await first

        XCTAssertEqual(store.items.map { $0.id }, ["fresh"],
                       "stale first-load response must not overwrite fresh state")
        XCTAssertEqual(client.fetchCallCount, 2)
    }

    func testUpdateStatusOptimisticallyAppliesThenConfirms() async {
        let original = makeFeedItem(id: "x", status: .new)
        let client = MockHomeFeedClient(response: makeResponse(items: [original]))
        let (store, _) = makeStore(client: client)
        await store.load()
        XCTAssertEqual(store.items.first?.status, .new)

        let serverConfirmed = makeFeedItem(id: "x", status: .seen, title: "Server-canonical")
        client.setPatchedItem(id: "x", item: serverConfirmed)

        await store.updateStatus(itemId: "x", status: .seen)

        XCTAssertEqual(store.items.first?.status, .seen)
        // Reconciled against the server's canonical copy — the title
        // reflects the server-side value, not the local cache.
        XCTAssertEqual(store.items.first?.title, "Server-canonical")
        XCTAssertEqual(client.patchCallCount, 1)
    }

    func testUpdateStatusRollsBackOnFailure() async {
        let original = makeFeedItem(id: "x", status: .new, title: "Pre-patch")
        let client = MockHomeFeedClient(response: makeResponse(items: [original]))
        let (store, _) = makeStore(client: client)
        await store.load()

        client.setPatchError(HomeFeedClientError.httpError(statusCode: 500))

        await store.updateStatus(itemId: "x", status: .seen)

        XCTAssertEqual(store.items.first?.status, .new,
                       "rollback should restore the original status on server error")
        XCTAssertEqual(store.items.first?.title, "Pre-patch")
        XCTAssertEqual(client.patchCallCount, 1)
    }

    func testUpdateStatusRollbackSkippedIfLoadLandedFirst() async {
        // Seed the store, then race `updateStatus` (delayed PATCH that
        // will fail) against a concurrent `load()` that lands a fresh
        // server snapshot. The rollback path must NOT overwrite the
        // fresh load's view of the item with the stale pre-patch copy.
        let original = makeFeedItem(id: "x", status: .new, title: "Pre-patch")
        let client = MockHomeFeedClient(response: makeResponse(items: [original]))
        let (store, _) = makeStore(client: client)
        await store.load()
        XCTAssertEqual(store.items.first?.title, "Pre-patch")

        client.setPatchError(HomeFeedClientError.httpError(statusCode: 500))
        client.setNextPatchDelay(nanoseconds: 200_000_000) // 200 ms

        async let patching: Void = store.updateStatus(itemId: "x", status: .seen)

        // Let the patch enter its delay, then swap the fetch response
        // and run a concurrent `load()` that finishes before the patch
        // unblocks. The load's fresh snapshot becomes the source of truth.
        try? await Task.sleep(nanoseconds: 30_000_000) // 30 ms
        let fresh = makeFeedItem(
            id: "x",
            status: .seen,
            title: "Server-fresh",
            timestamp: Date(timeIntervalSince1970: 1_760_000_500),
            createdAt: Date(timeIntervalSince1970: 1_760_000_500)
        )
        client.setResponse(makeResponse(items: [fresh]))
        await store.load()
        XCTAssertEqual(store.items.first?.title, "Server-fresh")

        // Now unblock the delayed patch — it will error, and the
        // rollback guard must skip the restore because loadGeneration
        // has advanced past the entry value.
        await patching

        XCTAssertEqual(store.items.first?.title, "Server-fresh",
                       "rollback must not stomp the fresh load() snapshot")
        XCTAssertEqual(store.items.first?.status, .seen)
    }

    func testMarkAllSeenAppliesLocallyAndPatchesEachItem() async {
        let items = [
            makeFeedItem(id: "a", status: .new, title: "First"),
            makeFeedItem(id: "b", status: .new, title: "Second"),
            makeFeedItem(id: "c", status: .seen, title: "Already seen"),
        ]
        let client = MockHomeFeedClient(response: makeResponse(items: items))
        let (store, _) = makeStore(client: client)
        await store.load()

        // Server will echo each patched item; we don't actually need
        // the mock to return a real replacement because markAllSeen
        // is fire-and-forget — but supply one anyway so errors aren't
        // spurious.
        for item in items where item.status == .new {
            client.setPatchedItem(
                id: item.id,
                item: makeFeedItem(id: item.id, status: .seen, title: item.title)
            )
        }

        await store.markAllSeen()

        XCTAssertEqual(store.items.map { $0.status }, [.seen, .seen, .seen])
        XCTAssertEqual(client.patchCallCount, 2,
                       "only the two originally-new items should have been PATCHed")
    }

    func testSSEEventTriggersReload() async throws {
        let initial = makeResponse(items: [makeFeedItem(id: "first")])
        let client = MockHomeFeedClient(response: initial)
        let (store, continuation) = makeStore(client: client)

        await store.load()
        XCTAssertEqual(store.items.map { $0.id }, ["first"])
        let baselineFetches = client.fetchCallCount

        let updated = makeResponse(items: [makeFeedItem(id: "second")])
        client.setResponse(updated)
        continuation.yield(.homeFeedUpdated(updatedAt: "2026-04-14T12:00:00Z", newItemCount: 1))

        try await waitUntil(timeout: 2.0) {
            client.fetchCallCount > baselineFetches && store.items.map { $0.id } == ["second"]
        }

        XCTAssertEqual(store.items.map { $0.id }, ["second"])
        XCTAssertGreaterThan(client.fetchCallCount, baselineFetches)
    }

    func testTriggerActionReturnsConversationId() async {
        let client = MockHomeFeedClient(response: makeResponse(items: [makeFeedItem()]))
        client.setTriggeredConversationId("conv-42")
        let (store, _) = makeStore(client: client)

        let conversationId = await store.triggerAction(itemId: "item-1", actionId: "reply")

        XCTAssertEqual(conversationId, "conv-42")
        XCTAssertEqual(client.triggerCallCount, 1)
    }

    func testTriggerActionReturnsNilOnFailure() async {
        let client = MockHomeFeedClient(response: makeResponse(items: [makeFeedItem()]))
        client.setTriggerError(HomeFeedClientError.httpError(statusCode: 500))
        let (store, _) = makeStore(client: client)

        let conversationId = await store.triggerAction(itemId: "item-1", actionId: "reply")

        XCTAssertNil(conversationId)
    }

    // MARK: - Helpers

    private func waitUntil(
        timeout: TimeInterval,
        condition: @MainActor () -> Bool
    ) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        XCTFail("waitUntil timed out after \(timeout)s")
    }
}
