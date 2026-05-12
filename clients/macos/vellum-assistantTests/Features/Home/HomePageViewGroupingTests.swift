import SwiftUI
import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

/// Unit tests for ``HomePageView/groupedFeed``.
///
/// The grouping pipeline (sort → filter-dismissed → bucket → group) is
/// wired through `HomePageView` but its behaviour is pure — no view
/// lifecycle is required. These tests instantiate the view with in-memory
/// stores and read the helper directly, so they stay hermetic and don't
/// depend on the SwiftUI rendering path.
@MainActor
final class HomePageViewGroupingTests: XCTestCase {

    // MARK: - Fixtures

    private func makeItem(
        id: String,
        type: FeedItemType = .notification,
        priority: Int,
        createdAt: Date = Date(timeIntervalSince1970: 1_760_000_000)
    ) -> FeedItem {
        FeedItem(
            id: id,
            type: type,
            priority: priority,
            title: "t-\(id)",
            summary: "s-\(id)",
            timestamp: createdAt,
            status: .new,
            expiresAt: nil,
            actions: nil,
            urgency: nil,
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
            suggestedPrompts: []
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
    /// pure `groupedFeed` helper.
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

    func test_groupedFeed_collapsesLowPriorityRun() async {
        // Five contiguous low-priority items should collapse into a
        // single `.group` row with ≥ 3 children. The two high-priority
        // items render as `.single` rows, regardless of bucket.
        //
        // Pre-v2 the eligibility check also required `type == .digest`;
        // the schema collapsed types to a single `.notification` case so
        // low-priority is now the sole grouping signal.
        let items: [FeedItem] = [
            makeItem(id: "high1", priority: 90),
            makeItem(id: "high2", priority: 80),
            makeItem(id: "low1",  priority: 20),
            makeItem(id: "low2",  priority: 15),
            makeItem(id: "low3",  priority: 10),
            makeItem(id: "low4",  priority: 7),
            makeItem(id: "low5",  priority: 5),
        ]
        let feedStore = await makeFeedStore(items: items)
        let view = makeView(feedStore: feedStore)

        let buckets = view.groupedFeed
        let allRows = buckets.flatMap { $0.rows }

        let groupRows = allRows.compactMap { row -> [FeedItem]? in
            if case .group(_, let children) = row { return children }
            return nil
        }

        XCTAssertFalse(groupRows.isEmpty, "Expected at least one .group row for the low-priority run")
        XCTAssertTrue(
            groupRows.contains(where: { $0.count >= 3 }),
            "Expected a .group row with ≥ 3 children (low-priority run had 5 items)"
        )
    }
}
