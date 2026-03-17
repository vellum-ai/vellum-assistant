import Foundation
import VellumAssistantShared

// MARK: - Feed Presentation Model

/// Pure presentation model that partitions an already-ordered `[CapabilityCard]` array
/// into hero, supporting, and overflow buckets for the concierge-style capability feed.
///
/// This builder is deterministic, isolated from SwiftUI, and does not invent new backend
/// ranking heuristics — it relies entirely on the server-provided ordering.
struct CapabilityFeedPresentation {

    /// The single headline card shown with prominence.
    let hero: CapabilityCard?

    /// A small set of secondary cards shown beneath the hero (up to `maxSupportingCount`).
    let supporting: [CapabilityCard]

    /// Remaining cards available via an expandable overflow section.
    let overflow: [CapabilityCard]

    /// Maximum number of cards in the supporting bucket.
    static let maxSupportingCount = 4

    /// Index at which overflow begins (hero + supporting).
    static let overflowStartIndex = 1 + maxSupportingCount // 5

    /// Whether any cards are still being generated.
    let isGenerating: Bool

    /// Builds a presentation from the server-ordered card array and category statuses.
    ///
    /// - Parameters:
    ///   - cards: Cards in the order the backend determined (highest priority first).
    ///   - categoryStatuses: Per-category generation status from the backend.
    init(cards: [CapabilityCard], categoryStatuses: [String: CategoryStatus] = [:]) {
        self.hero = cards.first

        let supportingEnd = min(Self.overflowStartIndex, cards.count)
        self.supporting = cards.count > 1
            ? Array(cards[1..<supportingEnd])
            : []

        self.overflow = cards.count > Self.overflowStartIndex
            ? Array(cards[Self.overflowStartIndex...])
            : []

        self.isGenerating = categoryStatuses.values.contains { $0.status == "generating" }
    }
}

// MARK: - Editorial Framing Strings

/// Centralized editorial copy for the capability feed UI.
///
/// All user-facing framing strings live here so that `CapabilitiesFeedView`,
/// `ScrollCTAView`, and `ChatEmptyStateView` can reference a single source of truth
/// instead of duplicating copy.
enum FeedFraming {

    // MARK: Section Headers

    /// Hero section header — shown above the primary card.
    static let heroHeader = "Do this first"

    /// Supporting section header — shown above the secondary cards.
    static let supportingHeader = "A few useful wins"

    /// Overflow section header — shown above the expandable card list.
    static let overflowHeader = "More ideas for you"

    // MARK: Time-Aware Hero Eyebrows

    /// Returns a time-aware eyebrow string for the hero card based on the current hour.
    ///
    /// - Parameter hour: The hour of the day in 24-hour format (0–23).
    /// - Returns: A contextual eyebrow string.
    static func heroEyebrow(forHour hour: Int) -> String {
        switch hour {
        case 5..<12:
            return "Before tomorrow starts"
        case 12..<17:
            return "While the afternoon is yours"
        case 17..<21:
            return "Before the day wraps up"
        default:
            return "Something to knock out"
        }
    }

    /// Returns a hero eyebrow for the current time.
    static var currentHeroEyebrow: String {
        heroEyebrow(forHour: Calendar.current.component(.hour, from: Date()))
    }

    // MARK: Feed Chrome

    /// Scroll CTA copy inviting the user to explore more capabilities.
    static let scrollCTA = "There\u{2019}s a lot more I can do"

    /// Soft closer text at the bottom of the full feed.
    static let feedCloser = "And anything else you can dream up."
}
