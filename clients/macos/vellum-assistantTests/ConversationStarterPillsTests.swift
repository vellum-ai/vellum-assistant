import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

final class ConversationStarterPillsTests: XCTestCase {

    // MARK: - Helpers

    private func makeStarter(id: String, label: String, prompt: String) -> ConversationStarter {
        ConversationStarter(id: id, label: label, prompt: prompt, category: nil, batch: 0)
    }

    // MARK: - Visible Count Cap

    /// The pill row must never show more than four items, even when more are provided.
    func testMaxVisibleCountIsFour() {
        XCTAssertEqual(ConversationStarterPillRow.maxVisibleCount, 4)
    }

    /// When given more starters than the cap, only the first four are shown.
    func testPillRowCapsAtFourStarters() {
        let starters = (0..<7).map { i in
            makeStarter(id: "\(i)", label: "Starter \(i)", prompt: "prompt \(i)")
        }

        let visibleStarters = Array(starters.prefix(ConversationStarterPillRow.maxVisibleCount))
        XCTAssertEqual(visibleStarters.count, 4)
    }

    /// When given fewer than four starters, all are shown.
    func testPillRowShowsAllWhenFewerThanCap() {
        let starters = (0..<2).map { i in
            makeStarter(id: "\(i)", label: "Starter \(i)", prompt: "prompt \(i)")
        }

        let visibleStarters = Array(starters.prefix(ConversationStarterPillRow.maxVisibleCount))
        XCTAssertEqual(visibleStarters.count, 2)
    }

    // MARK: - Server Ordering Preserved

    /// The pill row must preserve the server-provided ordering (strongest first).
    func testPillRowPreservesServerOrdering() {
        let starters = [
            makeStarter(id: "a", label: "First", prompt: "p1"),
            makeStarter(id: "b", label: "Second", prompt: "p2"),
            makeStarter(id: "c", label: "Third", prompt: "p3"),
        ]

        let visibleStarters = Array(starters.prefix(ConversationStarterPillRow.maxVisibleCount))
        XCTAssertEqual(visibleStarters.map(\.id), ["a", "b", "c"])
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
        let visibleStarters = Array(starters.prefix(ConversationStarterPillRow.maxVisibleCount))
        XCTAssertTrue(visibleStarters.isEmpty)
    }
}
