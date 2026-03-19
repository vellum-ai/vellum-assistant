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

    func testEnrichedPayloadDecodesAllNormalizedFields() throws {
        let response = try decodeResponse(
            #"""
            {
              "messageId": "msg-enriched",
              "logs": [
                {
                  "id": "log-2",
                  "requestPayload": {
                    "type": "request",
                    "messages": [
                      { "role": "user", "content": "Hello" }
                    ]
                  },
                  "responsePayload": {
                    "type": "response",
                    "text": "Hi there"
                  },
                  "createdAt": 2233445566,
                  "summary": {
                    "title": "Chat completion",
                    "subtitle": "gpt-4.1",
                    "summary": "Answered the user",
                    "model": "gpt-4.1",
                    "provider": "openai",
                    "status": "success",
                    "inputTokens": 42,
                    "outputTokens": 17,
                    "durationMs": 250,
                    "ignoredSummaryKey": true
                  },
                  "requestSections": [
                    {
                      "kind": "system",
                      "title": "System",
                      "content": "You are helpful",
                      "language": "markdown",
                      "collapsedByDefault": true,
                      "ignoredSectionKey": "ignored"
                    },
                    {
                      "kind": "prompt",
                      "title": "Prompt",
                      "content": "Write a reply"
                    }
                  ],
                  "responseSections": [
                    {
                      "kind": "assistant",
                      "title": "Assistant",
                      "content": "Hi there",
                      "language": "text"
                    }
                  ]
                }
              ]
            }
            """#
        )

        let entry = try XCTUnwrap(response.logs.first)
        let summary = try XCTUnwrap(entry.summary)
        XCTAssertEqual(summary.title, "Chat completion")
        XCTAssertEqual(summary.subtitle, "gpt-4.1")
        XCTAssertEqual(summary.summaryText, "Answered the user")
        XCTAssertEqual(summary.model, "gpt-4.1")
        XCTAssertEqual(summary.provider, "openai")
        XCTAssertEqual(summary.status, "success")
        XCTAssertEqual(summary.inputTokens, 42)
        XCTAssertEqual(summary.outputTokens, 17)
        XCTAssertEqual(summary.durationMs, 250)

        let requestSections = try XCTUnwrap(entry.requestSections)
        XCTAssertEqual(requestSections.count, 2)
        XCTAssertEqual(requestSections[0].kind, .system)
        XCTAssertEqual(requestSections[0].title, "System")
        XCTAssertEqual(requestSections[0].stringContent, "You are helpful")
        XCTAssertEqual(requestSections[0].language, "markdown")
        XCTAssertEqual(requestSections[0].collapsedByDefault, true)
        XCTAssertEqual(requestSections[1].kind, .prompt)
        XCTAssertEqual(requestSections[1].title, "Prompt")
        XCTAssertEqual(requestSections[1].stringContent, "Write a reply")

        let responseSections = try XCTUnwrap(entry.responseSections)
        XCTAssertEqual(responseSections.count, 1)
        XCTAssertEqual(responseSections[0].kind, .assistant)
        XCTAssertEqual(responseSections[0].title, "Assistant")
        XCTAssertEqual(responseSections[0].stringContent, "Hi there")
        XCTAssertEqual(responseSections[0].language, "text")
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
                      "title": "Future request",
                      "content": "Raw future content",
                      "unexpectedNestedValue": { "ignored": true }
                    }
                  ],
                  "responseSections": [
                    {
                      "kind": "future_response_kind",
                      "title": "Future response",
                      "content": "Result",
                      "unexpectedArray": [1, 2, 3]
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
        XCTAssertEqual(requestSection.title, "Future request")
        XCTAssertEqual(requestSection.stringContent, "Raw future content")

        let responseSection = try XCTUnwrap(entry.responseSections?.first)
        XCTAssertEqual(responseSection.kind, .unknown("future_response_kind"))
        XCTAssertEqual(responseSection.title, "Future response")
        XCTAssertEqual(responseSection.stringContent, "Result")
    }

    private func decodeResponse(_ json: String) throws -> LLMContextResponse {
        try JSONDecoder().decode(LLMContextResponse.self, from: Data(json.utf8))
    }
}
