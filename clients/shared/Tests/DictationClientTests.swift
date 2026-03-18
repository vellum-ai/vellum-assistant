import XCTest

@testable import VellumAssistantShared

@MainActor
final class DictationClientTests: XCTestCase {
    private let client = DictationClient()

    func testFallbackResponseUsesActionModeForActionVerb() {
        let request = DictationRequest(
            transcription: "open Slack",
            context: .create(
                bundleIdentifier: "com.apple.TextEdit",
                appName: "TextEdit",
                windowTitle: "Untitled",
                selectedText: nil,
                cursorInTextField: false
            )
        )

        let response = client.fallbackResponse(for: request, errorMessage: "offline")

        XCTAssertEqual(response.type, "dictation_response")
        XCTAssertEqual(response.mode, "action")
        XCTAssertEqual(response.text, "open Slack")
        XCTAssertEqual(response.actionPlan, "User wants to: open Slack")
    }

    func testFallbackResponsePreservesSelectedTextForCommandMode() {
        let request = DictationRequest(
            transcription: "make this shorter",
            context: .create(
                bundleIdentifier: "com.apple.TextEdit",
                appName: "TextEdit",
                windowTitle: "Untitled",
                selectedText: "Original selected text",
                cursorInTextField: true
            )
        )

        let response = client.fallbackResponse(for: request, errorMessage: "offline")

        XCTAssertEqual(response.mode, "command")
        XCTAssertEqual(response.text, "Original selected text")
        XCTAssertNil(response.actionPlan)
    }

    func testFallbackResponseDefaultsToDictationMode() {
        let request = DictationRequest(
            transcription: "hello there",
            context: .create(
                bundleIdentifier: "com.apple.TextEdit",
                appName: "TextEdit",
                windowTitle: "Untitled",
                selectedText: nil,
                cursorInTextField: true
            )
        )

        let response = client.fallbackResponse(for: request, errorMessage: "offline")

        XCTAssertEqual(response.mode, "dictation")
        XCTAssertEqual(response.text, "hello there")
        XCTAssertNil(response.actionPlan)
    }
}
