import Testing

@testable import MacHelperCore

private typealias Edge = FnTapDetector.Edge

@Test func bareTapEmitsDownUpPairOnRelease() {
    var detector = FnTapDetector()

    #expect(detector.flagsChanged(fnHeld: true, otherModifiersHeld: false) == [])
    #expect(
        detector.flagsChanged(fnHeld: false, otherModifiersHeld: false)
            == [Edge.down, Edge.up]
    )
}

@Test func modifierHeldBeforeFnNeverFires() {
    var detector = FnTapDetector()

    // Ctrl down, then Fn joins: Fn went down inside a chord.
    #expect(detector.flagsChanged(fnHeld: false, otherModifiersHeld: true) == [])
    #expect(detector.flagsChanged(fnHeld: true, otherModifiersHeld: true) == [])
    // Release in either order; the up on Fn release closes nothing real
    // (the consumer's down/up bookkeeping treats an unmatched up as a no-op).
    #expect(detector.flagsChanged(fnHeld: true, otherModifiersHeld: false) == [])
    #expect(
        detector.flagsChanged(fnHeld: false, otherModifiersHeld: false)
            == [Edge.up]
    )
}

@Test func modifierJoiningAfterFnNeverFires() {
    var detector = FnTapDetector()

    // Fn first, then Ctrl a few milliseconds later (Fn+Ctrl pressed
    // "together"): the verdict must wait for the release, and stay chord.
    #expect(detector.flagsChanged(fnHeld: true, otherModifiersHeld: false) == [])
    #expect(
        detector.flagsChanged(fnHeld: true, otherModifiersHeld: true)
            == [Edge.up]
    )
    // Ctrl releases first, leaving Fn alone again; still the same press.
    #expect(detector.flagsChanged(fnHeld: true, otherModifiersHeld: false) == [])
    #expect(
        detector.flagsChanged(fnHeld: false, otherModifiersHeld: false)
            == [Edge.up]
    )
}

@Test func keyPressDuringHoldDisqualifiesTheTap() {
    var detector = FnTapDetector()

    // Fn+arrow / Fn+Delete: a plain key, invisible in the modifier flags.
    #expect(detector.flagsChanged(fnHeld: true, otherModifiersHeld: false) == [])
    #expect(detector.keyDown() == [Edge.up])
    #expect(detector.flagsChanged(fnHeld: false, otherModifiersHeld: false) == [Edge.up])
}

@Test func typingWithoutFnEmitsNothing() {
    var detector = FnTapDetector()

    #expect(detector.keyDown() == [])
    // Shift pressed and released around a capital letter.
    #expect(detector.flagsChanged(fnHeld: false, otherModifiersHeld: true) == [])
    #expect(detector.keyDown() == [])
    #expect(detector.flagsChanged(fnHeld: false, otherModifiersHeld: false) == [])
}

@Test func tapAfterDisqualifiedHoldStillFires() {
    var detector = FnTapDetector()

    _ = detector.flagsChanged(fnHeld: true, otherModifiersHeld: false)
    _ = detector.flagsChanged(fnHeld: true, otherModifiersHeld: true)
    _ = detector.flagsChanged(fnHeld: false, otherModifiersHeld: false)

    #expect(detector.flagsChanged(fnHeld: true, otherModifiersHeld: false) == [])
    #expect(
        detector.flagsChanged(fnHeld: false, otherModifiersHeld: false)
            == [Edge.down, Edge.up]
    )
}

@Test func ordinaryKeyHeldBeforeFnBlocksTheTap() {
    var detector = FnTapDetector()

    // Delete held first, then Fn pressed and released around it: the key
    // predates the hold, so neither the flags nor key-down events see it.
    #expect(
        detector.flagsChanged(
            fnHeld: true,
            otherModifiersHeld: false,
            ordinaryKeyHeld: { true }
        ) == []
    )
    #expect(
        detector.flagsChanged(fnHeld: false, otherModifiersHeld: false)
            == [Edge.up]
    )
}

@Test func ordinaryKeyStateIsPolledOnlyAtThePress() {
    var detector = FnTapDetector()
    var polls = 0
    let countingPoll: () -> Bool = {
        polls += 1
        return false
    }

    _ = detector.flagsChanged(
        fnHeld: true, otherModifiersHeld: false, ordinaryKeyHeld: countingPoll
    )
    // Fn held steady through another flags change, then released.
    _ = detector.flagsChanged(
        fnHeld: true, otherModifiersHeld: false, ordinaryKeyHeld: countingPoll
    )
    _ = detector.flagsChanged(
        fnHeld: false, otherModifiersHeld: false, ordinaryKeyHeld: countingPoll
    )

    #expect(polls == 1)
}

@Test func consecutiveTapsEachFire() {
    var detector = FnTapDetector()

    for _ in 0..<2 {
        #expect(detector.flagsChanged(fnHeld: true, otherModifiersHeld: false) == [])
        #expect(
            detector.flagsChanged(fnHeld: false, otherModifiersHeld: false)
                == [Edge.down, Edge.up]
        )
    }
}
