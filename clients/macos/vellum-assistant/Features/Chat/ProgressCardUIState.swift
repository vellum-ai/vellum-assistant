import Foundation

// MARK: - Progress Card UI State

/// User-owned interaction state for a progress card that must outlive lazy row
/// churn. SwiftUI's `LazyVStack` recycles views aggressively, destroying any
/// `@State` on offscreen rows. This type captures the interaction state that
/// must be preserved externally (e.g. in a `@Binding` or view model) so the
/// card can be reconstructed identically when scrolled back into view.
///
/// All stored identifiers are stable `UUID`s from `ToolCallData.id`, making
/// the state reconstructable from message/tool IDs alone without any SwiftUI
/// dependency.
struct ProgressCardUIState: Equatable, Sendable {

    // MARK: - Step-Level Expansion

    /// Set of tool call IDs whose detail rows are currently expanded.
    /// Keyed by `ToolCallData.id` (UUID).
    var expandedStepIds: Set<UUID> = []

    // MARK: - Card-Level Expansion Overrides

    /// Per-card expansion overrides set by the user clicking the chevron.
    /// Keyed by the first tool call UUID in the group (the card's stable identity).
    /// When present, overrides auto-expand logic from feature flags and
    /// pending-confirmation heuristics.
    var cardExpansionOverrides: [UUID: Bool] = [:]

    // MARK: - Thinking Duration Persistence

    /// Per-card thinking durations (in seconds) for the post-tool-completion
    /// thinking phase. Keyed by the first tool call UUID in the group.
    /// Persisted so the thinking row survives view recycling with correct timing.
    var thinkingDurations: [UUID: TimeInterval] = [:]

    // MARK: - Card Completion Anchor Persistence

    /// Per-card completion timestamp captured at the first `.complete` phase
    /// transition. Persisted so the header total duration survives view
    /// recycling — rehydrating from `model.latestCompletedAt` (the last tool's
    /// end) loses any post-tool thinking/latency tail and re-introduces the
    /// exact regression the anchor is meant to prevent.
    var cardCompletedDates: [UUID: Date] = [:]

    // MARK: - Rehydration Tracking

    /// Set of group IDs (first tool call UUID) for which rehydration has already
    /// been triggered during the current view lifecycle. Prevents redundant
    /// network calls when the same card is scrolled in and out of view.
    var rehydratedGroupIds: Set<UUID> = []

    // MARK: - Queries

    /// Returns whether the step with the given tool call ID is expanded.
    func isStepExpanded(_ toolCallId: UUID) -> Bool {
        expandedStepIds.contains(toolCallId)
    }

    /// Returns the user's explicit card expansion override for the group
    /// identified by `cardKey`, or `nil` if no override has been set.
    func cardExpansionOverride(for cardKey: UUID) -> Bool? {
        cardExpansionOverrides[cardKey]
    }

    /// Resolves the effective expansion state for a card, combining the user
    /// override (if any) with the model's `shouldAutoExpand` recommendation.
    func resolveCardExpanded(
        cardKey: UUID?,
        model: ProgressCardPresentationModel
    ) -> Bool {
        if let key = cardKey, let override = cardExpansionOverrides[key] {
            return override
        }
        return model.shouldAutoExpand
    }

    /// Returns the persisted thinking duration for the given card, or nil if none.
    func thinkingDuration(for cardKey: UUID) -> TimeInterval? {
        thinkingDurations[cardKey]
    }

    /// Returns the persisted completion timestamp for the given card, or nil if none.
    func cardCompletedAt(for cardKey: UUID) -> Date? {
        cardCompletedDates[cardKey]
    }

    /// Whether rehydration has already been performed for the given group.
    func hasRehydrated(groupId: UUID) -> Bool {
        rehydratedGroupIds.contains(groupId)
    }

    // MARK: - Mutations

    /// Toggles the expansion state of an individual step detail row.
    mutating func toggleStepExpansion(_ toolCallId: UUID) {
        if expandedStepIds.contains(toolCallId) {
            expandedStepIds.remove(toolCallId)
        } else {
            expandedStepIds.insert(toolCallId)
        }
    }

    /// Sets the step expansion state explicitly.
    mutating func setStepExpanded(_ toolCallId: UUID, expanded: Bool) {
        if expanded {
            expandedStepIds.insert(toolCallId)
        } else {
            expandedStepIds.remove(toolCallId)
        }
    }

    /// Records a user-initiated card expansion toggle, storing the override
    /// so it persists across view recycling.
    mutating func setCardExpansionOverride(cardKey: UUID, expanded: Bool) {
        cardExpansionOverrides[cardKey] = expanded
    }

    /// Stores the thinking duration for a completed card so it survives view recycling.
    mutating func setThinkingDuration(for cardKey: UUID, duration: TimeInterval) {
        thinkingDurations[cardKey] = duration
    }

    /// Stores the card's completion timestamp so it survives view recycling.
    mutating func setCardCompletedAt(for cardKey: UUID, date: Date) {
        cardCompletedDates[cardKey] = date
    }

    /// Clears the persisted completion timestamp for a card. Called when tools
    /// resume after a transient `.complete` (multi-wave execution) so the next
    /// completion captures a fresh anchor.
    mutating func clearCardCompletedAt(for cardKey: UUID) {
        cardCompletedDates.removeValue(forKey: cardKey)
    }

    /// Marks a group as having been rehydrated.
    mutating func markRehydrated(groupId: UUID) {
        rehydratedGroupIds.insert(groupId)
    }

    /// Resets all state. Useful when switching conversations.
    mutating func reset() {
        expandedStepIds.removeAll()
        cardExpansionOverrides.removeAll()
        thinkingDurations.removeAll()
        cardCompletedDates.removeAll()
        rehydratedGroupIds.removeAll()
    }
}
