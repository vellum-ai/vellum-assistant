import SwiftUI
import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

/// Routing tests for ``HomePageView.openItem(_:)``.
///
/// **Pre-v2 these tests asserted that taps on `.thread + .calendar` /
/// `.nudge` items fired `onDetailPanelSelected` while taps on
/// `.digest` / `.action` / non-calendar `.thread` items fell through.**
/// The v2 schema collapsed `FeedItemType` to a single `.notification`
/// case and removed `FeedItemSource` / `FeedItemAuthor` entirely, so
/// the type-and-source dispatch those tests covered no longer exists —
/// `HomePageView.openItem(_:)` now unconditionally fires
/// `onDetailPanelSelected`. PR 17 will reshape this dispatch around the
/// server-supplied `detailPanel` descriptor; until then the only routing
/// signal worth asserting is "every tap fires the callback exactly once".
///
/// `openItem` is exposed as `internal` (not `private`) specifically so
/// these tests can drive the routing branch without needing to render the
/// full SwiftUI view tree.
@MainActor
final class HomeScheduledRoutingTests: XCTestCase {

    // MARK: - Fixtures

    private func makeItem(
        id: String = "item-1",
        title: String = "Fixture",
        detailPanel: FeedItemDetailPanel? = nil
    ) -> FeedItem {
        let now = Date(timeIntervalSince1970: 1_760_000_000)
        return FeedItem(
            id: id,
            type: .notification,
            priority: 50,
            title: title,
            summary: "summary",
            timestamp: now,
            status: .new,
            expiresAt: nil,
            actions: nil,
            urgency: nil,
            detailPanel: detailPanel,
            createdAt: now
        )
    }

    private func makeStores() -> (HomeStore, HomeFeedStore, MockHomeFeedClient) {
        let (feedStream, _) = AsyncStream<ServerMessage>.makeStream()
        let (stateStream, _) = AsyncStream<ServerMessage>.makeStream()
        let feedClient = MockHomeFeedClient(response: nil)
        let feedStore = HomeFeedStore(client: feedClient, messageStream: feedStream)
        let stateClient = MockHomeStateClient()
        let homeStore = HomeStore(client: stateClient, messageStream: stateStream)
        return (homeStore, feedStore, feedClient)
    }

    private func makeView(
        homeStore: HomeStore,
        feedStore: HomeFeedStore,
        onDetailPanelSelected: @escaping (FeedItem) -> Void = { _ in },
        onFeedConversationOpened: @escaping (String) -> Void = { _ in }
    ) -> HomePageView<EmptyView> {
        let (meetStream, _) = AsyncStream<ServerMessage>.makeStream()
        let meetVM = MeetStatusViewModel(
            messageStream: meetStream,
            clock: { Date(timeIntervalSince1970: 1_760_000_000) }
        )
        return HomePageView(
            store: homeStore,
            feedStore: feedStore,
            meetStatusViewModel: meetVM,
            onFeedConversationOpened: onFeedConversationOpened,
            onStartNewChat: {},
            onDismissSuggestions: {},
            onSuggestionSelected: { _ in },
            onDetailPanelSelected: onDetailPanelSelected
        )
    }

    // MARK: - Tests

    /// Smoke test: every tap fires the detail panel callback exactly
    /// once, regardless of whether a `detailPanel` descriptor is set.
    /// Replaces the old per-type dispatch matrix — PR 17 will reintroduce
    /// finer-grained routing once the server-driven panel descriptor
    /// stabilizes.
    func test_openItem_firesDetailPanelCallback() async {
        let (homeStore, feedStore, feedClient) = makeStores()
        var captured: [FeedItem] = []
        var conversationOpens = 0
        let view = makeView(
            homeStore: homeStore,
            feedStore: feedStore,
            onDetailPanelSelected: { item in captured.append(item) },
            onFeedConversationOpened: { _ in conversationOpens += 1 }
        )

        view.openItem(makeItem(id: "notif-1"))

        XCTAssertEqual(captured.map { $0.id }, ["notif-1"],
                       "every tap should fire the detail panel callback exactly once")
        XCTAssertEqual(feedClient.triggerCallCount, 0,
                       "openItem must not round-trip through triggerAction in v2")
        XCTAssertEqual(conversationOpens, 0,
                       "openItem must not attempt to open a conversation in v2")
    }
}
