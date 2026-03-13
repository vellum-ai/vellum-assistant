import XCTest
@testable import VellumAssistantLib

final class ConversationAvatarFollowerTests: XCTestCase {
    func testStreamingCoalescingUsesMinimumInterval() {
        let now = Date(timeIntervalSince1970: 1_000)
        let lastAppliedAt = now.addingTimeInterval(-0.04)

        let delay = ConversationAvatarFollower.smoothingDelay(
            isSending: true,
            isThinking: false,
            isLastMessageStreaming: true,
            lastAppliedAt: lastAppliedAt,
            now: now
        )

        XCTAssertEqual(delay, 0.06, accuracy: 0.001)
    }

    func testVisibilityBoundsMatchViewportGate() {
        XCTAssertTrue(ConversationAvatarFollower.shouldShow(anchorY: -24, viewportHeight: 500))
        XCTAssertTrue(ConversationAvatarFollower.shouldShow(anchorY: 524, viewportHeight: 500))
        XCTAssertFalse(ConversationAvatarFollower.shouldShow(anchorY: -24.1, viewportHeight: 500))
        XCTAssertFalse(ConversationAvatarFollower.shouldShow(anchorY: 524.1, viewportHeight: 500))
        XCTAssertFalse(ConversationAvatarFollower.shouldShow(anchorY: .infinity, viewportHeight: 500))
    }

    func testIdleBypassesCoalescing() {
        let now = Date(timeIntervalSince1970: 1_000)
        let lastAppliedAt = now

        let delay = ConversationAvatarFollower.smoothingDelay(
            isSending: false,
            isThinking: false,
            isLastMessageStreaming: false,
            lastAppliedAt: lastAppliedAt,
            now: now
        )

        XCTAssertEqual(delay, 0, accuracy: 0.0001)
    }
}
