import XCTest
@testable import VellumAssistantShared

final class SurfaceTypesTests: XCTestCase {
    func testParsesChoiceSurface() {
        let message = UiSurfaceShowMessage(
            conversationId: "conv-123",
            surfaceId: "surface-choice",
            surfaceType: "choice",
            title: "Pick an option",
            data: AnyCodable([
                "description": "Choose one.",
                "selectionMode": "single",
                "options": [
                    [
                        "id": "option-a",
                        "title": "Option A",
                        "description": "First option",
                        "recommended": true,
                        "data": ["priority": "high"]
                    ]
                ]
            ] as [String: Any?]),
            actions: nil,
            display: "inline",
            messageId: nil
        )

        let surface = Surface.from(message)
        XCTAssertEqual(surface?.type, .choice)
        guard case .choice(let data) = surface?.data else {
            return XCTFail("Expected choice surface data")
        }
        XCTAssertEqual(data.options.first?.id, "option-a")
        XCTAssertEqual(data.options.first?.data?["priority"], AnyCodable("high"))
    }

    func testParsesCopyBlockSurface() {
        let message = UiSurfaceShowMessage(
            conversationId: "conv-123",
            surfaceId: "surface-copy",
            surfaceType: "copy_block",
            title: nil,
            data: AnyCodable([
                "text": "hello world",
                "label": "Example",
                "language": "text"
            ] as [String: Any?]),
            actions: nil,
            display: "inline",
            messageId: nil
        )

        let surface = Surface.from(message)
        XCTAssertEqual(surface?.type, .copyBlock)
        guard case .copyBlock(let data) = surface?.data else {
            return XCTFail("Expected copy block surface data")
        }
        XCTAssertEqual(data.text, "hello world")
        XCTAssertEqual(data.label, "Example")
    }

    func testParsesOAuthConnectSurface() {
        let message = UiSurfaceShowMessage(
            conversationId: "conv-123",
            surfaceId: "surface-oauth",
            surfaceType: "oauth_connect",
            title: "Connect Gmail",
            data: AnyCodable([
                "providerKey": "google",
                "displayName": "Google",
                "description": "Connect your account.",
                "logoUrl": NSNull()
            ] as [String: Any?]),
            actions: nil,
            display: "inline",
            messageId: nil
        )

        let surface = Surface.from(message)
        XCTAssertEqual(surface?.type, .oauthConnect)
        guard case .oauthConnect(let data) = surface?.data else {
            return XCTFail("Expected OAuth connect surface data")
        }
        XCTAssertEqual(data.providerKey, "google")
        XCTAssertEqual(data.displayName, "Google")
        XCTAssertNil(data.logoUrl)
    }

    func testParsesTaskPreferencesSurface() {
        let message = UiSurfaceShowMessage(
            conversationId: "conv-123",
            surfaceId: "surface-tasks",
            surfaceType: "task_preferences",
            title: "What can I help with?",
            data: AnyCodable([:] as [String: Any?]),
            actions: nil,
            display: "inline",
            messageId: nil
        )

        let surface = Surface.from(message)
        XCTAssertEqual(surface?.type, .taskPreferences)
        guard case .taskPreferences = surface?.data else {
            return XCTFail("Expected task preferences surface data")
        }
    }

    func testParsesWorkResultSurface() {
        let message = UiSurfaceShowMessage(
            conversationId: "conv-123",
            surfaceId: "surface-work",
            surfaceType: "work_result",
            title: "Work completed",
            data: AnyCodable([
                "eyebrow": "Summary",
                "status": "completed",
                "summary": "Finished the requested work.",
                "metrics": [
                    ["label": "Files", "value": 3, "tone": "positive"]
                ],
                "sections": [
                    [
                        "id": "changes",
                        "title": "Changes",
                        "type": "items",
                        "items": [
                            ["title": "Updated settings", "tone": "positive"]
                        ]
                    ]
                ]
            ] as [String: Any?]),
            actions: nil,
            display: "inline",
            messageId: nil
        )

        let surface = Surface.from(message)
        XCTAssertEqual(surface?.type, .workResult)
        guard case .workResult(let data) = surface?.data else {
            return XCTFail("Expected work result surface data")
        }
        XCTAssertEqual(data.status, .completed)
        XCTAssertEqual(data.metrics.first?.value, "3")
        XCTAssertEqual(data.sections.first?.items.first?.title, "Updated settings")
    }
}
