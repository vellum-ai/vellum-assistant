import Foundation
import Testing

@testable import MacHelperCore

@Suite("AXDepthPolicy")
struct AXDepthPolicyTests {
    @Test("a walk starts shallow unless the full tree was asked for")
    func startingDepth() {
        #expect(AXDepthPolicy.startingDepth(fullTreeRequested: false) == AXDepthPolicy.initialDepth)
        #expect(AXDepthPolicy.startingDepth(fullTreeRequested: true) == AXDepthPolicy.fullDepth)
        #expect(AXDepthPolicy.initialDepth < AXDepthPolicy.fullDepth)
    }

    @Test("a cut-off walk with nothing to act on goes to full depth")
    func deepensWhenEmptyAndTruncated() {
        #expect(AXDepthPolicy.retryDepth(after: AXDepthPolicy.initialDepth, truncated: true, interactiveCount: 0) == AXDepthPolicy.fullDepth)
    }

    @Test("a walk that found something, or was not cut off, is kept")
    func keepsUsefulOrCompleteWalks() {
        #expect(AXDepthPolicy.retryDepth(after: AXDepthPolicy.initialDepth, truncated: true, interactiveCount: 3) == nil)
        #expect(AXDepthPolicy.retryDepth(after: AXDepthPolicy.initialDepth, truncated: false, interactiveCount: 0) == nil)
        #expect(AXDepthPolicy.retryDepth(after: AXDepthPolicy.fullDepth, truncated: true, interactiveCount: 0) == nil)
    }

    @Test("only a JSON true asks for the full tree")
    func readsFullTreeFlag() {
        #expect(AXDepthPolicy.fullTreeRequested(from: NSNumber(value: true)))
        #expect(AXDepthPolicy.fullTreeRequested(from: NSNumber(value: false)) == false)
        #expect(AXDepthPolicy.fullTreeRequested(from: NSNumber(value: 1)) == false)
        #expect(AXDepthPolicy.fullTreeRequested(from: "true") == false)
        #expect(AXDepthPolicy.fullTreeRequested(from: nil) == false)
    }
}
