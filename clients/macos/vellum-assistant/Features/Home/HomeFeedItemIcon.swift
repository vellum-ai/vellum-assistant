import SwiftUI
import VellumAssistantShared

/// Tiny helper view that maps a `FeedItemSource` to a design-system icon.
///
/// Used by both `HomeFeedNudgeCard` and `HomeFeedListRow` so every feed item
/// surfaces a consistent source glyph (Gmail / Slack / Calendar / assistant /
/// unknown) without each call site re-implementing the mapping.
///
/// Icons are resolved through `VIconView` so they honour the vendored Lucide
/// PDF catalogue — never raw `Image(systemName:)` — and are tinted with the
/// muted content token so they sit quietly next to a prominent title.
///
/// This view is intentionally stateless and takes only a single
/// `source: FeedItemSource?` plus an optional size override (defaulting to a
/// 16pt glyph that matches `HomeFactsSection.emptyState`'s sparkles icon).
struct HomeFeedItemIcon: View {
    let source: FeedItemSource?
    var size: CGFloat = 16

    var body: some View {
        VIconView(Self.icon(for: source), size: size)
            .foregroundStyle(VColor.contentTertiary)
            .accessibilityHidden(true)
    }

    /// Source → icon mapping. Kept exhaustive so a new `FeedItemSource` case
    /// forces this switch to be updated (matches the TDD "closed set in v1"
    /// contract noted on the Swift enum).
    static func icon(for source: FeedItemSource?) -> VIcon {
        guard let source else { return .circle }
        switch source {
        case .gmail:     return .mail
        case .slack:     return .messageSquare
        case .calendar:  return .calendar
        case .assistant: return .sparkles
        }
    }
}
