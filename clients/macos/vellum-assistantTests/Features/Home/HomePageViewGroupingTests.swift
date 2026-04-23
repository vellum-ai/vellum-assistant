import SwiftUI
import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

/// Unit tests for ``HomePageView/groupedFeed(for:)``.
///
/// The grouping pipeline (sort → filter → bucket → group) is wired through
/// `HomePageView` but its behaviour is pure — no view lifecycle is
/// required. These tests instantiate the view with in-memory stores and
/// call the helper directly, so they stay hermetic and don't depend on the
/// SwiftUI rendering path.
@MainActor
final class HomePageViewGroupingTests: XCTestCase {

    // MARK: - Fixtures

    private func makeItem(
        id: String,
        type: FeedItemType = .digest,
        priority: Int,
        createdAt: Date = Date(timeIntervalSince1970: 1_760_000_000)
    ) -> FeedItem {
        FeedItem(
            id: id,
            type: type,
            priority: priority,
            title: "t-\(id)",
            summary: "s-\(id)",
            source: nil,
            timestamp: createdAt,
            status: .new,
            expiresAt: nil,
            minTimeAway: nil,
            actions: nil,
            urgency: nil,
            author: .assistant,
            createdAt: createdAt
        )
    }

    private func makeFeedStore(items: [FeedItem]) async -> HomeFeedStore {
        // `HomeFeedStore.items` has a private setter, so we hydrate it
        // through the store's public `load()` pipeline against a mock
        // client pre-seeded with the fixture items.
        let response = HomeFeedResponse(
            items: items,
            updatedAt: Date(timeIntervalSince1970: 1_760_000_100),
            contextBanner: ContextBanner(
                greeting: "Hello",
                timeAwayLabel: "",
                newCount: 0
            ),
            suggestedPrompts: [],
            lowPriorityCollapsed: LowPriorityCollapsed(count: 0, itemIds: [])
        )
        let client = MockHomeFeedClient(response: response)
        let (stream, _) = AsyncStream<ServerMessage>.makeStream()
        let store = HomeFeedStore(client: client, messageStream: stream)
        await store.load()
        return store
    }

    private func makeHomeStore() -> HomeStore {
        let client = MockHomeStateClient()
        let (stream, _) = AsyncStream<ServerMessage>.makeStream()
        return HomeStore(client: client, messageStream: stream)
    }

    private func makeMeetStatus() -> MeetStatusViewModel {
        let (stream, _) = AsyncStream<ServerMessage>.makeStream()
        return MeetStatusViewModel(messageStream: stream)
    }

    /// Constructs a fully-specialized `HomePageView` wired to the supplied
    /// feed store. All callbacks are no-ops and `detailPanel` resolves to
    /// `EmptyView` — the tests never exercise the view body, just the
    /// pure `groupedFeed(for:)` helper.
    private func makeView(feedStore: HomeFeedStore) -> HomePageView<EmptyView> {
        HomePageView<EmptyView>(
            store: makeHomeStore(),
            feedStore: feedStore,
            meetStatusViewModel: makeMeetStatus(),
            onFeedConversationOpened: { _ in },
            onStartNewChat: {},
            onDismissSuggestions: {},
            onSuggestionSelected: { _ in },
            isDetailPanelVisible: false,
            detailPanel: { EmptyView() }
        )
    }

    // MARK: - Tests

    func test_groupedFeed_collapsesLowPriorityDigests() async {
        // Five contiguous low-priority digests should collapse into a
        // single `.group` row with ≥ 3 children. The two normal items
        // (nudge/action) render as `.single` rows, regardless of bucket.
        let items: [FeedItem] = [
            makeItem(id: "nudge",  type: .nudge,  priority: 90),
            makeItem(id: "action", type: .action, priority: 80),
            makeItem(id: "d1",     type: .digest, priority: 20),
            makeItem(id: "d2",     type: .digest, priority: 15),
            makeItem(id: "d3",     type: .digest, priority: 10),
            makeItem(id: "d4",     type: .digest, priority: 7),
            makeItem(id: "d5",     type: .digest, priority: 5),
        ]
        let feedStore = await makeFeedStore(items: items)
        let view = makeView(feedStore: feedStore)

        let buckets = view.groupedFeed(for: nil)
        let allRows = buckets.flatMap { $0.rows }

        let groupRows = allRows.compactMap { row -> [FeedItem]? in
            if case .group(_, let children) = row { return children }
            return nil
        }

        XCTAssertFalse(groupRows.isEmpty, "Expected at least one .group row for the low-priority digest run")
        XCTAssertTrue(
            groupRows.contains(where: { $0.count >= 3 }),
            "Expected a .group row with ≥ 3 children (digest run had 5 items)"
        )
    }

    func test_groupedFeed_respectsTypeFilter() async {
        // Same fixture as the collapse test. With `filter = .digest` the
        // digest run is retained and still collapses into a group. With
        // `filter = .nudge` only the single nudge row survives — no
        // digest run means no `.group` emission.
        let items: [FeedItem] = [
            makeItem(id: "nudge",  type: .nudge,  priority: 90),
            makeItem(id: "action", type: .action, priority: 80),
            makeItem(id: "d1",     type: .digest, priority: 20),
            makeItem(id: "d2",     type: .digest, priority: 15),
            makeItem(id: "d3",     type: .digest, priority: 10),
            makeItem(id: "d4",     type: .digest, priority: 7),
            makeItem(id: "d5",     type: .digest, priority: 5),
        ]
        let feedStore = await makeFeedStore(items: items)
        let view = makeView(feedStore: feedStore)

        let digestOnly = view.groupedFeed(for: .digest).flatMap { $0.rows }
        XCTAssertTrue(
            digestOnly.contains(where: {
                if case .group = $0 { return true } else { return false }
            }),
            "Filtering to .digest should still produce a grouped row"
        )

        let nudgeOnly = view.groupedFeed(for: .nudge).flatMap { $0.rows }
        XCTAssertFalse(
            nudgeOnly.contains(where: {
                if case .group = $0 { return true } else { return false }
            }),
            "Filtering to .nudge should emit no grouped rows (digests are filtered out before grouping)"
        )
        XCTAssertEqual(nudgeOnly.count, 1, "Only the single nudge should survive the filter")
    }
}
