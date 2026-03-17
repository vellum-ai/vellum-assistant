import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

final class CapabilityFeedPresentationTests: XCTestCase {

    // MARK: - Helpers

    private func makeCard(id: String = UUID().uuidString, label: String = "Card") -> CapabilityCard {
        CapabilityCard(
            id: id,
            icon: nil,
            label: label,
            description: nil,
            prompt: "do something",
            category: "productivity",
            tags: [],
            batch: 0
        )
    }

    private func makeCards(count: Int) -> [CapabilityCard] {
        (0..<count).map { makeCard(id: "card-\($0)", label: "Card \($0)") }
    }

    // MARK: - Hero Partitioning

    func testFirstCardBecomesHero() {
        let cards = makeCards(count: 3)
        let sut = CapabilityFeedPresentation(cards: cards)

        XCTAssertEqual(sut.hero?.id, "card-0")
    }

    func testEmptyCardsProducesNilHero() {
        let sut = CapabilityFeedPresentation(cards: [])

        XCTAssertNil(sut.hero)
        XCTAssertTrue(sut.supporting.isEmpty)
        XCTAssertTrue(sut.overflow.isEmpty)
    }

    func testSingleCardIsHeroOnly() {
        let sut = CapabilityFeedPresentation(cards: makeCards(count: 1))

        XCTAssertNotNil(sut.hero)
        XCTAssertTrue(sut.supporting.isEmpty)
        XCTAssertTrue(sut.overflow.isEmpty)
    }

    // MARK: - Supporting Cap

    func testSupportingCapsAtFour() {
        let cards = makeCards(count: 10)
        let sut = CapabilityFeedPresentation(cards: cards)

        XCTAssertEqual(sut.supporting.count, CapabilityFeedPresentation.maxSupportingCount)
        XCTAssertEqual(sut.supporting.map(\.id), ["card-1", "card-2", "card-3", "card-4"])
    }

    func testSupportingWithFewerThanFour() {
        let cards = makeCards(count: 3)
        let sut = CapabilityFeedPresentation(cards: cards)

        XCTAssertEqual(sut.supporting.count, 2)
        XCTAssertEqual(sut.supporting.map(\.id), ["card-1", "card-2"])
    }

    // MARK: - Overflow

    func testOverflowStartsAtItemSix() {
        let cards = makeCards(count: 8)
        let sut = CapabilityFeedPresentation(cards: cards)

        XCTAssertEqual(sut.overflow.count, 3)
        XCTAssertEqual(sut.overflow.first?.id, "card-5")
    }

    func testExactlyFiveCardsProducesNoOverflow() {
        let cards = makeCards(count: 5)
        let sut = CapabilityFeedPresentation(cards: cards)

        XCTAssertNotNil(sut.hero)
        XCTAssertEqual(sut.supporting.count, 4)
        XCTAssertTrue(sut.overflow.isEmpty)
    }

    func testSixCardsProducesOneOverflow() {
        let cards = makeCards(count: 6)
        let sut = CapabilityFeedPresentation(cards: cards)

        XCTAssertEqual(sut.overflow.count, 1)
        XCTAssertEqual(sut.overflow.first?.id, "card-5")
    }

    // MARK: - Generating Status

    func testIsGeneratingWhenAnyCategoryIsGenerating() {
        let statuses: [String: CategoryStatus] = [
            "productivity": CategoryStatus(status: "ready", relevance: 0.8),
            "communication": CategoryStatus(status: "generating", relevance: nil),
        ]
        let sut = CapabilityFeedPresentation(cards: makeCards(count: 2), categoryStatuses: statuses)

        XCTAssertTrue(sut.isGenerating)
    }

    func testIsNotGeneratingWhenAllReady() {
        let statuses: [String: CategoryStatus] = [
            "productivity": CategoryStatus(status: "ready", relevance: 0.8),
            "communication": CategoryStatus(status: "ready", relevance: 0.6),
        ]
        let sut = CapabilityFeedPresentation(cards: makeCards(count: 2), categoryStatuses: statuses)

        XCTAssertFalse(sut.isGenerating)
    }

    func testIsNotGeneratingWithEmptyStatuses() {
        let sut = CapabilityFeedPresentation(cards: makeCards(count: 2))

        XCTAssertFalse(sut.isGenerating)
    }

    // MARK: - Time-Aware Framing

    func testMorningEyebrow() {
        for hour in 5..<12 {
            let eyebrow = FeedFraming.heroEyebrow(forHour: hour)
            XCTAssertEqual(eyebrow, "Before tomorrow starts", "Hour \(hour) should be morning")
        }
    }

    func testAfternoonEyebrow() {
        for hour in 12..<17 {
            let eyebrow = FeedFraming.heroEyebrow(forHour: hour)
            XCTAssertEqual(eyebrow, "While the afternoon is yours", "Hour \(hour) should be afternoon")
        }
    }

    func testEveningEyebrow() {
        for hour in 17..<21 {
            let eyebrow = FeedFraming.heroEyebrow(forHour: hour)
            XCTAssertEqual(eyebrow, "Before the day wraps up", "Hour \(hour) should be evening")
        }
    }

    func testLateNightEyebrow() {
        for hour in [0, 1, 2, 3, 4, 21, 22, 23] {
            let eyebrow = FeedFraming.heroEyebrow(forHour: hour)
            XCTAssertEqual(eyebrow, "Something to knock out", "Hour \(hour) should be late night")
        }
    }

    // MARK: - Framing Stability

    func testHeroEyebrowReturnsSameValueForSameHour() {
        let a = FeedFraming.heroEyebrow(forHour: 9)
        let b = FeedFraming.heroEyebrow(forHour: 9)
        XCTAssertEqual(a, b)
    }

    // MARK: - Static Framing Strings

    func testSectionHeadersAreNonEmpty() {
        XCTAssertFalse(FeedFraming.heroHeader.isEmpty)
        XCTAssertFalse(FeedFraming.supportingHeader.isEmpty)
        XCTAssertFalse(FeedFraming.overflowHeader.isEmpty)
    }

    func testScrollCTAMatchesExpectedCopy() {
        XCTAssertEqual(FeedFraming.scrollCTA, "There\u{2019}s a lot more I can do")
    }

    func testFeedCloserMatchesExpectedCopy() {
        XCTAssertEqual(FeedFraming.feedCloser, "And anything else you can dream up.")
    }
}
