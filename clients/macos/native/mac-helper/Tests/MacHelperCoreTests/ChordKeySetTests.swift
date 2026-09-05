import Testing

@testable import MacHelperCore

@Test func namesOnlyTheKeysItWasGiven() {
    let keys = ChordKeySet(["s", "d"])

    #expect(keys.match("s") == "s")
    #expect(keys.match("d") == "d")
    #expect(keys.match("e") == nil)
}

/// The user's shift, caps lock, or a layout that reports the letter in upper
/// case are all the same key.
@Test func matchesRegardlessOfCase() {
    let keys = ChordKeySet(["s"])

    #expect(keys.match("S") == "s")
    #expect(ChordKeySet(["S"]).match("s") == "s")
}

/// A dead key reports nothing and a composed key reports a sequence. Neither
/// is one of the keys on offer, and a set that matched either would report an
/// identity for a press the caller never asked about.
@Test func matchesNothingThatIsNotASingleCharacter() {
    let keys = ChordKeySet(["s"])

    #expect(keys.match("") == nil)
    #expect(keys.match("ss") == nil)
}

/// The binding is the caller's, and a caller naming nothing is the state every
/// hold was in before these gestures existed: a key going down is a chord, and
/// which key it was is nobody's business.
@Test func anEmptySetNamesNothing() {
    #expect(ChordKeySet().isEmpty)
    #expect(ChordKeySet().match("s") == nil)
    #expect(ChordKeySet(["ss", ""]).isEmpty)
}
