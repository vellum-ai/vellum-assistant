import SwiftUI
import VellumAssistantShared

/// Unified row used by both the "These need your attention" and
/// "Here's what I've been up to" sections of the redesigned Home page.
///
/// Intentionally renders the same layout for every feed item type so the
/// two sections read as a consistent editorial list rather than a
/// hodge-podge of nudges + rows + cards. Type-specific affordances are
/// reduced to two dimensions:
///
///   - `author` / `type` → small uppercase badge ("Automatic" / "User")
///   - `showsCompletion` → trailing checkmark button on attention items
///
/// The body handles its own hit-test: tapping the main row fires
/// `onTap` (the parent opens a pre-seeded conversation), the check
/// button fires `onComplete` and never bubbles up to the row tap.
struct HomeActivityRow: View {
    let item: FeedItem
    let onTap: () -> Void
    /// When provided, renders a trailing check affordance. Used by the
    /// attention section to let the user mark a nudge/action done
    /// without opening it.
    let onComplete: (() -> Void)?

    init(
        item: FeedItem,
        onTap: @escaping () -> Void,
        onComplete: (() -> Void)? = nil
    ) {
        self.item = item
        self.onTap = onTap
        self.onComplete = onComplete
    }

    var body: some View {
        Button(action: onTap) {
            HStack(alignment: .top, spacing: VSpacing.md) {
                statusDot
                    .padding(.top, 6)

                VStack(alignment: .leading, spacing: VSpacing.xxs) {
                    HStack(spacing: VSpacing.xs) {
                        Text(item.title)
                            .font(VFont.bodyMediumEmphasised)
                            .foregroundStyle(VColor.contentEmphasized)
                            .lineLimit(1)
                            .truncationMode(.tail)

                        badge
                    }

                    Text(subtitle)
                        .font(VFont.bodySmallDefault)
                        .foregroundStyle(VColor.contentTertiary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }

                Spacer(minLength: VSpacing.sm)

                Text(Self.relativeTimestamp(item.timestamp))
                    .font(VFont.labelSmall)
                    .foregroundStyle(VColor.contentTertiary)
                    .monospacedDigit()
                    .fixedSize(horizontal: true, vertical: false)

                if let onComplete {
                    completeButton(action: onComplete)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Text(item.title))
        .accessibilityHint(Text(item.summary))
    }

    // MARK: - Status dot

    /// Small filled circle on the leading edge. Green when the item is
    /// still unread; muted dot when it has already been seen or acted
    /// on. Matches the reference design exactly.
    private var statusDot: some View {
        Circle()
            .fill(item.status == .new ? VColor.funGreen : VColor.contentTertiary.opacity(0.35))
            .frame(width: 8, height: 8)
    }

    // MARK: - Badge

    private var badge: some View {
        Text(badgeLabel)
            .font(VFont.labelSmall)
            .foregroundStyle(VColor.contentSecondary)
            .padding(.horizontal, VSpacing.sm)
            .padding(.vertical, 2)
            .background(
                RoundedRectangle(cornerRadius: VRadius.sm, style: .continuous)
                    .fill(VColor.surfaceActive)
            )
    }

    /// Maps the item type onto the design's two-state badge. Nudges,
    /// digests, and actions are all assistant-driven so they read as
    /// "Automatic"; threads are user-started so they read as "User".
    private var badgeLabel: String {
        switch item.type {
        case .thread:
            return "User"
        case .nudge, .digest, .action:
            return "Automatic"
        }
    }

    // MARK: - Subtitle

    /// Secondary line under the title. Prefers the item summary (usually
    /// the conversation thread name or a one-liner) and falls back to a
    /// type-specific placeholder only when the summary is empty so the
    /// row never collapses to a single line.
    private var subtitle: String {
        let trimmed = item.summary.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { return trimmed }
        switch item.type {
        case .thread:  return "Conversation"
        case .digest:  return "Recap"
        case .nudge:   return "Nudge"
        case .action:  return "Suggested action"
        }
    }

    // MARK: - Complete button

    /// Circular check affordance shown only on attention items. Wrapped
    /// in its own `Button` so taps don't propagate to the outer row
    /// button — SwiftUI will fire the innermost plain button first.
    private func completeButton(action: @escaping () -> Void) -> some View {
        Button(action: action) {
            ZStack {
                Circle()
                    .strokeBorder(VColor.borderBase, lineWidth: 1)
                VIconView(.check, size: 11)
                    .foregroundStyle(VColor.contentSecondary)
            }
            .frame(width: 22, height: 22)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text("Mark done"))
    }

    // MARK: - Timestamp

    static func relativeTimestamp(_ date: Date, now: Date = Date()) -> String {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter.localizedString(for: date, relativeTo: now)
    }
}
