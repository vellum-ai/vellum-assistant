import SwiftUI
import VellumAssistantShared

/// Compact, tappable row that renders a `FeedItem` whose `type` is one of
/// `.digest`, `.action`, or `.thread`.
///
/// These are the "quiet" feed items — they live under any nudges as a
/// vertical list with a thin divider between rows. Tapping a row fires
/// `onTap`; the wiring PR uses that to open a new conversation pre-seeded
/// with the item's first action prompt (or a canned "tell me more"
/// fallback) via the daemon's feed HTTP route.
///
/// Layout (left → right):
///
///   icon · title / summary  · spacer · relative timestamp
///   divider
///
/// The row is wrapped in a `.plain`-style `Button` so the whole horizontal
/// area is a hit target without any platform button chrome.
struct HomeFeedListRow: View {
    let item: FeedItem
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                rowContent
                divider
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityHint(Text("Opens a conversation about this item"))
    }

    // MARK: - Row body

    private var rowContent: some View {
        HStack(alignment: .top, spacing: VSpacing.sm) {
            HomeFeedItemIcon(source: item.source)
                .padding(.top, VSpacing.xxs)

            VStack(alignment: .leading, spacing: VSpacing.xxs) {
                Text(item.title)
                    .font(VFont.bodyMediumEmphasised)
                    .foregroundStyle(VColor.contentEmphasized)
                    .lineLimit(1)
                    .truncationMode(.tail)

                if !item.summary.isEmpty {
                    Text(item.summary)
                        .font(VFont.bodySmallDefault)
                        .foregroundStyle(VColor.contentSecondary)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            Spacer(minLength: VSpacing.sm)

            Text(Self.relativeTimestamp(item.timestamp))
                .font(VFont.labelSmall)
                .foregroundStyle(VColor.contentTertiary)
                .monospacedDigit()
                .lineLimit(1)
                .fixedSize(horizontal: true, vertical: false)
        }
        .padding(.vertical, VSpacing.sm)
    }

    // MARK: - Divider

    /// Hairline divider below each row. Uses `borderBase` — the same token
    /// `HomeIdentityPanel` uses for its metadata separator — so list rows
    /// feel consistent with the other Home sections.
    private var divider: some View {
        Rectangle()
            .fill(VColor.borderBase)
            .frame(height: 1)
            .accessibilityHidden(true)
    }

    // MARK: - Relative timestamp

    /// Produces a short relative timestamp (e.g. "5m ago", "2h ago") for the
    /// right-hand column. Uses `RelativeDateTimeFormatter` in its `.abbreviated`
    /// style to keep the label narrow so it never pushes the title into
    /// truncation on medium-width windows.
    static func relativeTimestamp(_ date: Date, now: Date = Date()) -> String {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter.localizedString(for: date, relativeTo: now)
    }
}
