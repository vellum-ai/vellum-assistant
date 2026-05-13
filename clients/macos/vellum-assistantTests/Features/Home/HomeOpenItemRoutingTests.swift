import SwiftUI
import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

/// Routing tests for ``HomePageView.openItem(_:)``.
///
/// In the v2 schema every feed item is a `.notification`, so
/// `openItem(_:)` unconditionally fires `onDetailPanelSelected` and the
/// receiver decides whether the item resolves to a typed detail panel
/// or a generic one via ``HomeDetailPanelKind/resolve(for:)``.
///
/// `openItem` is exposed as `internal` (not `private`) specifically so
/// these tests can drive the routing branch without needing to render the
/// full SwiftUI view tree.
@MainActor
final class HomeOpenItemRoutingTests: XCTestCase {

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
    /// The receiver decides which detail panel to render via
    /// ``HomeDetailPanelKind/resolve(for:)``.
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
