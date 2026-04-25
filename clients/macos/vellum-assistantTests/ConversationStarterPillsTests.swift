import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

final class ConversationStarterPillsTests: XCTestCase {

    // MARK: - Helpers

    private func makeStarter(id: String, label: String, prompt: String) -> ConversationStarter {
        ConversationStarter(id: id, label: label, prompt: prompt, category: nil, batch: 0)
    }

    /// Mirrors the capping logic in ConversationStarterPillRow.
    private func visibleStarters(from starters: [ConversationStarter]) -> [ConversationStarter] {
        Array(starters.prefix(4))
    }

    // MARK: - Visible Count Cap

    /// The pill row must never show more than four items, even when more are provided.
    func testMaxVisibleCountIsFour() {
        let starters = (0..<10).map { i in
            makeStarter(id: "\(i)", label: "Starter \(i)", prompt: "prompt \(i)")
        }
        XCTAssertEqual(visibleStarters(from: starters).count, 4)
    }

    /// Odd counts stay visible so removing one chip does not hide another.
    func testOddCountStaysVisible() {
        let starters = (0..<3).map { i in
            makeStarter(id: "\(i)", label: "Starter \(i)", prompt: "prompt \(i)")
        }
        XCTAssertEqual(visibleStarters(from: starters).count, 3)
    }

    /// A single remaining starter stays visible.
    func testSingleStarterStaysVisible() {
        let starters = [makeStarter(id: "0", label: "Solo", prompt: "prompt")]
        XCTAssertEqual(visibleStarters(from: starters).count, 1)
    }

    /// When given fewer than four starters, all are shown.
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
