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
        source: FeedItemSource? = nil,
        title: String = "Fixture"
    ) -> FeedItem {
        let now = Date(timeIntervalSince1970: 1_760_000_000)
        return FeedItem(
            id: id,
            type: type,
            priority: 50,
            title: title,
            summary: "summary",
            source: source,
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
        onScheduledItemSelected: @escaping (FeedItem) -> Void = { _ in },
        onNudgeSelected: @escaping (FeedItem) -> Void = { _ in },
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
            onScheduledItemSelected: onScheduledItemSelected,
            onNudgeSelected: onNudgeSelected
        )
    }

    // MARK: - Tests

    func test_openItem_calendarSourcedThread_firesScheduledCallback() async {
        let (homeStore, feedStore, feedClient) = makeStores()
        var captured: [FeedItem] = []
        var conversationOpens = 0
        let view = makeView(
            homeStore: homeStore,
            feedStore: feedStore,
            onScheduledItemSelected: { item in captured.append(item) },
            onFeedConversationOpened: { _ in conversationOpens += 1 }
        )

        let item = makeItem(id: "sched-1", type: .thread, source: .calendar)
        view.openItem(item)

        XCTAssertEqual(captured.map { $0.id }, ["sched-1"],
                       "calendar-sourced thread should fire the scheduled callback exactly once")
        XCTAssertEqual(feedClient.triggerCallCount, 0,
                       "calendar-sourced thread must not round-trip through triggerAction")
        XCTAssertEqual(conversationOpens, 0,
                       "calendar-sourced thread must not attempt to open a conversation")
    }

    /// Gates the scheduled flow on `source == .calendar` (Codex P1 on
    /// PR #27475): `.thread` is also used by rollup-producer for general
    /// multi-action threads that must keep the conversation-open flow.
    func test_openItem_nonCalendarThread_skipsScheduledCallback() async {
        // As with the non-thread test below we only assert the spy — we
        // don't wait on the detached triggerAction Task. HomeFeedStoreTests
        // covers that path.
        let (homeStore, feedStore, _) = makeStores()

        for source in [nil, .gmail, .slack, .assistant] as [FeedItemSource?] {
            var captured: [FeedItem] = []
            let view = makeView(
                homeStore: homeStore,
                feedStore: feedStore,
                onScheduledItemSelected: { item in captured.append(item) }
            )

            let label = source.map { "\($0)" } ?? "nil"
            view.openItem(makeItem(id: "rollup-\(label)", type: .thread, source: source))

            XCTAssertTrue(captured.isEmpty,
                          "\(label)-sourced thread must not fire the scheduled callback")
        }
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

            // Use calendar source here to prove that type-gating runs
            // independently of the source gate — even a calendar-sourced
            // non-thread must not route through the scheduled callback.
            view.openItem(makeItem(id: "n-\(nonThreadType)", type: nonThreadType, source: .calendar))

            XCTAssertTrue(captured.isEmpty,
                          "\(nonThreadType) taps must not fire the scheduled callback")
        }
    }

    // MARK: - Nudge routing

    func test_openItem_nudgeType_firesNudgeCallback() async {
        let (homeStore, feedStore, feedClient) = makeStores()
        var capturedNudges: [FeedItem] = []
        var capturedScheduled: [FeedItem] = []
        var conversationOpens = 0
        let view = makeView(
            homeStore: homeStore,
            feedStore: feedStore,
            onScheduledItemSelected: { capturedScheduled.append($0) },
            onNudgeSelected: { capturedNudges.append($0) },
            onFeedConversationOpened: { _ in conversationOpens += 1 }
        )

        let item = makeItem(id: "nudge-1", type: .nudge)
        view.openItem(item)

        XCTAssertEqual(capturedNudges.map { $0.id }, ["nudge-1"],
                       "nudge callback should fire exactly once with the tapped item")
        XCTAssertTrue(capturedScheduled.isEmpty,
                      "nudge taps must not fire the scheduled callback")
        XCTAssertEqual(feedClient.triggerCallCount, 0,
                       "nudge taps must not round-trip through triggerAction")
        XCTAssertEqual(conversationOpens, 0,
                       "nudge taps must not attempt to open a conversation")
    }

    func test_openItem_nonNudgeType_skipsNudgeCallback() async {
        let (homeStore, feedStore, _) = makeStores()
        for nonNudgeType in [FeedItemType.digest, .action, .thread] {
            var captured: [FeedItem] = []
            let view = makeView(
                homeStore: homeStore,
                feedStore: feedStore,
                onNudgeSelected: { captured.append($0) }
            )

            view.openItem(makeItem(id: "x-\(nonNudgeType)", type: nonNudgeType))

            XCTAssertTrue(captured.isEmpty,
                          "\(nonNudgeType) taps must not fire the nudge callback")
        }
    }
}
