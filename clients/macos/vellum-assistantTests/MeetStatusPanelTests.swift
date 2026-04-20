import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

/// Unit tests for `MeetStatusViewModel` — the observable model backing
/// ``MeetStatusPanel``. Drives scripted `ServerMessage` events into the
/// shared stream and asserts the state machine transitions per the plan's
/// acceptance criteria (joining → joined → left → out-of-order guard).
@MainActor
final class MeetStatusPanelTests: XCTestCase {

    // MARK: - Fixtures

    /// Creates a view model plus the stream continuation so the test can
    /// drive SSE events deterministically. Accepts a fixed-clock closure so
    /// the `.joined(joinedAt:)` value is predictable across test runs.
    private func makeViewModel(
        fixedNow: Date = Date(timeIntervalSince1970: 1_700_000_000)
    ) -> (MeetStatusViewModel, AsyncStream<ServerMessage>.Continuation) {
        let (stream, continuation) = AsyncStream<ServerMessage>.makeStream()
        let vm = MeetStatusViewModel(
            messageStream: stream,
            clock: { fixedNow }
        )
        return (vm, continuation)
    }

    // MARK: - Joining

    func testJoiningEventShowsJoiningState() async throws {
        let (vm, continuation) = makeViewModel()
        XCTAssertEqual(vm.state, .idle)

        continuation.yield(.meetJoining(
            MeetJoiningMessage(
                type: "meet.joining",
                meetingId: "m1",
                url: "https://meet.google.com/abc-defg-hij"
            )
        ))

        try await waitUntil(timeout: 2.0) {
            if case .joining = vm.state { return true }
            return false
        }

        guard case let .joining(meetingId, url) = vm.state else {
            return XCTFail("expected .joining state")
        }
        XCTAssertEqual(meetingId, "m1")
        XCTAssertEqual(url, "https://meet.google.com/abc-defg-hij")
    }

    // MARK: - Joined

    func testJoinedAfterJoiningShowsInMeetingStateWithJoinedAt() async throws {
        let fixedNow = Date(timeIntervalSince1970: 1_700_123_456)
        let (vm, continuation) = makeViewModel(fixedNow: fixedNow)

        continuation.yield(.meetJoining(
            MeetJoiningMessage(
                type: "meet.joining",
                meetingId: "m2",
                url: "https://meet.google.com/demo"
            )
        ))
        continuation.yield(.meetJoined(
            MeetJoinedMessage(type: "meet.joined", meetingId: "m2")
        ))

        try await waitUntil(timeout: 2.0) {
            if case .joined = vm.state { return true }
            return false
        }

        guard case let .joined(meetingId, title, joinedAt) = vm.state else {
            return XCTFail("expected .joined state")
        }
        XCTAssertEqual(meetingId, "m2")
        XCTAssertEqual(title, "https://meet.google.com/demo")
        XCTAssertEqual(joinedAt, fixedNow)
    }

    /// Elapsed-time formatter — the TimelineView ticks once per second and
    /// renders this string, so we lock in mm:ss and h:mm:ss formatting.
    func testFormatElapsedRendersAsMMSS() {
        let start = Date(timeIntervalSince1970: 1_000_000_000)
        XCTAssertEqual(
            MeetStatusPanel.formatElapsed(from: start, now: start),
            "0:00"
        )
        XCTAssertEqual(
            MeetStatusPanel.formatElapsed(
                from: start,
                now: start.addingTimeInterval(5)
            ),
            "0:05"
        )
        XCTAssertEqual(
            MeetStatusPanel.formatElapsed(
                from: start,
                now: start.addingTimeInterval(73)
            ),
            "1:13"
        )
        XCTAssertEqual(
            MeetStatusPanel.formatElapsed(
                from: start,
                now: start.addingTimeInterval(3_725)
            ),
            "1:02:05"
        )
        // Clock skew guard — negative intervals clamp to zero.
        XCTAssertEqual(
            MeetStatusPanel.formatElapsed(
                from: start,
                now: start.addingTimeInterval(-100)
            ),
            "0:00"
        )
    }

    // MARK: - Left

    func testLeftEventResetsToIdle() async throws {
        let (vm, continuation) = makeViewModel()

        // Drive the model into .joined first.
        continuation.yield(.meetJoining(
            MeetJoiningMessage(
                type: "meet.joining",
                meetingId: "m3",
                url: "https://meet.google.com/xyz"
            )
        ))
        continuation.yield(.meetJoined(
            MeetJoinedMessage(type: "meet.joined", meetingId: "m3")
        ))
        try await waitUntil(timeout: 2.0) {
            if case .joined = vm.state { return true }
            return false
        }

        continuation.yield(.meetLeft(
            MeetLeftMessage(
                type: "meet.left",
                meetingId: "m3",
                reason: "user-requested"
            )
        ))
        try await waitUntil(timeout: 2.0) {
            vm.state == .idle
        }
    }

    // MARK: - Out-of-order

    /// A `meet.left` arriving while the panel is already idle must not
    /// throw — and must leave the panel idle. `meet.left` unambiguously means
    /// the meeting is over, so there is nothing for the panel to render even
    /// if we missed the preceding lifecycle events.
    func testLeftBeforeJoinedKeepsPanelIdle() async throws {
        let (vm, continuation) = makeViewModel()
        XCTAssertEqual(vm.state, .idle)

        continuation.yield(.meetLeft(
            MeetLeftMessage(
                type: "meet.left",
                meetingId: "stale-meeting",
                reason: "timeout"
            )
        ))

        // Give the consumer task a chance to pull the event off the stream.
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(vm.state, .idle)
    }

    /// SSE reconnect mid-meeting — the daemon has already published
    /// `meet.joining` before the client subscribed, so the next `meet.joined`
    /// arrives with no matching prior state. The panel must still show the
    /// live meeting (the bot is demonstrably in it), using the meetingId as
    /// the title fallback until later events populate real data.
    func testJoinedWithoutJoiningOnReconnectShowsPanel() async throws {
        let fixedNow = Date(timeIntervalSince1970: 1_700_777_777)
        let (vm, continuation) = makeViewModel(fixedNow: fixedNow)
        XCTAssertEqual(vm.state, .idle)

        continuation.yield(.meetJoined(
            MeetJoinedMessage(type: "meet.joined", meetingId: "reconnect-meeting")
        ))

        try await waitUntil(timeout: 2.0) {
            if case .joined = vm.state { return true }
            return false
        }

        guard case let .joined(meetingId, title, joinedAt) = vm.state else {
            return XCTFail("expected .joined state")
        }
        XCTAssertEqual(meetingId, "reconnect-meeting")
        // With no prior `.joining` we fall back to the meetingId as a
        // placeholder title until a richer event arrives.
        XCTAssertEqual(title, "reconnect-meeting")
        XCTAssertEqual(joinedAt, fixedNow)
    }

    // MARK: - meetingId scoping

    /// With multiple simultaneous meetings, a stale `meet.left` for meeting A
    /// must not wipe meeting B's live banner. The state machine ignores the
    /// event when its meetingId does not match the in-flight meeting.
    func testLeftForNonCurrentMeetingDoesNotResetJoinedState() async throws {
        let fixedNow = Date(timeIntervalSince1970: 1_700_500_000)
        let (vm, continuation) = makeViewModel(fixedNow: fixedNow)

        // Drive the panel to .joined for meeting B.
        continuation.yield(.meetJoining(
            MeetJoiningMessage(
                type: "meet.joining",
                meetingId: "meeting-b",
                url: "https://meet.google.com/meeting-b"
            )
        ))
        continuation.yield(.meetJoined(
            MeetJoinedMessage(type: "meet.joined", meetingId: "meeting-b")
        ))
        try await waitUntil(timeout: 2.0) {
            if case .joined = vm.state { return true }
            return false
        }

        // Stale .left for a different meeting must NOT collapse to idle.
        continuation.yield(.meetLeft(
            MeetLeftMessage(
                type: "meet.left",
                meetingId: "meeting-a",
                reason: "stale"
            )
        ))

        // Give the consumer task a chance to pull the event off the stream.
        try await Task.sleep(nanoseconds: 150_000_000)
        guard case let .joined(meetingId, _, _) = vm.state else {
            return XCTFail("expected banner to still be .joined for meeting-b")
        }
        XCTAssertEqual(meetingId, "meeting-b")
    }

    /// Matching-meetingId `meet.left` still transitions correctly after the
    /// guard is in place — ensures we don't regress the happy path.
    func testLeftForCurrentMeetingResetsToIdle() async throws {
        let (vm, continuation) = makeViewModel()

        continuation.yield(.meetJoining(
            MeetJoiningMessage(
                type: "meet.joining",
                meetingId: "meeting-c",
                url: "https://meet.google.com/meeting-c"
            )
        ))
        continuation.yield(.meetJoined(
            MeetJoinedMessage(type: "meet.joined", meetingId: "meeting-c")
        ))
        try await waitUntil(timeout: 2.0) {
            if case .joined = vm.state { return true }
            return false
        }

        continuation.yield(.meetLeft(
            MeetLeftMessage(
                type: "meet.left",
                meetingId: "meeting-c",
                reason: "user-requested"
            )
        ))
        try await waitUntil(timeout: 2.0) {
            vm.state == .idle
        }
    }

    /// A stale `meet.error` for a non-current meeting must not overwrite the
    /// live `.joined` banner for a different meeting.
    func testErrorForNonCurrentMeetingDoesNotReplaceJoinedState() async throws {
        let (vm, continuation) = makeViewModel()

        continuation.yield(.meetJoining(
            MeetJoiningMessage(
                type: "meet.joining",
                meetingId: "meeting-d",
                url: "https://meet.google.com/meeting-d"
            )
        ))
        continuation.yield(.meetJoined(
            MeetJoinedMessage(type: "meet.joined", meetingId: "meeting-d")
        ))
        try await waitUntil(timeout: 2.0) {
            if case .joined = vm.state { return true }
            return false
        }

        continuation.yield(.meetError(
            MeetErrorMessage(
                type: "meet.error",
                meetingId: "meeting-e",
                detail: "bot crashed"
            )
        ))

        try await Task.sleep(nanoseconds: 150_000_000)
        guard case let .joined(meetingId, _, _) = vm.state else {
            return XCTFail("expected banner to still be .joined for meeting-d")
        }
        XCTAssertEqual(meetingId, "meeting-d")
    }

    // MARK: - Error

    func testErrorEventShowsErrorState() async throws {
        let (vm, continuation) = makeViewModel()

        continuation.yield(.meetError(
            MeetErrorMessage(
                type: "meet.error",
                meetingId: "m4",
                detail: "bot container crashed"
            )
        ))
        try await waitUntil(timeout: 2.0) {
            if case .error = vm.state { return true }
            return false
        }

        guard case let .error(reason) = vm.state else {
            return XCTFail("expected .error state")
        }
        XCTAssertEqual(reason, "bot container crashed")
    }

    // MARK: - Helpers

    /// Polls `condition` on the MainActor until it returns true or the
    /// timeout elapses — same pattern used by `HomeStoreTests`.
    private func waitUntil(
        timeout: TimeInterval,
        condition: @MainActor () -> Bool
    ) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return }
            try await Task.sleep(nanoseconds: 20_000_000) // 20 ms
        }
        XCTFail("waitUntil timed out after \(timeout)s")
    }
}
