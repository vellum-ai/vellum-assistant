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
                        text: "truncated arguments preview",
                        toolName: "search_web",
                        data: AnyCodable([
                            "query": "docs",
                            "limit": 3,
                            "filters": [
                                "lang": "en"
                            ]
                        ])
                    ),
                    LLMContextSection(
                        kind: .functionResponse,
                        label: "Response tool result 1",
                        role: "assistant",
                        text: "truncated result preview",
                        toolName: "search_web",
                        data: AnyCodable([
                            "results": [
                                "docs",
                                "reference"
                            ]
                        ])
                    )
                ]
            )
        )

        XCTAssertTrue(model.hasNormalizedSections)
        XCTAssertEqual(model.responseStopReason, "tool_calls")
        XCTAssertEqual(model.responseModeLabel, "Tool-calling response")
        XCTAssertEqual(model.sections.count, 3)

        XCTAssertEqual(model.sections[0].presentationKind, .assistantText)
        XCTAssertEqual(model.sections[0].title, "Assistant response")
        XCTAssertEqual(model.sections[0].kindLabel, "Assistant text")
        XCTAssertEqual(model.sections[0].bodyText, "Hello there!")
        XCTAssertEqual(model.sections[0].copyText, "Hello there!")

        XCTAssertEqual(model.sections[1].presentationKind, .toolCall)
        XCTAssertEqual(model.sections[1].toolName, "search_web")
        XCTAssertEqual(model.sections[1].kindLabel, "Tool call")
        XCTAssertEqual(model.sections[1].bodyText, """
        {
          "filters" : {
            "lang" : "en"
          },
          "limit" : 3,
          "query" : "docs"
        }
        """)
        XCTAssertEqual(model.sections[1].copyText, model.sections[1].bodyText)
        XCTAssertTrue(model.sections[1].showsRawPayloadHint)

        XCTAssertEqual(model.sections[2].presentationKind, .other)
        XCTAssertEqual(model.sections[2].kindLabel, "Function response")
        XCTAssertEqual(model.sections[2].bodyText, """
        {
          "results" : [
            "docs",
            "reference"
          ]
        }
        """)
        XCTAssertEqual(model.sections[2].copyText, model.sections[2].bodyText)
    }

    func testResponseTabModelDerivesTextOnlyMetadataForAssistantTextOnlySections() {
        let model = MessageInspectorResponseTabModel(
            entry: makeEntry(
                responsePayload: AnyCodable([
                    "text": "A normalized assistant response"
                ]),
                summary: LLMCallSummary(
                    stopReason: "end_turn"
                ),
                responseSections: [
                    LLMContextSection(
                        kind: .assistant,
                        label: "Assistant response",
                        role: "assistant",
                        text: "A normalized assistant response"
                    )
                ]
            )
        )

        XCTAssertTrue(model.hasNormalizedSections)
        XCTAssertEqual(model.responseStopReason, "end_turn")
        XCTAssertEqual(model.responseModeLabel, "Text-only response")
        XCTAssertEqual(model.sections.count, 1)
    }

    func testResponseTabModelLabelsResultOnlySectionsAsResultOnlyResponse() {
        let model = MessageInspectorResponseTabModel(
            entry: makeEntry(
                responsePayload: AnyCodable([
                    "stop_reason": "function_response"
                ]),
                summary: LLMCallSummary(
                    stopReason: "function_response"
                ),
                responseSections: [
                    LLMContextSection(
                        kind: .toolResult,
                        label: "Tool result 1",
                        role: "assistant",
                        text: "result preview",
                        toolName: "search_web",
                        data: AnyCodable([
                            "results": [
                                "docs"
                            ]
                        ])
                    ),
                    LLMContextSection(
                        kind: .functionResponse,
                        label: "Function response 1",
                        role: "assistant",
                        text: "function response preview",
                        toolName: "search_web",
                        data: AnyCodable([
                            "status": "ok"
                        ])
                    )
                ]
            )
        )

        XCTAssertTrue(model.hasNormalizedSections)
        XCTAssertEqual(model.responseStopReason, "function_response")
        XCTAssertEqual(model.responseModeLabel, "Result-only response")
        XCTAssertEqual(model.sections.count, 2)
        XCTAssertEqual(model.sections[0].presentationKind, .other)
        XCTAssertEqual(model.sections[1].presentationKind, .other)
    }

    func testResponseTabModelDoesNotCallMixedAssistantTextAndResultSectionsTextOnly() {
        let model = MessageInspectorResponseTabModel(
            entry: makeEntry(
                responsePayload: AnyCodable([
                    "stop_reason": "function_response"
                ]),
                summary: LLMCallSummary(
                    stopReason: "function_response"
                ),
                responseSections: [
                    LLMContextSection(
                        kind: .assistant,
                        label: "Assistant response",
                        role: "assistant",
                        text: "Normalized assistant text"
                    ),
                    LLMContextSection(
                        kind: .functionResponse,
                        label: "Function response 1",
                        role: "assistant",
                        text: "function response preview",
                        toolName: "search_web",
                        data: AnyCodable([
                            "status": "ok"
                        ])
                    )
                ]
            )
        )

        XCTAssertTrue(model.hasNormalizedSections)
        XCTAssertNil(model.responseModeLabel)
        XCTAssertEqual(model.sections.count, 2)
    }

    func testResponseTabModelTreatsReasoningSectionsAsDistinctFromAssistantText() {
        let model = MessageInspectorResponseTabModel(
            entry: makeEntry(
                responsePayload: AnyCodable([
                    "reasoning": "Thinking it through"
                ]),
                responseSections: [
                    LLMContextSection(
                        kind: .reasoning,
                        label: "Reasoning",
                        role: "assistant",
                        text: "Thinking it through"
                    )
                ]
            )
        )

        XCTAssertTrue(model.hasNormalizedSections)
        XCTAssertFalse(model.hasResponseMetadata)
        XCTAssertNil(model.responseModeLabel)
        XCTAssertNil(model.responseStopReason)
        XCTAssertEqual(model.sections.count, 1)
        XCTAssertEqual(model.sections[0].presentationKind, .reasoning)
        XCTAssertEqual(model.sections[0].kindLabel, "Reasoning")
        XCTAssertEqual(model.sections[0].bodyText, "Thinking it through")
    }

    func testResponseTabModelUsesExplicitSummaryToolCallCountForToolCalling() {
        let model = MessageInspectorResponseTabModel(
            entry: makeEntry(
                responsePayload: AnyCodable([
                    "stop_reason": "function_response"
                ]),
                summary: LLMCallSummary(
                    stopReason: "function_response",
                    responseToolCallCount: 1
                ),
                responseSections: [
                    LLMContextSection(
                        kind: .toolResult,
                        label: "Tool result 1",
                        role: "assistant",
                        text: "result preview",
                        toolName: "search_web",
                        data: AnyCodable([
                            "results": [
                                "docs"
                            ]
                        ])
                    )
                ]
            )
        )

        XCTAssertTrue(model.hasNormalizedSections)
        XCTAssertEqual(model.responseStopReason, "function_response")
        XCTAssertEqual(model.responseModeLabel, "Tool-calling response")
        XCTAssertEqual(model.sections.count, 1)
        XCTAssertEqual(model.sections[0].presentationKind, .other)
    }

    func testResponseTabModelPreservesSummaryMetadataWithoutNormalizedSections() {
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
        XCTAssertTrue(model.hasResponseMetadata)
        XCTAssertTrue(model.sections.isEmpty)
        XCTAssertNil(model.responseModeLabel)
        XCTAssertEqual(model.responseStopReason, "end_turn")
        XCTAssertEqual(
            model.fallbackMessage,
            "This response has no rendered sections. Raw payloads remain available in the Raw tab, and any normalized response metadata will still be shown when present."
        )
    }

    func testResponseTabModelShowsToolCallingMetadataWithoutNormalizedSections() {
        let model = MessageInspectorResponseTabModel(
            entry: makeEntry(
                responsePayload: AnyCodable([
                    "stop_reason": "tool_calls"
                ]),
                summary: LLMCallSummary(
                    stopReason: "tool_calls",
                    responseToolCallCount: 1
                ),
                responseSections: nil
            )
        )

        XCTAssertFalse(model.hasNormalizedSections)
        XCTAssertTrue(model.hasResponseMetadata)
        XCTAssertTrue(model.sections.isEmpty)
        XCTAssertEqual(model.responseStopReason, "tool_calls")
        XCTAssertEqual(model.responseModeLabel, "Tool-calling response")
        XCTAssertEqual(
            model.fallbackMessage,
            "This response has no rendered sections. Raw payloads remain available in the Raw tab, and any normalized response metadata will still be shown when present."
        )
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
