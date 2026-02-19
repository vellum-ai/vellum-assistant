import XCTest
@testable import VellumAssistantLib

final class ActionVerifierTests: XCTestCase {
    var verifier: ActionVerifier!

    override func setUp() {
        verifier = ActionVerifier(maxSteps: 50)
    }

    // MARK: - Loop Detection

    func testLoopDetection_threeIdenticalActions_blocked() {
        let action = AgentAction(type: .click, reasoning: "test", x: 100, y: 200)

        let result1 = verifier.verify(action)
        XCTAssertEqual(isAllowed(result1), true, "First action should be allowed")

        let result2 = verifier.verify(action)
        XCTAssertEqual(isAllowed(result2), true, "Second identical action should be allowed")

        let result3 = verifier.verify(action)
        XCTAssertEqual(isBlocked(result3), true, "Third identical consecutive action should be blocked")
    }

    func testLoopDetection_differentActions_allowed() {
        let action1 = AgentAction(type: .click, reasoning: "test", x: 100, y: 200)
        let action2 = AgentAction(type: .click, reasoning: "test", x: 300, y: 400)

        _ = verifier.verify(action1)
        _ = verifier.verify(action2)
        let result = verifier.verify(action1)
        XCTAssertEqual(isAllowed(result), true, "Non-consecutive identical actions should be allowed")
    }

    func testLoopDetection_alternatingPattern_blocked() {
        let a = AgentAction(type: .click, reasoning: "test", x: 100, y: 200)
        let b = AgentAction(type: .click, reasoning: "test", x: 300, y: 400)

        XCTAssertEqual(isAllowed(verifier.verify(a)), true)
        XCTAssertEqual(isAllowed(verifier.verify(b)), true)
        XCTAssertEqual(isAllowed(verifier.verify(a)), true)
        // Fourth action completes the A-B-A-B cycle
        XCTAssertEqual(isBlocked(verifier.verify(b)), true, "Alternating A-B-A-B pattern should be blocked")
    }

    func testLoopDetection_length3Cycle_blocked() {
        let a = AgentAction(type: .click, reasoning: "test", x: 100, y: 200)
        let b = AgentAction(type: .key, reasoning: "test", key: "tab")
        let c = AgentAction(type: .click, reasoning: "test", x: 300, y: 400)

        XCTAssertEqual(isAllowed(verifier.verify(a)), true)
        XCTAssertEqual(isAllowed(verifier.verify(b)), true)
        XCTAssertEqual(isAllowed(verifier.verify(c)), true)
        XCTAssertEqual(isAllowed(verifier.verify(a)), true)
        XCTAssertEqual(isAllowed(verifier.verify(b)), true)
        // Sixth action completes A-B-C-A-B-C
        XCTAssertEqual(isBlocked(verifier.verify(c)), true, "Length-3 cycle A-B-C-A-B-C should be blocked")
    }

    func testLoopDetection_nearIdenticalClicks_blocked() {
        // Same target but coordinates differ by less than 5px
        let click1 = AgentAction(type: .click, reasoning: "test", x: 100, y: 200)
        let click2 = AgentAction(type: .click, reasoning: "test", x: 103, y: 198)
        let click3 = AgentAction(type: .click, reasoning: "test", x: 101, y: 202)

        XCTAssertEqual(isAllowed(verifier.verify(click1)), true)
        XCTAssertEqual(isAllowed(verifier.verify(click2)), true)
        XCTAssertEqual(isBlocked(verifier.verify(click3)), true,
                       "Near-identical clicks (within 5px) should be treated as same action")
    }

    func testLoopDetection_farApartClicks_allowed() {
        // Coordinates differ by more than 5px — not a loop
        let click1 = AgentAction(type: .click, reasoning: "test", x: 100, y: 200)
        let click2 = AgentAction(type: .click, reasoning: "test", x: 110, y: 200)
        let click3 = AgentAction(type: .click, reasoning: "test", x: 120, y: 200)

        XCTAssertEqual(isAllowed(verifier.verify(click1)), true)
        XCTAssertEqual(isAllowed(verifier.verify(click2)), true)
        XCTAssertEqual(isAllowed(verifier.verify(click3)), true,
                       "Clicks more than 5px apart should not be treated as a loop")
    }

    func testLoopDetection_nearIdenticalAlternating_blocked() {
        // Alternating near-identical clicks on two targets
        let a1 = AgentAction(type: .click, reasoning: "test", x: 100, y: 200)
        let b1 = AgentAction(type: .click, reasoning: "test", x: 300, y: 400)
        let a2 = AgentAction(type: .click, reasoning: "test", x: 102, y: 198)
        let b2 = AgentAction(type: .click, reasoning: "test", x: 301, y: 403)

        XCTAssertEqual(isAllowed(verifier.verify(a1)), true)
        XCTAssertEqual(isAllowed(verifier.verify(b1)), true)
        XCTAssertEqual(isAllowed(verifier.verify(a2)), true)
        XCTAssertEqual(isBlocked(verifier.verify(b2)), true,
                       "Near-identical alternating clicks should be detected as a loop")
    }

    // MARK: - Credit Card Detection

    func testSensitiveData_creditCard_blocked() {
        let action1 = AgentAction(type: .type, reasoning: "test", text: "4111111111111111")
        XCTAssertEqual(isBlocked(verifier.verify(action1)), true, "Raw credit card should be blocked")

        let verifier2 = ActionVerifier()
        let action2 = AgentAction(type: .type, reasoning: "test", text: "4111 1111 1111 1111")
        XCTAssertEqual(isBlocked(verifier2.verify(action2)), true, "Spaced credit card should be blocked")

        let verifier3 = ActionVerifier()
        let action3 = AgentAction(type: .type, reasoning: "test", text: "4111-1111-1111-1111")
        XCTAssertEqual(isBlocked(verifier3.verify(action3)), true, "Dashed credit card should be blocked")
    }

    // MARK: - SSN Detection

    func testSensitiveData_ssn_blocked() {
        let action = AgentAction(type: .type, reasoning: "test", text: "123-45-6789")
        XCTAssertEqual(isBlocked(verifier.verify(action)), true, "SSN should be blocked")

        let verifier2 = ActionVerifier()
        let action2 = AgentAction(type: .type, reasoning: "test", text: "123456789")
        // 9 digits without dashes is also SSN
        XCTAssertEqual(isBlocked(verifier2.verify(action2)), true, "SSN without dashes should be blocked")
    }

    // MARK: - Password Detection

    func testSensitiveData_password_blocked() {
        let action = AgentAction(type: .type, reasoning: "test", text: "P@ssw0rd!")
        XCTAssertEqual(isBlocked(verifier.verify(action)), true, "Complex password should be blocked")
    }

    // MARK: - Normal Text Allowed

    func testNormalText_allowed() {
        let action1 = AgentAction(type: .type, reasoning: "test", text: "John Smith")
        XCTAssertEqual(isAllowed(verifier.verify(action1)), true, "Normal name should be allowed")

        let verifier2 = ActionVerifier()
        let action2 = AgentAction(type: .type, reasoning: "test", text: "hello@example.com")
        XCTAssertEqual(isAllowed(verifier2.verify(action2)), true, "Email should be allowed")
    }

    func testNaturalLanguage_notFlaggedAsPassword() {
        // Sentences with mixed case, digits, and spaces were false-positiving
        let sentences = [
            "Focus Time at 3 PM for 1 hour",
            "Meeting with Bob at 2 PM tomorrow",
            "Buy 3 apples from Trader Joe's",
            "Deploy version 2.1 to Production",
            "Call Dr. Smith at 4 PM on Friday",
        ]
        for sentence in sentences {
            let v = ActionVerifier()
            let action = AgentAction(type: .type, reasoning: "test", text: sentence)
            XCTAssertEqual(isAllowed(v.verify(action)), true, "Natural language should be allowed: \"\(sentence)\"")
        }
    }

    func testActualPasswords_stillBlocked() {
        let passwords = [
            "P@ssw0rd!",
            "MyS3cur3!Pass",
            "hunter2!Ab",
        ]
        for pw in passwords {
            let v = ActionVerifier()
            let action = AgentAction(type: .type, reasoning: "test", text: pw)
            XCTAssertEqual(isBlocked(v.verify(action)), true, "Password should be blocked: \"\(pw)\"")
        }
    }

    // MARK: - System Menu Bar

    func testSystemMenuBar_blocked() {
        let action = AgentAction(type: .click, reasoning: "test", x: 100, y: 10)
        XCTAssertEqual(isBlocked(verifier.verify(action)), true, "Click in menu bar (y < 25) should be blocked")
    }

    func testBelowMenuBar_allowed() {
        let action = AgentAction(type: .click, reasoning: "test", x: 100, y: 30)
        XCTAssertEqual(isAllowed(verifier.verify(action)), true, "Click below menu bar should be allowed")
    }

    // MARK: - Step Limit

    func testStepLimit_enforced() {
        let smallVerifier = ActionVerifier(maxSteps: 3)

        for i in 0..<3 {
            let action = AgentAction(type: .click, reasoning: "step \(i)", x: CGFloat(100 + i * 50), y: 200)
            _ = smallVerifier.verify(action)
        }

        let overLimit = AgentAction(type: .click, reasoning: "over limit", x: 500, y: 200)
        XCTAssertEqual(isBlocked(smallVerifier.verify(overLimit)), true, "Should be blocked after step limit")
    }

    // MARK: - Destructive Keys

    func testDestructiveKey_needsConfirmation() {
        let action = AgentAction(type: .key, reasoning: "test", key: "cmd+q")
        let result = verifier.verify(action)
        XCTAssertEqual(isNeedsConfirmation(result), true, "Cmd+Q should need confirmation")
    }

    // MARK: - Form Submission

    func testFormSubmission_enterAfterType_needsConfirmation() {
        let typeAction = AgentAction(type: .type, reasoning: "typing", text: "test@email.com")
        _ = verifier.verify(typeAction)

        let enterAction = AgentAction(type: .key, reasoning: "submit", key: "enter")
        let result = verifier.verify(enterAction)
        XCTAssertEqual(isNeedsConfirmation(result), true, "Enter after type should need confirmation")
    }

    // MARK: - Helpers

    private func isAllowed(_ result: VerifyResult) -> Bool {
        if case .allowed = result { return true }
        return false
    }

    private func isBlocked(_ result: VerifyResult) -> Bool {
        if case .blocked = result { return true }
        return false
    }

    private func isNeedsConfirmation(_ result: VerifyResult) -> Bool {
        if case .needsConfirmation = result { return true }
        return false
    }
}
