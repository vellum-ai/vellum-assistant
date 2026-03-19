import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

final class MessageInspectorOverviewTabTests: XCTestCase {
    func testOpenAiFixtureProducesSummaryFirstMetadata() throws {
        let entry = try decodeEntry(
            #"""
            {
              "id": "openai-1",
              "requestPayload": { "messages": [{ "role": "user", "content": "How's the weather?" }] },
              "responsePayload": {
                "choices": [{
                  "finish_reason": "tool_calls",
                  "message": {
                    "role": "assistant",
                    "content": "I'll check the forecast."
                  }
                }]
              },
              "createdAt": 0,
              "summary": {
                "provider": "openai",
                "model": "gpt-4.1",
                "inputTokens": 321,
                "outputTokens": 54,
                "stopReason": "tool_calls",
                "requestMessageCount": 2,
                "requestToolCount": 2,
                "responseMessageCount": 1,
                "responseToolCallCount": 2,
                "responsePreview": "I'll check the forecast.",
                "toolCallNames": ["web_search", "get_weather"]
              }
            }
            """#
        )

        let content = MessageInspectorOverviewContent(entry: entry)

        XCTAssertEqual(content.identityRows.map(\.label), ["Provider", "Model", "Created"])
        XCTAssertEqual(content.identityRows.map(\.value)[0], "OpenAI")
        XCTAssertEqual(content.identityRows.map(\.value)[1], "gpt-4.1")
        XCTAssertEqual(content.identityRows.map(\.value)[2], MessageInspectorSummaryFormatters.formattedCreatedAt(0))

        XCTAssertEqual(content.usageRows.map(\.label), ["Input tokens", "Output tokens", "Cache tokens", "Request messages", "Tool count"])
        XCTAssertEqual(content.usageRows.map(\.value), ["321", "54", "Unavailable", "2", "2"])
        XCTAssertEqual(content.responsePreview, "I'll check the forecast.")
        XCTAssertEqual(content.toolCallNames, "web_search, get_weather")
        XCTAssertNil(content.fallbackMessage)

        XCTAssertEqual(entry.summary?.responseMessageCount, 1)
        XCTAssertEqual(entry.summary?.responseToolCallCount, 2)
    }

    func testAnthropicFixtureSurfacesCacheTokensAndToolNames() throws {
        let entry = try decodeEntry(
            #"""
            {
              "id": "anthropic-1",
              "requestPayload": { "messages": [{ "role": "user", "content": "Find the latest changelog." }] },
              "responsePayload": { "content": [{ "type": "text", "text": "I found the changelog." }] },
              "createdAt": 0,
              "summary": {
                "provider": "anthropic",
                "model": "claude-sonnet-4-6",
                "inputTokens": 410,
                "outputTokens": 73,
                "cacheCreationInputTokens": 200,
                "cacheReadInputTokens": 80,
                "stopReason": "tool_use",
                "requestMessageCount": 2,
                "requestToolCount": 1,
                "responseMessageCount": 1,
                "responseToolCallCount": 1,
                "responsePreview": "I found the changelog.",
                "toolCallNames": ["fetch_page"]
              }
            }
            """#
        )

        let content = MessageInspectorOverviewContent(entry: entry)

        XCTAssertEqual(content.identityRows.map(\.value)[0], "Anthropic")
        XCTAssertEqual(content.usageRows.map(\.value), ["410", "73", "Created 200, Read 80", "2", "1"])
        XCTAssertEqual(content.responsePreview, "I found the changelog.")
        XCTAssertEqual(content.toolCallNames, "fetch_page")
        XCTAssertNil(content.fallbackMessage)

        XCTAssertEqual(entry.summary?.cacheCreationInputTokens, 200)
        XCTAssertEqual(entry.summary?.cacheReadInputTokens, 80)
    }

    func testGeminiFixtureKeepsOverviewUsefulWithoutCacheTokens() throws {
        let entry = try decodeEntry(
            #"""
            {
              "id": "gemini-1",
              "requestPayload": { "contents": [{ "role": "user", "parts": [{ "text": "Summarize the note." }] }] },
              "responsePayload": {
                "text": "Here is a concise summary."
              },
              "createdAt": 0,
              "summary": {
                "provider": "gemini",
                "model": "gemini-2.0-flash",
                "inputTokens": 120,
                "outputTokens": 34,
                "stopReason": "STOP",
                "requestMessageCount": 2,
                "requestToolCount": 1,
                "responseMessageCount": 1,
                "responseToolCallCount": 1,
                "responsePreview": "Here is a concise summary.",
                "toolCallNames": ["save_note"]
              }
            }
            """#
        )

        let content = MessageInspectorOverviewContent(entry: entry)

        XCTAssertEqual(content.identityRows.map(\.value)[0], "Gemini")
        XCTAssertEqual(content.usageRows.map(\.value), ["120", "34", "Unavailable", "2", "1"])
        XCTAssertEqual(content.responsePreview, "Here is a concise summary.")
        XCTAssertEqual(content.toolCallNames, "save_note")
        XCTAssertNil(content.fallbackMessage)
    }

    func testMissingSummaryFallsBackToRawPayloadHint() throws {
        let entry = try decodeEntry(
            #"""
            {
              "id": "legacy-1",
              "requestPayload": { "type": "request", "messages": [] },
              "responsePayload": { "type": "response", "text": "ok" },
              "createdAt": 0
            }
            """#
        )

        let content = MessageInspectorOverviewContent(entry: entry)

        XCTAssertTrue(content.identityRows.isEmpty)
        XCTAssertTrue(content.usageRows.isEmpty)
        XCTAssertNil(content.responsePreview)
        XCTAssertNil(content.toolCallNames)
        XCTAssertNotNil(content.fallbackMessage)
        XCTAssertTrue(content.fallbackMessage?.contains("Raw tab") == true)
        XCTAssertTrue(content.fallbackMessage?.contains(MessageInspectorSummaryFormatters.formattedCreatedAt(0)) == true)
    }

    func testFormatterHelpersTruncateAndCompactValues() {
        let preview = String(repeating: "a", count: 200)
        let truncated = MessageInspectorSummaryFormatters.truncatedResponsePreview(preview, limit: 40)

        XCTAssertEqual(truncated, String(repeating: "a", count: 40) + "…")
        XCTAssertNil(MessageInspectorSummaryFormatters.truncatedResponsePreview("   "))
        XCTAssertEqual(
            MessageInspectorSummaryFormatters.compactToolNames(["alpha", "beta", "gamma", "delta"], maxVisible: 3),
            "alpha, beta, gamma +1 more"
        )
        XCTAssertNil(MessageInspectorSummaryFormatters.compactToolNames([], maxVisible: 3))
        XCTAssertEqual(MessageInspectorSummaryFormatters.formatCacheTokens(created: nil, read: nil), "Unavailable")
    }

    private func decodeEntry(_ json: String) throws -> LLMRequestLogEntry {
        try JSONDecoder().decode(LLMRequestLogEntry.self, from: Data(json.utf8))
    }
}
