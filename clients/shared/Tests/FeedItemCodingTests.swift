import XCTest

@testable import VellumAssistantShared

/// Codable coverage for the shared `FeedItem` / `HomeFeedFile` types.
///
/// These types are the Swift mirror of
/// `assistant/src/home/feed-types.ts` — the TypeScript side is the
/// source of truth, so these tests assert wire compatibility:
///   - All four `FeedItemType` fixtures (nudge, digest, action, thread)
///     decode cleanly.
///   - Round-trip encode/decode preserves equality.
///   - `"acted_on"` decodes to `.actedOn`.
///   - Missing optional fields (`source`, `expiresAt`, `minTimeAway`,
///     `actions`) decode successfully.
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

    // MARK: - Nudge

    func testDecodesNudgeFixture() throws {
        let json = Data(
            """
            {
              "id": "nudge-1",
              "type": "nudge",
              "priority": 50,
              "title": "You have 3 unread threads",
              "summary": "Since yesterday afternoon.",
              "source": "gmail",
              "timestamp": "2026-04-14T10:00:00Z",
              "status": "new",
              "expiresAt": "2026-04-15T10:00:00Z",
              "minTimeAway": 120,
              "author": "assistant",
              "createdAt": "2026-04-14T09:30:00Z"
            }
            """.utf8
        )

        let item = try decoder.decode(FeedItem.self, from: json)

        XCTAssertEqual(item.id, "nudge-1")
        XCTAssertEqual(item.type, .nudge)
        XCTAssertEqual(item.priority, 50)
        XCTAssertEqual(item.source, .gmail)
        XCTAssertEqual(item.status, .new)
        XCTAssertEqual(item.author, .assistant)
        XCTAssertEqual(item.minTimeAway, 120)
        XCTAssertNotNil(item.expiresAt)
    }

    // MARK: - Digest

    func testDecodesDigestFixture() throws {
        let json = Data(
            """
            {
              "id": "digest-1",
              "type": "digest",
              "priority": 75,
              "title": "Morning digest",
              "summary": "5 emails, 2 meetings, 1 Slack thread.",
              "source": "assistant",
              "timestamp": "2026-04-14T08:00:00Z",
              "status": "seen",
              "author": "platform",
              "createdAt": "2026-04-14T08:00:00Z"
            }
            """.utf8
        )

        let item = try decoder.decode(FeedItem.self, from: json)

        XCTAssertEqual(item.id, "digest-1")
        XCTAssertEqual(item.type, .digest)
        XCTAssertEqual(item.priority, 75)
        XCTAssertEqual(item.status, .seen)
        XCTAssertEqual(item.author, .platform)
        // Missing optionals.
        XCTAssertNil(item.expiresAt)
        XCTAssertNil(item.minTimeAway)
        XCTAssertNil(item.actions)
    }

    // MARK: - Action

    func testDecodesActionFixture() throws {
        let json = Data(
            """
            {
              "id": "action-1",
              "type": "action",
              "priority": 90,
              "title": "Reply to Alex?",
              "summary": "They asked about the Q3 planning doc.",
              "source": "slack",
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
              "author": "assistant",
              "createdAt": "2026-04-14T11:15:30Z"
            }
            """.utf8
        )

        let item = try decoder.decode(FeedItem.self, from: json)

        XCTAssertEqual(item.id, "action-1")
        XCTAssertEqual(item.type, .action)
        XCTAssertEqual(item.source, .slack)
        XCTAssertEqual(item.actions?.count, 2)
        XCTAssertEqual(item.actions?.first?.id, "reply")
        XCTAssertEqual(item.actions?.first?.label, "Draft reply")
        XCTAssertEqual(item.actions?[1].id, "snooze")
    }

    // MARK: - Thread

    func testDecodesThreadFixture() throws {
        let json = Data(
            """
            {
              "id": "thread-1",
              "type": "thread",
              "priority": 30,
              "title": "Trip planning",
              "summary": "Picking up where you left off yesterday.",
              "source": "assistant",
              "timestamp": "2026-04-13T18:45:00Z",
              "status": "acted_on",
              "author": "assistant",
              "createdAt": "2026-04-13T18:45:00Z"
            }
            """.utf8
        )

        let item = try decoder.decode(FeedItem.self, from: json)

        XCTAssertEqual(item.id, "thread-1")
        XCTAssertEqual(item.type, .thread)
        XCTAssertEqual(item.status, .actedOn)
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
              "type": "digest",
              "priority": 10,
              "title": "Bare item",
              "summary": "Only required fields present.",
              "timestamp": "2026-04-14T10:00:00Z",
              "status": "new",
              "author": "platform",
              "createdAt": "2026-04-14T10:00:00Z"
            }
            """.utf8
        )

        let item = try decoder.decode(FeedItem.self, from: json)

        XCTAssertEqual(item.id, "bare-1")
        XCTAssertNil(item.source)
        XCTAssertNil(item.expiresAt)
        XCTAssertNil(item.minTimeAway)
        XCTAssertNil(item.actions)
    }

    // MARK: - Round-trip

    func testRoundTripPreservesEquality() throws {
        let json = Data(
            """
            {
              "id": "action-1",
              "type": "action",
              "priority": 90,
              "title": "Reply to Alex?",
              "summary": "They asked about the Q3 planning doc.",
              "source": "slack",
              "timestamp": "2026-04-14T11:15:00Z",
              "status": "new",
              "expiresAt": "2026-04-15T11:15:00Z",
              "minTimeAway": 60,
              "actions": [
                {
                  "id": "reply",
                  "label": "Draft reply",
                  "prompt": "Draft a reply to Alex about the Q3 planning doc."
                }
              ],
              "author": "assistant",
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
              "version": 1,
              "updatedAt": "2026-04-14T12:00:00Z",
              "items": [
                {
                  "id": "item-1",
                  "type": "nudge",
                  "priority": 50,
                  "title": "Item one",
                  "summary": "Summary one.",
                  "timestamp": "2026-04-14T10:00:00Z",
                  "status": "new",
                  "author": "assistant",
                  "createdAt": "2026-04-14T10:00:00Z"
                },
                {
                  "id": "item-2",
                  "type": "thread",
                  "priority": 20,
                  "title": "Item two",
                  "summary": "Summary two.",
                  "timestamp": "2026-04-14T10:05:00Z",
                  "status": "acted_on",
                  "author": "platform",
                  "createdAt": "2026-04-14T10:05:00Z"
                }
              ]
            }
            """.utf8
        )

        let file = try decoder.decode(HomeFeedFile.self, from: json)

        XCTAssertEqual(file.version, 1)
        XCTAssertEqual(file.items.count, 2)
        XCTAssertEqual(file.items[0].id, "item-1")
        XCTAssertEqual(file.items[1].status, .actedOn)
    }
}
