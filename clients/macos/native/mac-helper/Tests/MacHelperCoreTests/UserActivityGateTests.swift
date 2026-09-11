import Foundation
import Testing

@testable import MacHelperCore

@Suite("UserActivityGate.userIsActive")
struct UserActivityGateTests {
    /// The reference date itself, so every offset below is an exact binary
    /// fraction and the boundary cases land on the comparison, not on the
    /// rounding of a large timestamp.
    private let now = Date(timeIntervalSinceReferenceDate: 0)

    @Test("a machine nobody has touched is free to drive")
    func idleUser() {
        // The common case: the user asked for something and went back to
        // reading, so the last input is minutes old.
        #expect(
            UserActivityGate.userIsActive(
                now: now,
                lastSyntheticPostAt: nil,
                secondsSinceLastInput: 120
            ) == false
        )
    }

    @Test("our own last post is not the user")
    func recentEventIsOurs() {
        // The click we posted a moment ago refreshed the system's last-input
        // clock. Recency alone would read it back as a person typing.
        #expect(
            UserActivityGate.userIsActive(
                now: now,
                lastSyntheticPostAt: now.addingTimeInterval(-0.25),
                secondsSinceLastInput: 0.25
            ) == false
        )
    }

    @Test("a recent event with nothing of ours to blame is the user")
    func recentEventWithNoSyntheticPost() {
        #expect(
            UserActivityGate.userIsActive(
                now: now,
                lastSyntheticPostAt: nil,
                secondsSinceLastInput: 0.25
            )
        )
    }

    @Test("an event well after our last post is the user")
    func recentEventAfterOurPost() {
        // We posted 5 seconds ago and something happened a quarter second ago.
        // The gap is far wider than the epsilon, so that something was a person.
        #expect(
            UserActivityGate.userIsActive(
                now: now,
                lastSyntheticPostAt: now.addingTimeInterval(-5),
                secondsSinceLastInput: 0.25
            )
        )
    }

    @Test("an event at exactly the quiet window still counts as activity")
    func boundaryQuietWindow() {
        #expect(
            UserActivityGate.userIsActive(
                now: now,
                lastSyntheticPostAt: nil,
                secondsSinceLastInput: 1.0
            )
        )
        #expect(
            UserActivityGate.userIsActive(
                now: now,
                lastSyntheticPostAt: nil,
                secondsSinceLastInput: 1.25
            ) == false
        )
    }

    @Test("an event exactly an epsilon from our post is still ours")
    func boundarySyntheticEpsilon() {
        // A quarter second either side of our post is attributed to us; wider
        // than that is the user.
        #expect(
            UserActivityGate.userIsActive(
                now: now,
                lastSyntheticPostAt: now.addingTimeInterval(-0.25),
                secondsSinceLastInput: 0.5
            ) == false
        )
        #expect(
            UserActivityGate.userIsActive(
                now: now,
                lastSyntheticPostAt: now.addingTimeInterval(-0.125),
                secondsSinceLastInput: 0.5
            )
        )
    }

    @Test("the epsilon is symmetric around our post")
    func epsilonIsSymmetric() {
        // Our post can be stamped either side of the clock the system reports,
        // so the comparison has to hold in both directions.
        let inputAgo = 0.5
        #expect(
            UserActivityGate.userIsActive(
                now: now,
                lastSyntheticPostAt: now.addingTimeInterval(-(inputAgo - 0.125)),
                secondsSinceLastInput: inputAgo
            ) == false
        )
        #expect(
            UserActivityGate.userIsActive(
                now: now,
                lastSyntheticPostAt: now.addingTimeInterval(-(inputAgo + 0.125)),
                secondsSinceLastInput: inputAgo
            ) == false
        )
    }

    @Test("the caller can widen or narrow both windows")
    func customWindows() {
        // Two seconds is quiet by default and loud with a wider window.
        #expect(
            UserActivityGate.userIsActive(
                now: now,
                lastSyntheticPostAt: nil,
                secondsSinceLastInput: 2.0
            ) == false
        )
        #expect(
            UserActivityGate.userIsActive(
                now: now,
                lastSyntheticPostAt: nil,
                secondsSinceLastInput: 2.0,
                quietWindow: 3.0
            )
        )
        // With no epsilon, our own post is indistinguishable from the user.
        #expect(
            UserActivityGate.userIsActive(
                now: now,
                lastSyntheticPostAt: now.addingTimeInterval(-0.5),
                secondsSinceLastInput: 0.25,
                syntheticEpsilon: 0
            )
        )
    }
}
