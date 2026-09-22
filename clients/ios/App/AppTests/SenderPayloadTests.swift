import XCTest

final class SenderPayloadTests: XCTestCase {
    private let avatarHash = String(repeating: "a", count: 64)

    private func userInfo(sender: [String: Any]?) -> [AnyHashable: Any] {
        var info: [AnyHashable: Any] = ["aps": ["alert": ["title": "Gym", "body": "Ready"]]]
        if let sender {
            info["sender"] = sender
        }
        return info
    }

    func testParsesACompleteSenderBlock() throws {
        let parsed = SenderPayload.parse(
            userInfo: userInfo(sender: [
                "id": "asst-123",
                "name": "Vellum",
                "avatar_url": "https://storage.example.com/avatar.png",
                "avatar_hash": avatarHash,
            ])
        )
        let url = try XCTUnwrap(URL(string: "https://storage.example.com/avatar.png"))
        XCTAssertEqual(
            parsed,
            SenderPayload(
                id: "asst-123",
                name: "Vellum",
                avatarURL: .url(url),
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
        XCTAssertEqual(parsed?.avatarURL, .absent)
        XCTAssertEqual(parsed?.avatarHash, avatarHash)
    }

    /// An unterminated IPv6 literal is invalid in a way percent-encoding cannot
    /// rescue, so `URL(string:)` returns nil for it. A trimmed payload and a
    /// URL the platform mangled both leave the push without an avatar, and the
    /// two get their own reason tokens rather than sharing `no_url`.
    func testSeparatesAnUnparseableAvatarUrlFromAnAbsentOne() {
        let parsed = SenderPayload.parse(
            userInfo: userInfo(sender: [
                "id": "asst-123",
                "name": "Vellum",
                "avatar_url": "https://[::1",
                "avatar_hash": avatarHash,
            ])
        )
        XCTAssertEqual(parsed?.avatarURL, .malformed)
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
}
