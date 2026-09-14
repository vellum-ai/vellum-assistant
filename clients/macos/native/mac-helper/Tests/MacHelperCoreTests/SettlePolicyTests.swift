import Foundation
import Testing

@testable import MacHelperCore

@Suite("SettlePolicy")
struct SettlePolicyTests {
    private let before = "Mail|Inbox|AXTextArea|"

    @Test("the first sample after the action never settles")
    func firstSampleNeverSettles() {
        #expect(SettlePolicy.hasSettled(baseline: before, previous: nil, current: "Mail|Inbox|AXTextArea|hi") == false)
        #expect(SettlePolicy.hasSettled(baseline: "", previous: nil, current: "x") == false)
    }

    @Test("a changed signature that holds still settles")
    func changedThenStableSettles() {
        let after = "Mail|Inbox|AXTextArea|hello"
        #expect(SettlePolicy.hasSettled(baseline: before, previous: after, current: after))
    }

    @Test("a signature that never moved from the baseline never settles early")
    func unchangedFromBaselineWaitsOutTheCeiling() {
        // A web page re-rendering under an unchanged title and focus reads the
        // same as before the click. Agreement here proves nothing.
        #expect(SettlePolicy.hasSettled(baseline: before, previous: before, current: before) == false)
    }

    @Test("a signature still changing does not settle")
    func stillChangingDoesNotSettle() {
        #expect(
            SettlePolicy.hasSettled(baseline: before, previous: "Mail|Inbox|AXTextArea|he", current: "Mail|Inbox|AXTextArea|hello") == false
        )
    }

    @Test("with no pre-action reading the step never ends early")
    func missingBaselineNeverSettles() {
        let after = "Mail|Inbox|AXTextArea|hello"
        #expect(SettlePolicy.hasSettled(baseline: nil, previous: after, current: after) == false)
    }

    @Test("the per-read timeout keeps a whole signature inside its budget")
    func perReadTimeoutFitsTheBudget() {
        let timeout = SettlePolicy.perReadTimeoutSeconds(budgetMs: 100, readCount: 5)
        #expect(timeout == 0.02)
        #expect(Float(5) * (timeout ?? .infinity) <= 0.1)
    }

    @Test("a budget too small to sample returns nil")
    func tinyBudgetSkipsSampling() {
        #expect(SettlePolicy.perReadTimeoutSeconds(budgetMs: 49, readCount: 5) == nil)
        #expect(SettlePolicy.perReadTimeoutSeconds(budgetMs: 50, readCount: 5) != nil)
        #expect(SettlePolicy.perReadTimeoutSeconds(budgetMs: 100, readCount: 0) == nil)
    }

    @Test("the floor leaves room to sample before the ceiling")
    func windowIsWellFormed() {
        #expect(SettlePolicy.floorMs < SettlePolicy.ceilingMs)
        #expect(SettlePolicy.sampleIntervalMs > 0)
        #expect(SettlePolicy.floorMs + SettlePolicy.sampleIntervalMs <= SettlePolicy.ceilingMs)
    }
}
