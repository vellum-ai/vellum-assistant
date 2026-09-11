import Foundation
import Testing

@testable import MacHelperCore

@Suite("SettlePolicy.hasSettled")
struct SettlePolicyTests {
    @Test("the first sample never settles")
    func firstSampleNeverSettles() {
        // Nothing has been seen yet, so there is nothing to agree with. An
        // empty signature is the interesting case: a bare `previous == current`
        // on two non-optionals would call it settled.
        #expect(SettlePolicy.hasSettled(previous: nil, current: "Finder|Documents|") == false)
        #expect(SettlePolicy.hasSettled(previous: nil, current: "") == false)
    }

    @Test("two identical samples settle")
    func identicalSamplesSettle() {
        #expect(SettlePolicy.hasSettled(previous: "Finder|Documents|", current: "Finder|Documents|"))
    }

    @Test("two differing samples do not settle")
    func differingSamplesDoNotSettle() {
        // The window title changed between samples, so the UI is still moving.
        #expect(
            SettlePolicy.hasSettled(previous: "Finder|Documents|", current: "Finder|Downloads|") == false
        )
        // So does a focused field whose value is still being filled in.
        #expect(SettlePolicy.hasSettled(previous: "Mail|Inbox|he", current: "Mail|Inbox|hello") == false)
    }

    @Test("the floor leaves room to sample before the ceiling")
    func windowIsWellFormed() {
        #expect(SettlePolicy.floorMs < SettlePolicy.ceilingMs)
        #expect(SettlePolicy.sampleIntervalMs > 0)
        #expect(SettlePolicy.floorMs + SettlePolicy.sampleIntervalMs <= SettlePolicy.ceilingMs)
    }
}
