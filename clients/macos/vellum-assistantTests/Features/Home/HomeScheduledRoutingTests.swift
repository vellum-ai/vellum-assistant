import SwiftUI
import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

/// Routing tests for ``HomePageView.openItem(_:)`` — verify that tapping a
/// `.thread` (scheduled) feed item fires `onScheduledItemSelected` and
/// skips the triggerAction flow, while non-`.thread` types leave the
/// callback silent and fall through to the existing conversation flow.
///
/// ``openItem`` is exposed as `internal` (not `private`) specifically so
/// these tests can drive the routing branch without needing to render the
/// full SwiftUI view tree.
@MainActor
final class HomeScheduledRoutingTests: XCTestCase {

    // MARK: - Fixtures

    private func makeItem(
        id: String = "item-1",
        type: FeedItemType = .thread,
        title: String = "Fixture"
    ) -> FeedItem {
        let now = Date(timeIntervalSince1970: 1_760_000_000)
        return FeedItem(
            id: id,
            type: type,
            priority: 50,
            title: title,
            summary: "summary",
            source: nil,
            timestamp: now,
            status: .new,
            expiresAt: nil,
            minTimeAway: nil,
            actions: nil,
            urgency: nil,
            author: .assistant,
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
        onScheduledItemSelected: @escaping (FeedItem) -> Void,
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
            onScheduledItemSelected: onScheduledItemSelected
        )
    }

    // MARK: - Tests

    func test_openItem_threadType_firesScheduledCallback() async {
        let (homeStore, feedStore, feedClient) = makeStores()
        var captured: [FeedItem] = []
        var conversationOpens = 0
        let view = makeView(
            homeStore: homeStore,
            feedStore: feedStore,
            onScheduledItemSelected: { item in captured.append(item) },
            onFeedConversationOpened: { _ in conversationOpens += 1 }
        )

        let item = makeItem(id: "sched-1", type: .thread)
        view.openItem(item)

        XCTAssertEqual(captured.map { $0.id }, ["sched-1"],
                       "scheduled callback should fire exactly once with the tapped item")
        XCTAssertEqual(feedClient.triggerCallCount, 0,
                       "thread taps must not round-trip through triggerAction")
        XCTAssertEqual(conversationOpens, 0,
                       "thread taps must not attempt to open a conversation")
    }

    func test_openItem_nonThreadType_skipsScheduledCallback() async {
        // We only assert the callback SPY — we deliberately avoid asserting
        // anything about the async `feedStore.triggerAction` path here:
        // wiring up deterministic waits for the detached Task would
        // duplicate HomeFeedStoreTests coverage without adding signal for
        // this routing check. See note on the test class for rationale.
        let (homeStore, feedStore, _) = makeStores()
        for nonThreadType in [FeedItemType.nudge, .digest, .action] {
            var captured: [FeedItem] = []
            let view = makeView(
                homeStore: homeStore,
                feedStore: feedStore,
                onScheduledItemSelected: { item in captured.append(item) }
            )

            view.openItem(makeItem(id: "n-\(nonThreadType)", type: nonThreadType))

            XCTAssertTrue(captured.isEmpty,
                          "\(nonThreadType) taps must not fire the scheduled callback")
        }
    }
}
