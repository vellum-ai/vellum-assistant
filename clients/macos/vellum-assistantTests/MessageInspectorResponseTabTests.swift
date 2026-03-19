import XCTest

@testable import VellumAssistantLib
@testable import VellumAssistantShared

final class MessageInspectorResponseTabTests: XCTestCase {
    func testResponseTabModelUsesNormalizedResponseSectionsAndSummaryFields() {
        let model = MessageInspectorResponseTabModel(
            entry: makeEntry(
                responsePayload: AnyCodable([
                    "choices": [
                        [
                            "finish_reason": "stop",
                            "message": [
                                "role": "assistant",
                                "content": "Raw payload should not win",
                                "tool_calls": [
                                    [
                                        "function": [
                                            "name": "wrong_tool_name",
                                            "arguments": "{\"query\":\"wrong\"}"
                                        ]
                                    ]
                                ]
                            ]
                        ]
                    ]
                ]),
                summary: LLMCallSummary(
                    stopReason: "tool_calls",
                    responseToolCallCount: 1
                ),
                responseSections: [
                    LLMContextSection(
                        kind: .message,
                        label: "Assistant response",
                        role: "assistant",
                        text: "Hello there!"
                    ),
                    LLMContextSection(
                        kind: .functionCall,
                        label: "Response tool call 1",
                        role: "assistant",
                        text: "{\"query\":\"docs\",\"limit\":3}",
                        toolName: "search_web",
                        data: AnyCodable([
                            "query": "docs",
                            "limit": 3
                        ])
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
                    "stop_reason": "tool_use"
                ]),
                summary: LLMCallSummary(stopReason: "end_turn"),
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
        summary: LLMCallSummary? = nil,
        responseSections: [LLMContextSection]?
    ) -> LLMRequestLogEntry {
        LLMRequestLogEntry(
            id: "log-1",
            requestPayload: AnyCodable(["type": "request"]),
            responsePayload: responsePayload,
            createdAt: 1_000,
            summary: summary,
            requestSections: nil,
            responseSections: responseSections
        )
    }
}
