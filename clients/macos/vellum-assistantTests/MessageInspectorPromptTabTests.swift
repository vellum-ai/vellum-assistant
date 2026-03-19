import Foundation
import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

final class MessageInspectorPromptTabTests: XCTestCase {
    func testPromptTabModelPreservesSectionOrderAndFormatsCopyText() {
        let entry = makeEntry(
            requestPayload: AnyCodable([
                "messages": [
                    ["role": "system", "content": "You are helpful"],
                    ["role": "user", "content": "Write a summary"]
                ]
            ]),
            requestSections: [
                LLMContextSection(
                    kind: .unknown("message"),
                    title: "System prompt",
                    content: AnyCodable("You are helpful")
                ),
                LLMContextSection(
                    kind: .unknown("tool_definitions"),
                    title: "Available tools",
                    content: AnyCodable([
                        "tools": [
                            [
                                "name": "web_search",
                                "description": "Search the web"
                            ]
                        ],
                        "max_output_tokens": 256
                    ])
                ),
                LLMContextSection(
                    kind: .unknown("message"),
                    title: "User message 1",
                    content: AnyCodable("Write a summary")
                )
            ]
        )

        let model = MessageInspectorPromptTabModel(entry: entry)

        XCTAssertEqual(model.sections.map(\.title), [
            "System prompt",
            "Available tools",
            "User message 1"
        ])
        XCTAssertEqual(model.sections.map(\.presentationStyle), [
            .text,
            .structured,
            .text
        ])
        XCTAssertEqual(model.sections[0].copyText, "You are helpful")
        XCTAssertTrue(model.sections[1].copyText.contains("\"web_search\""))
        XCTAssertTrue(model.sections[1].copyText.contains("\"max_output_tokens\""))
        XCTAssertEqual(model.sections[2].copyText, "Write a summary")
        XCTAssertTrue(model.bannerText.contains("same order"))
    }

    func testPromptTabModelUsesOnlyNormalizedSectionsAndShowsRawFallback() {
        let entry = makeEntry(
            requestPayload: AnyCodable([
                "messages": [
                    ["role": "user", "content": "Hello from the raw payload"]
                ],
                "tools": [
                    [
                        "function": [
                            "name": "search"
                        ]
                    ]
                ]
            ]),
            requestSections: nil
        )

        let model = MessageInspectorPromptTabModel(entry: entry)

        XCTAssertTrue(model.sections.isEmpty)
        XCTAssertTrue(model.bannerText.contains("normalized prompt sections"))
        XCTAssertTrue(model.fallbackMessage.contains("Raw tab"))
    }

    private func makeEntry(
        requestPayload: AnyCodable,
        requestSections: [LLMContextSection]?
    ) -> LLMRequestLogEntry {
        LLMRequestLogEntry(
            id: UUID().uuidString,
            requestPayload: requestPayload,
            responsePayload: AnyCodable([:]),
            createdAt: 1_000,
            summary: nil,
            requestSections: requestSections,
            responseSections: nil
        )
    }
}
