import XCTest

final class SenderPayloadTests: XCTestCase {
    private let avatarHash = String(repeating: "a", count: 64)

    private func userInfo(sender: [String: Any]?, deepLink: [String: Any]? = nil) -> [AnyHashable: Any] {
        var info: [AnyHashable: Any] = ["aps": ["alert": ["title": "Gym", "body": "Ready"]]]
        if let sender {
            info["sender"] = sender
        }
        if let deepLink {
            info["deep_link"] = deepLink
        }
        return info
    }

    func testParsesACompleteSenderBlock() {
        let parsed = SenderPayload.parse(
            userInfo: userInfo(sender: [
                "id": "asst-123",
                "name": "Vellum",
                "avatar_url": "https://storage.example.com/avatar.png",
                "avatar_hash": avatarHash,
            ])
        )
        XCTAssertEqual(
            parsed,
            SenderPayload(
                id: "asst-123",
                name: "Vellum",
                avatarURL: URL(string: "https://storage.example.com/avatar.png"),
                avatarHash: avatarHash
            )
        )
    }

    func testParsesWithoutAvatarUrl() {
        let parsed = SenderPayload.parse(
            userInfo: userInfo(sender: [
                "id": "asst-123",
                "name": "Vellum",
                "avatar_hash": avatarHash,
            ])
        )
        XCTAssertNil(parsed?.avatarURL)
        XCTAssertEqual(parsed?.avatarHash, avatarHash)
    }

    func testReturnsNilWithoutASenderBlock() {
        XCTAssertNil(SenderPayload.parse(userInfo: userInfo(sender: nil)))
    }

    func testReturnsNilForPartialOrEmptyFields() {
        XCTAssertNil(
            SenderPayload.parse(userInfo: userInfo(sender: ["id": "asst-123", "name": "Vellum"]))
        )
        XCTAssertNil(
            SenderPayload.parse(
                userInfo: userInfo(sender: ["id": "asst-123", "avatar_hash": avatarHash])
            )
        )
        XCTAssertNil(
            SenderPayload.parse(
                userInfo: userInfo(sender: ["id": "", "name": "Vellum", "avatar_hash": avatarHash])
            )
        )
        XCTAssertNil(
            SenderPayload.parse(
                userInfo: userInfo(sender: ["id": "asst-123", "name": "Vellum", "avatar_hash": ""])
            )
        )
    }

    func testConversationIdentifierPrefersTheDeepLink() {
        XCTAssertEqual(
            SenderPayload.conversationIdentifier(
                userInfo: userInfo(sender: nil, deepLink: ["conversationId": "conv-xyz"]),
                senderId: "asst-123"
            ),
            "conv-xyz"
        )
    }

    func testConversationIdentifierFallsBackToTheSenderId() {
        XCTAssertEqual(
            SenderPayload.conversationIdentifier(userInfo: userInfo(sender: nil), senderId: "asst-123"),
            "asst-123"
        )
        XCTAssertEqual(
            SenderPayload.conversationIdentifier(
                userInfo: userInfo(sender: nil, deepLink: ["conversationId": ""]),
                senderId: "asst-123"
            ),
            "asst-123"
        )
        XCTAssertEqual(
            SenderPayload.conversationIdentifier(
                userInfo: userInfo(sender: nil, deepLink: ["other": "value"]),
                senderId: "asst-123"
            ),
            "asst-123"
        )
    }
}
