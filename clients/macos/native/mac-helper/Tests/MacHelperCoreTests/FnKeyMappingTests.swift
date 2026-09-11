import Foundation
import Testing

@testable import MacHelperCore

private let globeKeyboardPage: Int64 = 0xFF01_0000_0003
private let globeTopCasePage: Int64 = 0xFF00_0000_0003
private let noAction: Int64 = 0x7_0000_0000
private let leftControl: Int64 = 0x7_0000_00E0
private let f5: Int64 = 0x7_0000_003E

private func pair(_ source: Int64, _ destination: Int64) -> [String: Any] {
    [
        FnKeyMapping.sourceKey: source,
        FnKeyMapping.destinationKey: destination,
    ]
}

@Test func aGlobeKeySentToNoActionOnEitherPageIsReported() {
    #expect(
        FnKeyMapping.globeDestination(in: [pair(globeKeyboardPage, noAction)]) == .noAction
    )
    #expect(
        FnKeyMapping.globeDestination(in: [pair(globeTopCasePage, noAction)]) == .noAction
    )
}

@Test func aGlobeKeySentToAModifierIsNamed() {
    #expect(
        FnKeyMapping.globeDestination(in: [pair(globeKeyboardPage, leftControl)])
            == .key(name: "control")
    )
}

@Test func aGlobeKeySentSomewhereUnnamedIsStillARemap() {
    #expect(
        FnKeyMapping.globeDestination(in: [pair(globeKeyboardPage, f5)]) == .key(name: nil)
    )
}

/// The table records a key put back to Globe as Globe sent to Globe, on
/// either page, and that is not a remap.
@Test func aGlobeKeySentToItselfIsLeftAlone() {
    #expect(
        FnKeyMapping.globeDestination(in: [
            pair(globeKeyboardPage, globeTopCasePage),
            pair(globeTopCasePage, globeTopCasePage),
        ]) == nil
    )
}

@Test func otherKeysInTheTableAreIgnored() {
    #expect(
        FnKeyMapping.globeDestination(in: [
            pair(0x7_0000_0039, leftControl),
            pair(leftControl, noAction),
        ]) == nil
    )
}

/// The plist writer chooses the number type, and the row the user made in
/// System Settings may sit beside one an older macOS wrote.
@Test func usagesAreReadWhateverTheirNumberType() {
    let boxed: [String: Any] = [
        FnKeyMapping.sourceKey: NSNumber(value: globeKeyboardPage),
        FnKeyMapping.destinationKey: NSNumber(value: noAction),
    ]
    #expect(FnKeyMapping.globeDestination(in: [boxed]) == .noAction)

    let malformed: [String: Any] = [
        FnKeyMapping.sourceKey: "globe",
        FnKeyMapping.destinationKey: noAction,
    ]
    #expect(FnKeyMapping.globeDestination(in: [malformed]) == nil)
    #expect(FnKeyMapping.globeDestination(in: [[:]]) == nil)
}

@Test func noActionOnAnyKeyboardWinsOverARemapOnAnother() {
    let tables: [[[String: Any]]] = [
        [pair(globeKeyboardPage, leftControl)],
        [pair(globeTopCasePage, noAction)],
    ]
    #expect(FnKeyMapping.globeDestination(inTables: tables) == .noAction)
    #expect(
        FnKeyMapping.globeDestination(inTables: [[pair(globeKeyboardPage, leftControl)], []])
            == .key(name: "control")
    )
    #expect(FnKeyMapping.globeDestination(inTables: []) == nil)
}
