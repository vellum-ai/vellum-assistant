import XCTest
@testable import VellumAssistantShared

final class MessageClientTimezoneTests: XCTestCase {
    func testMessageBodyIncludesLocalTimezoneAndExistingHostFields() {
        let body = MessageClient.messageBody(
            content: "Hello",
            conversationKey: "conversation-123",
            attachmentIds: ["attachment-123"],
            conversationType: "manual",
            automated: true,
            bypassSecretCheck: true,
            clientMessageId: "message-123",
            inferenceProfile: "balanced",
            riskThreshold: "medium"
        )

        let expectedTimezone = TimeZone.autoupdatingCurrent.identifier
        XCTAssertFalse(expectedTimezone.isEmpty)
        XCTAssertEqual(MessageClient.clientTimezone, expectedTimezone)
        XCTAssertEqual(body["clientTimezone"] as? String, expectedTimezone)

        XCTAssertEqual(body["conversationKey"] as? String, "conversation-123")
        XCTAssertEqual(body["content"] as? String, "Hello")
        XCTAssertEqual(body["sourceChannel"] as? String, "vellum")
        XCTAssertEqual(body["interface"] as? String, "macos")
        XCTAssertEqual(body["hostHomeDir"] as? String, NSHomeDirectory())
        XCTAssertEqual(body["hostUsername"] as? String, NSUserName())
        XCTAssertEqual(body["attachmentIds"] as? [String], ["attachment-123"])
        XCTAssertEqual(body["conversationType"] as? String, "manual")
        XCTAssertEqual(body["automated"] as? Bool, true)
        XCTAssertEqual(body["bypassSecretCheck"] as? Bool, true)
        XCTAssertEqual(body["clientMessageId"] as? String, "message-123")
        XCTAssertEqual(body["inferenceProfile"] as? String, "balanced")
        XCTAssertEqual(body["riskThreshold"] as? String, "medium")
    }

    func testMessageBodyOmitsEmptyTimezone() {
        let body = MessageClient.messageBody(
            content: "Hello",
            conversationKey: "conversation-123",
            clientTimezone: ""
        )

        XCTAssertNil(body["clientTimezone"])
        XCTAssertEqual(body["sourceChannel"] as? String, "vellum")
        XCTAssertEqual(body["interface"] as? String, "macos")
        XCTAssertEqual(body["hostHomeDir"] as? String, NSHomeDirectory())
        XCTAssertEqual(body["hostUsername"] as? String, NSUserName())
    }
}
