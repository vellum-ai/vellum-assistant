import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

/// Regression tests for the action concierge feed's expansion/collapse
/// behavior and hero-first layout — complements the pure presentation-builder
/// tests in `CapabilityFeedPresentationTests`.
final class ActionConciergeFeedTests: XCTestCase {

    // MARK: - Helpers

    private func makeCard(
        id: String = UUID().uuidString,
        label: String = "Card",
        category: String = "productivity"
    ) -> CapabilityCard {
        CapabilityCard(
            id: id,
            icon: nil,
            label: label,
            description: "A helpful action",
            prompt: "do something",
            category: category,
            tags: [],
            batch: 0
        )
    }

    private func makeCards(count: Int) -> [CapabilityCard] {
        (0..<count).map { makeCard(id: "card-\($0)", label: "Card \($0)") }
    }

    // MARK: - Hero-First Layout

    func testHeroIsAlwaysFirstCard() {
        // The concierge feed must always promote the first server-ordered card
        // to hero position, regardless of how many cards are provided.
        for count in 1...12 {
            let cards = makeCards(count: count)
            let presentation = CapabilityFeedPresentation(cards: cards)

            XCTAssertEqual(
                presentation.hero?.id, "card-0",
                "With \(count) cards, hero should always be the first card"
            )
        }
    }

    func testHeroIsExcludedFromSupportingAndOverflow() {
        let cards = makeCards(count: 8)
        let presentation = CapabilityFeedPresentation(cards: cards)

        let allNonHero = presentation.supporting + presentation.overflow
        XCTAssertFalse(
            allNonHero.contains { $0.id == presentation.hero?.id },
            "Hero card must not appear in supporting or overflow"
        )
    }

    func testLayoutPreservesServerOrdering() {
        let cards = makeCards(count: 8)
        let presentation = CapabilityFeedPresentation(cards: cards)

        let allIDs = [presentation.hero?.id].compactMap { $0 }
            + presentation.supporting.map(\.id)
            + presentation.overflow.map(\.id)

        XCTAssertEqual(
            allIDs,
            cards.map(\.id),
            "All cards must appear in their original server-provided order"
        )
    }

    // MARK: - Overflow Expansion/Collapse

    func testOverflowIsPopulatedAboveThreshold() {
        let cards = makeCards(count: 8)
        let presentation = CapabilityFeedPresentation(cards: cards)

        // With 8 cards: 1 hero + 4 supporting + 3 overflow
        XCTAssertEqual(presentation.overflow.count, 3)
    }

    func testOverflowIsEmptyAtExactThreshold() {
        // Exactly 5 cards should fill hero + supporting with no overflow
        let cards = makeCards(count: 5)
        let presentation = CapabilityFeedPresentation(cards: cards)

        XCTAssertTrue(
            presentation.overflow.isEmpty,
            "Exactly 5 cards (1 hero + 4 supporting) should produce no overflow"
        )
    }

    func testOverflowContainsAllCardsAfterSupportingCap() {
        let cards = makeCards(count: 12)
        let presentation = CapabilityFeedPresentation(cards: cards)

        // overflow starts at index 5 (after hero + 4 supporting)
        let expectedOverflowCount = 12 - CapabilityFeedPresentation.overflowStartIndex
        XCTAssertEqual(presentation.overflow.count, expectedOverflowCount)
        XCTAssertEqual(presentation.overflow.first?.id, "card-5")
        XCTAssertEqual(presentation.overflow.last?.id, "card-11")
    }

    // MARK: - Generating State Interaction

    func testGeneratingStateDuringPartialLoad() {
        // When some categories are still generating, the feed should report
        // isGenerating=true while still displaying already-available cards.
        let cards = makeCards(count: 3)
        let statuses: [String: CategoryStatus] = [
            "productivity": CategoryStatus(status: "ready", relevance: 0.9),
            "research": CategoryStatus(status: "generating", relevance: nil),
        ]
        let presentation = CapabilityFeedPresentation(cards: cards, categoryStatuses: statuses)

        XCTAssertNotNil(presentation.hero, "Hero should be set even during generation")
        XCTAssertEqual(presentation.supporting.count, 2)
        XCTAssertTrue(presentation.isGenerating, "Should indicate generation in progress")
    }

    // MARK: - Bucket Counts Invariant

    func testTotalCardCountIsPreserved() {
        // The sum of hero + supporting + overflow must equal the input count.
        for count in 0...15 {
            let cards = makeCards(count: count)
            let presentation = CapabilityFeedPresentation(cards: cards)

            let heroCount = presentation.hero != nil ? 1 : 0
            let total = heroCount + presentation.supporting.count + presentation.overflow.count
            XCTAssertEqual(
                total, count,
                "With \(count) input cards, total partitioned cards should match"
            )
        }
    }
}
