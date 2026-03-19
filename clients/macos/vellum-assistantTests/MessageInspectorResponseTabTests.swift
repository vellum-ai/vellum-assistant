import XCTest

@testable import VellumAssistantLib
@testable import VellumAssistantShared

final class MessageInspectorResponseTabTests: XCTestCase {
    func testResponseTabModelSeparatesAssistantTextAndToolCalls() {
        let model = MessageInspectorResponseTabModel(
            entry: makeEntry(
                responsePayload: AnyCodable([
                    "choices": [
                        [
                            "finish_reason": "tool_calls",
                            "message": [
                                "role": "assistant",
                                "content": "Hello there!",
                                "tool_calls": [
                                    [
                                        "function": [
                                            "name": "search_web",
                                            "arguments": "{\"query\":\"docs\",\"limit\":3}"
                                        ]
                                    ]
                                ]
                            ]
                        ]
                    ]
                ]),
                responseSections: [
                    LLMContextSection(
                        kind: .unknown("message"),
                        title: "Assistant response",
                        content: AnyCodable("Hello there!"),
                        language: "text"
                    ),
                    LLMContextSection(
                        kind: .unknown("function_call"),
                        title: "Response tool call 1",
                        content: AnyCodable([
                            "query": "docs",
                            "limit": 3
                        ]),
                        language: "json"
                    )
                ]
            )
        )

        XCTAssertTrue(model.hasNormalizedSections)
        XCTAssertEqual(model.responseModeLabel, "Tool-calling response")
        XCTAssertEqual(model.stopReason, "tool_calls")
        XCTAssertEqual(model.sections.count, 2)

        XCTAssertEqual(model.sections[0].presentationKind, .assistantText)
        XCTAssertEqual(model.sections[0].title, "Assistant response")
        XCTAssertEqual(model.sections[0].bodyText, "Hello there!")
        XCTAssertEqual(model.sections[0].copyText, "Hello there!")

        XCTAssertEqual(model.sections[1].presentationKind, .toolCall)
        XCTAssertEqual(model.sections[1].toolName, "search_web")
        XCTAssertEqual(model.sections[1].kindLabel, "Tool call")
        XCTAssertTrue(model.sections[1].bodyText?.contains("\"query\"") ?? false)
        XCTAssertTrue(model.sections[1].bodyText?.contains("\"docs\"") ?? false)
        XCTAssertEqual(model.sections[1].copyText, model.sections[1].bodyText)
        XCTAssertTrue(model.sections[1].showsRawPayloadHint)
    }

    func testResponseTabModelFallsBackWithoutNormalizedSections() {
        let model = MessageInspectorResponseTabModel(
            entry: makeEntry(
                responsePayload: AnyCodable([
                    "stop_reason": "end_turn"
                ]),
                responseSections: nil
            )
        )

        XCTAssertFalse(model.hasNormalizedSections)
        XCTAssertTrue(model.sections.isEmpty)
        XCTAssertEqual(model.stopReason, "end_turn")
        XCTAssertEqual(model.fallbackMessage, "This provider response has not been normalized yet. Open the Raw tab to inspect the full provider payload.")
    }

    private func makeEntry(
        responsePayload: AnyCodable,
        responseSections: [LLMContextSection]?
    ) -> LLMRequestLogEntry {
        LLMRequestLogEntry(
            id: "log-1",
            requestPayload: AnyCodable(["type": "request"]),
            responsePayload: responsePayload,
            createdAt: 1_000,
            summary: nil,
            requestSections: nil,
            responseSections: responseSections
        )
    }
}
