import XCTest

@testable import VellumAssistantShared

/// Codable coverage for the shared `FeedItem` / `HomeFeedFile` types
/// (schema **v2**).
///
/// These types are the Swift mirror of
/// `assistant/src/home/feed-types.ts` — the TypeScript side is the
/// source of truth, so these tests assert wire compatibility:
///   - The single `notification` `FeedItemType` decodes cleanly.
///   - Round-trip encode/decode preserves equality.
///   - `"acted_on"` decodes to `.actedOn`.
///   - Missing optional fields (`expiresAt`, `actions`, `urgency`,
///     `conversationId`, `detailPanel`) decode successfully.
///   - `HomeFeedFile.version == 2` round-trips.
///
/// `Date` fields use `JSONDecoder.dateDecodingStrategy = .iso8601` at
/// the call site, not inside the type definitions — these tests
/// exercise that pattern as well.
final class FeedItemCodingTests: XCTestCase {

    private var decoder: JSONDecoder {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return d
    }

    private var encoder: JSONEncoder {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .iso8601
        // Sorted keys so round-trip comparisons are stable.
        e.outputFormatting = [.sortedKeys]
        return e
    }

    // MARK: - Notification (v2 default)

    func testDecodesNotificationFixture() throws {
        let json = Data(
            """
            {
              "id": "notif-1",
              "type": "notification",
              "priority": 50,
              "title": "You have 3 unread threads",
              "summary": "Since yesterday afternoon.",
              "timestamp": "2026-04-14T10:00:00Z",
              "status": "new",
              "expiresAt": "2026-04-15T10:00:00Z",
              "createdAt": "2026-04-14T09:30:00Z"
            }
            """.utf8
        )

        let item = try decoder.decode(FeedItem.self, from: json)

        XCTAssertEqual(item.id, "notif-1")
        XCTAssertEqual(item.type, .notification)
        XCTAssertEqual(item.priority, 50)
        XCTAssertEqual(item.status, .new)
        XCTAssertNotNil(item.expiresAt)
    }

    // MARK: - Action payload

    func testDecodesNotificationWithActions() throws {
        let json = Data(
            """
            {
              "id": "notif-2",
              "type": "notification",
              "priority": 90,
              "title": "Reply to Alex?",
              "summary": "They asked about the Q3 planning doc.",
              "timestamp": "2026-04-14T11:15:00Z",
              "status": "new",
              "actions": [
                {
                  "id": "reply",
                  "label": "Draft reply",
                  "prompt": "Draft a reply to Alex about the Q3 planning doc."
                },
                {
                  "id": "snooze",
                  "label": "Snooze 1h",
                  "prompt": "Remind me about Alex's Slack message in an hour."
                }
              ],
              "createdAt": "2026-04-14T11:15:30Z"
            }
            """.utf8
        )

        let item = try decoder.decode(FeedItem.self, from: json)

        XCTAssertEqual(item.id, "notif-2")
        XCTAssertEqual(item.type, .notification)
        XCTAssertEqual(item.actions?.count, 2)
        XCTAssertEqual(item.actions?.first?.id, "reply")
        XCTAssertEqual(item.actions?.first?.label, "Draft reply")
        XCTAssertEqual(item.actions?[1].id, "snooze")
    }

    // MARK: - acted_on enum raw value

    func testActedOnRawValueDecoding() throws {
        let json = Data(#""acted_on""#.utf8)
        let status = try decoder.decode(FeedItemStatus.self, from: json)
        XCTAssertEqual(status, .actedOn)
    }

    func testActedOnRawValueEncoding() throws {
        let data = try encoder.encode(FeedItemStatus.actedOn)
        let raw = String(decoding: data, as: UTF8.self)
        XCTAssertEqual(raw, #""acted_on""#)
    }

    // MARK: - Missing optional fields

    func testDecodesWithAllOptionalsMissing() throws {
        let json = Data(
            """
            {
              "id": "bare-1",
              "type": "notification",
              "priority": 10,
              "title": "Bare item",
              "summary": "Only required fields present.",
              "timestamp": "2026-04-14T10:00:00Z",
              "status": "new",
              "createdAt": "2026-04-14T10:00:00Z"
            }
            """.utf8
        )

        let item = try decoder.decode(FeedItem.self, from: json)

        XCTAssertEqual(item.id, "bare-1")
        XCTAssertNil(item.expiresAt)
        XCTAssertNil(item.actions)
        XCTAssertNil(item.urgency)
        XCTAssertNil(item.conversationId)
        XCTAssertNil(item.detailPanel)
    }

    // MARK: - Round-trip

    func testRoundTripPreservesEquality() throws {
        let json = Data(
            """
            {
              "id": "notif-3",
              "type": "notification",
              "priority": 90,
              "title": "Reply to Alex?",
              "summary": "They asked about the Q3 planning doc.",
              "timestamp": "2026-04-14T11:15:00Z",
              "status": "new",
              "expiresAt": "2026-04-15T11:15:00Z",
              "actions": [
                {
                  "id": "reply",
                  "label": "Draft reply",
                  "prompt": "Draft a reply to Alex about the Q3 planning doc."
                }
              ],
              "createdAt": "2026-04-14T11:15:30Z"
            }
            """.utf8
        )

        let decoded = try decoder.decode(FeedItem.self, from: json)
        let reencoded = try encoder.encode(decoded)
        let redecoded = try decoder.decode(FeedItem.self, from: reencoded)

        XCTAssertEqual(decoded, redecoded)
    }

    // MARK: - HomeFeedFile

    func testDecodesHomeFeedFile() throws {
        let json = Data(
            """
            {
              "version": 2,
              "updatedAt": "2026-04-14T12:00:00Z",
              "items": [
                {
                  "id": "item-1",
                  "type": "notification",
                  "priority": 50,
                  "title": "Item one",
                  "summary": "Summary one.",
                  "timestamp": "2026-04-14T10:00:00Z",
                  "status": "new",
                  "createdAt": "2026-04-14T10:00:00Z"
                },
                {
                  "id": "item-2",
                  "type": "notification",
                  "priority": 20,
                  "title": "Item two",
                  "summary": "Summary two.",
                  "timestamp": "2026-04-14T10:05:00Z",
                  "status": "acted_on",
                  "createdAt": "2026-04-14T10:05:00Z"
                }
              ]
            }
            """.utf8
        )

        let file = try decoder.decode(HomeFeedFile.self, from: json)

        XCTAssertEqual(file.version, 2)
        XCTAssertEqual(file.items.count, 2)
        XCTAssertEqual(file.items[0].id, "item-1")
        XCTAssertEqual(file.items[1].status, .actedOn)
    }
}
