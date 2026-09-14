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

    @Test("a held button is the user even with no recent event")
    func heldButton() {
        // A drag paused past the quiet window sends nothing new.
        #expect(
            UserActivityGate.userIsActive(
                now: now,
                lastSyntheticPostAt: nil,
                secondsSinceLastInput: 120,
                buttonHeld: true
            )
        )
    }

    @Test("a held modifier is the user even with no recent event")
    func heldModifier() {
        #expect(
            UserActivityGate.userIsActive(
                now: now,
                lastSyntheticPostAt: nil,
                secondsSinceLastInput: 120,
                modifierHeld: true
            )
        )
    }

    @Test("our own consecutive action with nothing held is still ours")
    func consecutiveSyntheticNothingHeld() {
        #expect(
            UserActivityGate.userIsActive(
                now: now,
                lastSyntheticPostAt: now.addingTimeInterval(-0.25),
                secondsSinceLastInput: 0.25,
                buttonHeld: false,
                modifierHeld: false
            ) == false
        )
    }

    @Test("a modifier flag left behind by our own shortcut is not the user's")
    func staleSyntheticModifierIsNotTheUser() {
        // The flags last changed well before our post: nothing physical was
        // pressed since, so whatever still reads as held came from our event.
        let ourPost = now.addingTimeInterval(-0.5)
        #expect(UserActivityGate.heldByUser(
            now: now, inputDown: true, secondsSinceLastChange: 60, lastSyntheticPostAt: ourPost
        ) == false)
    }

    @Test("a modifier pressed after our last post is the user's")
    func modifierPressedAfterOurPostIsTheUser() {
        let ourPost = now.addingTimeInterval(-5)
        #expect(UserActivityGate.heldByUser(
            now: now, inputDown: true, secondsSinceLastChange: 2, lastSyntheticPostAt: ourPost
        ))
    }

    @Test("a held modifier with no synthetic post yet is the user's")
    func modifierWithNoPostIsTheUser() {
        #expect(UserActivityGate.heldByUser(
            now: now, inputDown: true, secondsSinceLastChange: 120, lastSyntheticPostAt: nil
        ))
    }

    @Test("no modifier down is never held")
    func noModifierIsNotHeld() {
        #expect(UserActivityGate.heldByUser(
            now: now, inputDown: false, secondsSinceLastChange: 0, lastSyntheticPostAt: nil
        ) == false)
    }

    @Test("a button down from our own overlapping step is not the user's")
    func overlappingSyntheticClickIsNotTheUser() {
        // Another step posted its mouse-down 10ms ago and has not posted the up.
        let ourPost = now.addingTimeInterval(-0.01)
        #expect(UserActivityGate.heldByUser(
            now: now, inputDown: true, secondsSinceLastChange: 0.01, lastSyntheticPostAt: ourPost
        ) == false)
    }

    @Test("a button the person pressed well after our last post is theirs")
    func buttonPressedAfterOurPost() {
        let ourPost = now.addingTimeInterval(-3)
        #expect(UserActivityGate.heldByUser(
            now: now, inputDown: true, secondsSinceLastChange: 1, lastSyntheticPostAt: ourPost
        ))
    }

    @Test("input emitted during our AppleScript run is ours, wherever in the run it landed")
    func appleScriptSpanIsOurs() {
        // The script ran from 2s ago to 0.1s ago and pressed a key 1.5s ago.
        #expect(UserActivityGate.userIsActive(
            now: now,
            lastSyntheticPostAt: now.addingTimeInterval(-0.1),
            secondsSinceLastInput: 1.5,
            syntheticSpanStart: now.addingTimeInterval(-2),
            quietWindow: 3
        ) == false)
    }

    @Test("input after our AppleScript run ended is the user's")
    func inputAfterSpanIsTheUser() {
        #expect(UserActivityGate.userIsActive(
            now: now,
            lastSyntheticPostAt: now.addingTimeInterval(-1),
            secondsSinceLastInput: 0.2,
            syntheticSpanStart: now.addingTimeInterval(-3),
            quietWindow: 3
        ))
    }
}
