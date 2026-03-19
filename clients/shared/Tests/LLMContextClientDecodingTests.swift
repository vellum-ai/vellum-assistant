import Foundation
import XCTest

@testable import VellumAssistantShared

final class LLMContextClientDecodingTests: XCTestCase {
    func testLegacyPayloadDecodesWithoutNormalizedFields() throws {
        let response = try decodeResponse(
            #"""
            {
              "messageId": "msg-legacy",
              "logs": [
                {
                  "id": "log-1",
                  "requestPayload": {
                    "type": "request",
                    "messages": []
                  },
                  "responsePayload": {
                    "type": "response",
                    "text": "ok"
                  },
                  "createdAt": 1234567890
                }
              ]
            }
            """#
        )

        XCTAssertEqual(response.messageId, "msg-legacy")
        XCTAssertEqual(response.logs.count, 1)

        let entry = response.logs[0]
        XCTAssertEqual(entry.id, "log-1")
        XCTAssertEqual(entry.createdAt, 1234567890)
        XCTAssertNil(entry.summary)
        XCTAssertNil(entry.requestSections)
        XCTAssertNil(entry.responseSections)
    }

    func testAssistantEmittedOpenAiSectionsDecodeWithStructuredFieldsIntact() throws {
        let response = try decodeResponse(
            #"""
            {
              "messageId": "msg-openai",
              "logs": [
                {
                  "id": "log-openai",
                  "requestPayload": {
                    "model": "gpt-4.1",
                    "messages": [{ "role": "user", "content": "Hello" }]
                  },
                  "responsePayload": {
                    "model": "gpt-4.1-2026-03-01",
                    "choices": [{ "finish_reason": "tool_calls" }]
                  },
                  "createdAt": 2233445566,
                  "summary": {
                    "provider": "openai",
                    "model": "gpt-4.1-2026-03-01",
                    "inputTokens": 42,
                    "outputTokens": 17,
                    "stopReason": "tool_calls",
                    "requestMessageCount": 1,
                    "requestToolCount": 2,
                    "responseMessageCount": 1,
                    "responseToolCallCount": 1,
                    "responsePreview": "Hi there",
                    "toolCallNames": ["search_web"]
                  },
                  "requestSections": [
                    {
                      "kind": "system",
                      "label": "System prompt",
                      "role": "system",
                      "text": "You are helpful"
                    },
                    {
                      "kind": "tool_definitions",
                      "label": "Available tools",
                      "text": "search_web, lookup_docs"
                    }
                  ],
                  "responseSections": [
                    {
                      "kind": "message",
                      "label": "Assistant response",
                      "role": "assistant",
                      "text": "Hi there"
                    },
                    {
                      "kind": "function_call",
                      "label": "Response tool call 1",
                      "role": "assistant",
                      "toolName": "search_web",
                      "text": "{\"query\":\"docs\"}",
                      "data": {
                        "query": "docs"
                      }
                    }
                  ]
                }
              ]
            }
            """#
        )

        let entry = try XCTUnwrap(response.logs.first)
        let summary = try XCTUnwrap(entry.summary)
        XCTAssertEqual(summary.provider, "openai")
        XCTAssertEqual(summary.model, "gpt-4.1-2026-03-01")
        XCTAssertEqual(summary.inputTokens, 42)
        XCTAssertEqual(summary.outputTokens, 17)
        XCTAssertEqual(summary.stopReason, "tool_calls")
        XCTAssertEqual(summary.toolCallNames, ["search_web"])

        let requestSections = try XCTUnwrap(entry.requestSections)
        XCTAssertEqual(requestSections.count, 2)
        XCTAssertEqual(requestSections[0].kind, .system)
        XCTAssertEqual(requestSections[0].label, "System prompt")
        XCTAssertEqual(requestSections[0].role, "system")
        XCTAssertEqual(requestSections[0].text, "You are helpful")
        XCTAssertNil(requestSections[0].toolName)
        XCTAssertNil(requestSections[0].data)

        XCTAssertEqual(requestSections[1].kind, .toolDefinitions)
        XCTAssertEqual(requestSections[1].label, "Available tools")
        XCTAssertEqual(requestSections[1].text, "search_web, lookup_docs")

        let responseSections = try XCTUnwrap(entry.responseSections)
        XCTAssertEqual(responseSections.count, 2)
        XCTAssertEqual(responseSections[0].kind, .message)
        XCTAssertEqual(responseSections[0].label, "Assistant response")
        XCTAssertEqual(responseSections[0].role, "assistant")
        XCTAssertEqual(responseSections[0].text, "Hi there")

        XCTAssertEqual(responseSections[1].kind, .functionCall)
        XCTAssertEqual(responseSections[1].label, "Response tool call 1")
        XCTAssertEqual(responseSections[1].role, "assistant")
        XCTAssertEqual(responseSections[1].text, "{\"query\":\"docs\"}")
        XCTAssertEqual(responseSections[1].toolName, "search_web")
        XCTAssertEqual(responseSections[1].data, AnyCodable(["query": "docs"]))
    }

    func testAssistantEmittedAnthropicAndGeminiKindsDecodeWithoutCollapsingFields() throws {
        let response = try decodeResponse(
            #"""
            {
              "messageId": "msg-mixed",
              "logs": [
                {
                  "id": "log-anthropic",
                  "requestPayload": { "messages": [] },
                  "responsePayload": { "content": [] },
                  "createdAt": 99887766,
                  "summary": {
                    "provider": "anthropic",
                    "model": "claude-sonnet-4-6",
                    "cacheCreationInputTokens": 200,
                    "cacheReadInputTokens": 80,
                    "stopReason": "tool_use"
                  },
                  "requestSections": [
                    {
                      "kind": "tool_use",
                      "label": "Assistant message 2 tool use",
                      "role": "assistant",
                      "toolName": "web_search",
                      "text": "{\"query\":\"vellum changelog\"}",
                      "data": {
                        "query": "vellum changelog"
                      }
                    }
                  ],
                  "responseSections": [
                    {
                      "kind": "tool_result",
                      "label": "Assistant response tool result",
                      "role": "assistant",
                      "toolName": "fetch_page",
                      "text": "[Web search results]"
                    }
                  ]
                },
                {
                  "id": "log-gemini",
                  "requestPayload": { "contents": [] },
                  "responsePayload": { "text": "done" },
                  "createdAt": 99887767,
                  "summary": {
                    "provider": "gemini",
                    "model": "gemini-3-flash-001",
                    "stopReason": "STOP"
                  },
                  "requestSections": [
                    {
                      "kind": "function_response",
                      "label": "User message 1 function response",
                      "role": "user",
                      "toolName": "read_file",
                      "text": "{\"output\":\"Long file body\"}",
                      "data": {
                        "output": "Long file body"
                      }
                    }
                  ],
                  "responseSections": [
                    {
                      "kind": "function_call",
                      "label": "Response function call 1",
                      "role": "model",
                      "toolName": "save_note",
                      "text": "{\"title\":\"brief\"}",
                      "data": {
                        "title": "brief"
                      }
                    }
                  ]
                }
              ]
            }
            """#
        )

        let anthropic = response.logs[0]
        XCTAssertEqual(anthropic.summary?.provider, "anthropic")
        XCTAssertEqual(anthropic.summary?.cacheCreationInputTokens, 200)
        XCTAssertEqual(anthropic.summary?.cacheReadInputTokens, 80)
        XCTAssertEqual(anthropic.requestSections?.first?.kind, .toolUse)
        XCTAssertEqual(anthropic.requestSections?.first?.toolName, "web_search")
        XCTAssertEqual(anthropic.requestSections?.first?.data, AnyCodable(["query": "vellum changelog"]))
        XCTAssertEqual(anthropic.responseSections?.first?.kind, .toolResult)
        XCTAssertEqual(anthropic.responseSections?.first?.text, "[Web search results]")

        let gemini = response.logs[1]
        XCTAssertEqual(gemini.summary?.provider, "gemini")
        XCTAssertEqual(gemini.requestSections?.first?.kind, .functionResponse)
        XCTAssertEqual(gemini.requestSections?.first?.role, "user")
        XCTAssertEqual(gemini.requestSections?.first?.toolName, "read_file")
        XCTAssertEqual(gemini.requestSections?.first?.data, AnyCodable(["output": "Long file body"]))
        XCTAssertEqual(gemini.responseSections?.first?.kind, .functionCall)
        XCTAssertEqual(gemini.responseSections?.first?.role, "model")
        XCTAssertEqual(gemini.responseSections?.first?.toolName, "save_note")
        XCTAssertEqual(gemini.responseSections?.first?.data, AnyCodable(["title": "brief"]))
    }

    func testUnknownSectionKindsAndExtraKeysDecodeWithoutFailure() throws {
        let response = try decodeResponse(
            #"""
            {
              "messageId": "msg-forward-compatible",
              "logs": [
                {
                  "id": "log-3",
                  "requestPayload": { "type": "request" },
                  "responsePayload": { "type": "response" },
                  "createdAt": 99887766,
                  "summary": {
                    "details": "Forward-compatible summary",
                    "extraSummaryField": "ignored"
                  },
                  "requestSections": [
                    {
                      "kind": "future_kind",
                      "label": "Future request",
                      "role": "planner",
                      "text": "Raw future content",
                      "data": {
                        "nested": true
                      }
                    }
                  ],
                  "responseSections": [
                    {
                      "kind": "future_response_kind",
                      "label": "Future response",
                      "toolName": "future_tool",
                      "data": [1, 2, 3],
                      "unexpectedArray": [4, 5, 6]
                    }
                  ],
                  "extraTopLevelField": "ignored"
                }
              ]
            }
            """#
        )

        let entry = try XCTUnwrap(response.logs.first)
        let summary = try XCTUnwrap(entry.summary)
        XCTAssertEqual(summary.summaryText, "Forward-compatible summary")

        let requestSection = try XCTUnwrap(entry.requestSections?.first)
        XCTAssertEqual(requestSection.kind, .unknown("future_kind"))
        XCTAssertEqual(requestSection.label, "Future request")
        XCTAssertEqual(requestSection.role, "planner")
        XCTAssertEqual(requestSection.text, "Raw future content")
        XCTAssertEqual(requestSection.data, AnyCodable(["nested": true]))

        let responseSection = try XCTUnwrap(entry.responseSections?.first)
        XCTAssertEqual(responseSection.kind, .unknown("future_response_kind"))
        XCTAssertEqual(responseSection.label, "Future response")
        XCTAssertEqual(responseSection.toolName, "future_tool")
        XCTAssertEqual(responseSection.data, AnyCodable([1, 2, 3]))
    }

    private func decodeResponse(_ json: String) throws -> LLMContextResponse {
        try JSONDecoder().decode(LLMContextResponse.self, from: Data(json.utf8))
    }
}
