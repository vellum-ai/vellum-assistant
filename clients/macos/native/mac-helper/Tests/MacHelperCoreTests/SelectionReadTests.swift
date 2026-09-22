import ApplicationServices
import Testing

@testable import MacHelperCore

@Test func chromiumAccessibilityUsesChromeFallback() {
    var attributes: [String] = []
    let result = ChromiumAccessibility.enable { attribute in
        attributes.append(attribute)
        return attribute == "AXManualAccessibility" ? .attributeUnsupported : .success
    }
    #expect(attributes == ["AXManualAccessibility", "AXEnhancedUserInterface"])
    #expect(result == .success)
}

@Test func chromiumAccessibilityPreservesElectronManualMode() {
    var attributes: [String] = []
    let result = ChromiumAccessibility.enable { attribute in
        attributes.append(attribute)
        return .success
    }
    #expect(attributes == ["AXManualAccessibility"])
    #expect(result == .success)
}

@Test func chromiumAccessibilityReportsFailedActivation() {
    let result = ChromiumAccessibility.enable { _ in .cannotComplete }
    #expect(result == .cannotComplete)
}

@Test func selectionRetryIsBoundToOriginalAppAndHold() {
    var session = SelectionReadSession()
    #expect(session.token(processId: 100, expected: nil) == nil)
    session.begin(processId: 100)
    let first = session.token(processId: 100, expected: nil)
    #expect(first != nil)
    #expect(session.token(processId: 100, expected: first) == first)
    #expect(session.token(processId: 200, expected: first) == nil)
    #expect(session.token(processId: nil, expected: first) == nil)
    session.end()
    #expect(session.token(processId: 100, expected: first) == nil)
    session.begin(processId: 100)
    #expect(session.token(processId: 100, expected: first) == nil)
    #expect(session.token(processId: 100, expected: nil) != first)
}
