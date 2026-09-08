import Testing

@testable import MacHelperCore

private typealias Edge = ModifierHoldDetector.Edge

/// The opening edge arrives at press, which is the whole difference from a tap:
/// a microphone that opened on release would record nothing.
@Test func holdOpensAtPressAndClosesAtRelease() {
    var detector = ModifierHoldDetector()

    #expect(
        detector.flagsChanged(
        targetHeld: true,
        anyTargetHeld: true, extraModifiersHeld: false)
            == [Edge.down]
    )
    #expect(
        detector.flagsChanged(
        targetHeld: false,
        anyTargetHeld: false, extraModifiersHeld: false)
            == [Edge.up(.released)]
    )
}

/// Repeated flag events during one hold are the common case, since every
/// modifier press and release delivers one.
@Test func holdReportsNothingWhileItIsMerelyContinuing() {
    var detector = ModifierHoldDetector()

    #expect(
        detector.flagsChanged(
        targetHeld: true,
        anyTargetHeld: true, extraModifiersHeld: false)
            == [Edge.down]
    )
    #expect(
        detector.flagsChanged(
        targetHeld: true,
        anyTargetHeld: true, extraModifiersHeld: false) == []
    )
    #expect(
        detector.flagsChanged(
        targetHeld: true,
        anyTargetHeld: true, extraModifiersHeld: false) == []
    )
}

/// A modifier outside the set joining makes the press a chord on its way
/// somewhere else.
@Test func extraModifierJoiningEndsTheHold() {
    var detector = ModifierHoldDetector()

    #expect(
        detector.flagsChanged(
        targetHeld: true,
        anyTargetHeld: true, extraModifiersHeld: false)
            == [Edge.down]
    )
    #expect(
        detector.flagsChanged(
        targetHeld: true,
        anyTargetHeld: true, extraModifiersHeld: true)
            == [Edge.up(.chord)]
    )
}

/// And it stays disqualified: releasing the extra modifier leaves the user
/// holding a set they already spent, so nothing reopens until they press again.
@Test func aDisqualifiedHoldDoesNotReopenWhenTheExtraModifierLifts() {
    var detector = ModifierHoldDetector()

    _ = detector.flagsChanged(
        targetHeld: true,
        anyTargetHeld: true, extraModifiersHeld: false)
    _ = detector.flagsChanged(
        targetHeld: true,
        anyTargetHeld: true, extraModifiersHeld: true)
    #expect(
        detector.flagsChanged(
        targetHeld: true,
        anyTargetHeld: true, extraModifiersHeld: false) == []
    )
    #expect(
        detector.flagsChanged(
        targetHeld: false,
        anyTargetHeld: false, extraModifiersHeld: false)
            == []
    )
}

/// Starting inside a chord never opens one either.
@Test func targetHeldInsideAChordNeverOpens() {
    var detector = ModifierHoldDetector()

    #expect(
        detector.flagsChanged(
        targetHeld: true,
        anyTargetHeld: true, extraModifiersHeld: true) == []
    )
    #expect(
        detector.flagsChanged(
        targetHeld: false,
        anyTargetHeld: false, extraModifiersHeld: true) == []
    )
}

/// An ordinary key pressed during the hold is the shortcut the user is actually
/// reaching for, which is the case that has to stay theirs.
@Test func anOrdinaryKeyDuringTheHoldEndsIt() {
    var detector = ModifierHoldDetector()

    #expect(
        detector.flagsChanged(
        targetHeld: true,
        anyTargetHeld: true, extraModifiersHeld: false)
            == [Edge.down]
    )
    #expect(detector.keyDown() == [Edge.up(.chord)])
    // The release that follows is owed nothing: the hold is already closed.
    #expect(
        detector.flagsChanged(
        targetHeld: false,
        anyTargetHeld: false, extraModifiersHeld: false)
            == []
    )
}

/// A key already down when the modifiers arrive is invisible to the flags and
/// to every key-down that follows, so the opening has to poll for it.
@Test func anOrdinaryKeyAlreadyDownNeverOpensAHold() {
    var detector = ModifierHoldDetector()

    #expect(
        detector.flagsChanged(
        targetHeld: true,
        anyTargetHeld: true,
            extraModifiersHeld: false,
            ordinaryKeyHeld: { true }
        ) == []
    )
}

/// The poll runs only where it can change the answer, since it walks the whole
/// keyboard.
@Test func theOrdinaryKeyPollIsNotConsultedOnEveryEvent() {
    var detector = ModifierHoldDetector()
    var polls = 0
    let poll = {
        polls += 1
        return false
    }

    _ = detector.flagsChanged(
        targetHeld: true,
        anyTargetHeld: true, extraModifiersHeld: false, ordinaryKeyHeld: poll)
    _ = detector.flagsChanged(
        targetHeld: true,
        anyTargetHeld: true, extraModifiersHeld: false, ordinaryKeyHeld: poll)
    _ = detector.flagsChanged(
        targetHeld: false,
        anyTargetHeld: false, extraModifiersHeld: false, ordinaryKeyHeld: poll)

    #expect(polls == 1)
}

/// Keys pressed while nothing is open are somebody else's business entirely.
@Test func keyDownOutsideAHoldReportsNothing() {
    var detector = ModifierHoldDetector()

    #expect(detector.keyDown() == [])
}

/// Teardown owes an open hold its closing edge, or the consumer is left with a
/// microphone nobody is going to close.
@Test func cancelClosesAnOpenHoldAndIsSilentOtherwise() {
    var detector = ModifierHoldDetector()

    #expect(detector.cancel() == [])
    _ = detector.flagsChanged(
        targetHeld: true,
        anyTargetHeld: true, extraModifiersHeld: false)
    #expect(detector.cancel() == [Edge.up(.cancelled)])
    #expect(detector.cancel() == [])
}

/// Every hold that opens is closed exactly once, whichever way it ends. The
/// consumer's bookkeeping is a microphone, so an unmatched edge either strands
/// it open or closes one that was never opened.
@Test func everyOpenIsClosedExactlyOnce() {
    var detector = ModifierHoldDetector()
    var depth = 0

    let apply = { (edges: [Edge]) in
        for edge in edges {
            depth += edge == .down ? 1 : -1
            #expect(depth == 0 || depth == 1)
        }
    }

    apply(detector.flagsChanged(
        targetHeld: true,
        anyTargetHeld: true, extraModifiersHeld: false))
    apply(detector.keyDown())
    apply(detector.flagsChanged(
        targetHeld: false,
        anyTargetHeld: false, extraModifiersHeld: false))
    apply(detector.flagsChanged(
        targetHeld: true,
        anyTargetHeld: true, extraModifiersHeld: false))
    apply(detector.flagsChanged(
        targetHeld: true,
        anyTargetHeld: true, extraModifiersHeld: true))
    apply(detector.flagsChanged(
        targetHeld: false,
        anyTargetHeld: false, extraModifiersHeld: false))
    apply(detector.flagsChanged(
        targetHeld: true,
        anyTargetHeld: true, extraModifiersHeld: false))
    apply(detector.cancel())

    #expect(depth == 0)
}

/// A set of more than one stops being *held* the moment either modifier lifts,
/// which is not the same as the set being *released*. The latch has to survive
/// the difference, or half a chord is enough to rearm it.
@Test func aSpentPressSurvivesOneModifierOfTheSetLifting() {
    var detector = ModifierHoldDetector()

    // Ctrl+Option down, then a key: the hold is someone else's shortcut now.
    #expect(
        detector.flagsChanged(
            targetHeld: true, anyTargetHeld: true, extraModifiersHeld: false)
            == [Edge.down]
    )
    #expect(detector.keyDown() == [Edge.up(.chord)])

    // Option lifts, Ctrl stays down. The set is no longer held, but it is not
    // released either, and the user is still mid-shortcut on the one that is.
    #expect(
        detector.flagsChanged(
            targetHeld: false, anyTargetHeld: true, extraModifiersHeld: false)
            == []
    )
    // Pressing it again must not reopen a microphone under their shortcut.
    #expect(
        detector.flagsChanged(
            targetHeld: true, anyTargetHeld: true, extraModifiersHeld: false)
            == []
    )

    // Everything up: the press is finally spent, and the next one is fresh.
    #expect(
        detector.flagsChanged(
            targetHeld: false, anyTargetHeld: false, extraModifiersHeld: false)
            == []
    )
    #expect(
        detector.flagsChanged(
            targetHeld: true, anyTargetHeld: true, extraModifiersHeld: false)
            == [Edge.down]
    )
}

/// The same, for a hold ended by an extra modifier rather than by a key.
@Test func aChordDisqualifiedHoldStaysSpentAcrossAPartialRelease() {
    var detector = ModifierHoldDetector()

    _ = detector.flagsChanged(
        targetHeld: true, anyTargetHeld: true, extraModifiersHeld: false)
    #expect(
        detector.flagsChanged(
            targetHeld: true, anyTargetHeld: true, extraModifiersHeld: true)
            == [Edge.up(.chord)]
    )
    // Shift lifts and Option lifts; Ctrl is still down.
    #expect(
        detector.flagsChanged(
            targetHeld: false, anyTargetHeld: true, extraModifiersHeld: false)
            == []
    )
    #expect(
        detector.flagsChanged(
            targetHeld: true, anyTargetHeld: true, extraModifiersHeld: false)
            == []
    )
}
