import Foundation
import Testing

@testable import MacHelperCore

@Suite("ObservationCapture")
struct ObservationCaptureTests {
    @Test("a requested screenshot runs beside the walk")
    func requested() {
        #expect(ObservationCapture.plan(includeScreenshot: true, scoped: false) == .besideWalk)
    }

    @Test("an opt-out with no scope captures only when there is no tree")
    func optOutUnscoped() {
        #expect(ObservationCapture.plan(includeScreenshot: false, scoped: false) == .onlyWithoutTree)
    }

    @Test("a scoped observation captures even when the daemon opts out")
    func scopedAlwaysCaptures() {
        #expect(ObservationCapture.plan(includeScreenshot: false, scoped: true) == .besideWalk)
        #expect(ObservationCapture.plan(includeScreenshot: true, scoped: true) == .besideWalk)
    }

    @Test("an absent flag keeps the screenshot")
    func absentFlag() {
        #expect(ObservationCapture.includeScreenshot(from: nil))
    }

    @Test("a JSON boolean is honored")
    func jsonBoolean() throws {
        let decoded = try #require(
            JSONSerialization.jsonObject(with: Data(#"{"off":false,"on":true}"#.utf8)) as? [String: Any]
        )
        #expect(ObservationCapture.includeScreenshot(from: decoded["off"]) == false)
        #expect(ObservationCapture.includeScreenshot(from: decoded["on"]))
    }

    @Test("a value that is not a boolean keeps the screenshot")
    func nonBoolean() throws {
        let decoded = try #require(
            JSONSerialization.jsonObject(with: Data(#"{"zero":0,"text":"false","none":null}"#.utf8)) as? [String: Any]
        )
        #expect(ObservationCapture.includeScreenshot(from: decoded["zero"]))
        #expect(ObservationCapture.includeScreenshot(from: decoded["text"]))
        #expect(ObservationCapture.includeScreenshot(from: decoded["none"]))
    }

    @Test("a deferred capture is taken when the walk finds no tree")
    func deferredCaptureWithNoTree() {
        #expect(ObservationCapture.onlyWithoutTree.captureAfterWalk(treeFound: false))
    }

    @Test("a deferred capture is skipped whenever a tree exists, however sparse")
    func deferredCaptureSkippedWithAnyTree() {
        // Whether a sparse tree is enough is the assistant's call, made by
        // asking for a screenshot, not a count the helper applies for it.
        #expect(ObservationCapture.onlyWithoutTree.captureAfterWalk(treeFound: true) == false)
    }

    @Test("a capture that already ran beside the walk is never taken again")
    func besideWalkNeverCapturesTwice() {
        #expect(ObservationCapture.besideWalk.captureAfterWalk(treeFound: false) == false)
        #expect(ObservationCapture.besideWalk.captureAfterWalk(treeFound: true) == false)
    }
}
