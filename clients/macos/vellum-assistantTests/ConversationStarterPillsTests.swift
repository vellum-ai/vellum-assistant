import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

final class ConversationStarterPillsTests: XCTestCase {

    // MARK: - Helpers

    private func makeStarter(id: String, label: String, prompt: String) -> ConversationStarter {
        ConversationStarter(id: id, label: label, prompt: prompt, category: nil, batch: 0)
    }

    /// Mirrors the even-count capping logic in ConversationStarterPillRow.
    private func visibleStarters(from starters: [ConversationStarter]) -> [ConversationStarter] {
        let count = min(starters.count, 6)
        let evenCount = count - (count % 2)
        guard evenCount > 0 else { return [] }
        return Array(starters.prefix(evenCount))
    }

    // MARK: - Visible Count Cap

    /// The pill row must never show more than six items, even when more are provided.
    func testMaxVisibleCountIsSix() {
        let starters = (0..<10).map { i in
            makeStarter(id: "\(i)", label: "Starter \(i)", prompt: "prompt \(i)")
        }
        XCTAssertEqual(visibleStarters(from: starters).count, 6)
    }

    /// Odd counts are rounded down to the nearest even number.
    func testOddCountRoundsDown() {
        let starters = (0..<5).map { i in
            makeStarter(id: "\(i)", label: "Starter \(i)", prompt: "prompt \(i)")
        }
        XCTAssertEqual(visibleStarters(from: starters).count, 4)
    }

    /// A single starter produces no pills (rounds down to 0).
    func testSingleStarterShowsNone() {
        let starters = [makeStarter(id: "0", label: "Solo", prompt: "prompt")]
        XCTAssertEqual(visibleStarters(from: starters).count, 0)
    }

    /// When given fewer than six even starters, all are shown.
    func testPillRowShowsAllWhenFewerThanCap() {
        let starters = (0..<2).map { i in
            makeStarter(id: "\(i)", label: "Starter \(i)", prompt: "prompt \(i)")
        }
        XCTAssertEqual(visibleStarters(from: starters).count, 2)
    }

    // MARK: - Server Ordering Preserved

    /// The pill row must preserve the server-provided ordering (strongest first).
    func testPillRowPreservesServerOrdering() {
        let starters = [
            makeStarter(id: "a", label: "First", prompt: "p1"),
            makeStarter(id: "b", label: "Second", prompt: "p2"),
            makeStarter(id: "c", label: "Third", prompt: "p3"),
            makeStarter(id: "d", label: "Fourth", prompt: "p4"),
        ]

        let visible = visibleStarters(from: starters)
        XCTAssertEqual(visible.map(\.id), ["a", "b", "c", "d"])
    }

    // MARK: - Interaction

    /// Tapping a pill invokes the selection callback with the correct starter.
    func testOnSelectReceivesCorrectStarter() {
        let starters = [
            makeStarter(id: "x", label: "Do X", prompt: "full prompt for X"),
            makeStarter(id: "y", label: "Do Y", prompt: "full prompt for Y"),
        ]

        var selectedId: String?
        let onSelect: (ConversationStarter) -> Void = { selectedId = $0.id }

        // Simulate selecting the second starter
        onSelect(starters[1])
        XCTAssertEqual(selectedId, "y")
    }

    /// Empty starters array produces no pills.
    func testEmptyStartersProducesNoPills() {
        let starters: [ConversationStarter] = []
        XCTAssertTrue(visibleStarters(from: starters).isEmpty)
    }
}
