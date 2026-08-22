import SwiftUI
import WidgetKit

/// The small Home Screen widget: how much is waiting, and the two ways in.
///
/// Small only. Two numbers over two buttons is what the family fits, and it is
/// the whole idea: this is the widget for someone who wants the count without
/// the list, so a medium version would just be the Catch Up widget with its
/// rows deleted.
///
/// It declares no `widgetURL`, deliberately. A tap outside the buttons should
/// land the user wherever they left off, which is what a widget carrying no URL
/// already does. Every custom-scheme host the web layer parses is a command
/// (`voice`, `thread`, `camera`, `new-chat`), so there is no plain-open URL to
/// hand over, and minting one would add a launch destination to keep in sync
/// with the SPA for no change in behavior.
struct StatusWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(
            kind: VellumWidgetKind.status,
            provider: SnapshotProvider()
        ) { entry in
            StatusWidgetView(entry: entry)
                .containerBackground(WidgetTheme.surface, for: .widget)
        }
        .configurationDisplayName("Status")
        .description("See how much is unread or still working in Vellum, and start a new chat or voice session.")
        .supportedFamilies([.systemSmall])
    }
}

/// The readout on top, the actions along the bottom.
struct StatusWidgetView: View {
    let entry: SnapshotEntry

    /// Height of the action row, so the tiles claim a fixed strip rather than
    /// growing into the readout above them: both tiles fill whatever frame
    /// they are handed.
    private static let actionRowHeight: CGFloat = 54

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            readout
            Spacer(minLength: 0)
            HStack(spacing: 7) {
                WidgetActionTile.newChat
                WidgetActionTile.voice
            }
            .frame(height: Self.actionRowHeight)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// The counts, or the one sentence that stands in for them.
    ///
    /// A count of zero drops its line rather than printing "0", and two zeroes
    /// are said once instead of twice.
    ///
    /// Staleness drops both lines, not just the perishable one. On a widget
    /// that is nothing but a readout, a lone "2 unread" also asserts that
    /// nothing is running, which an aged snapshot cannot know. The Catch Up
    /// rows keep their unread markers past the same threshold because each one
    /// hangs off a conversation the reader recognizes; a bare number has
    /// nothing to qualify it.
    ///
    /// The three prompts that stand in for the counts are three different
    /// facts rather than spare wordings of one: nothing has ever synced, the
    /// snapshot is too old to read as a status, or there is genuinely nothing
    /// waiting. The buttons below stay live in all three, so the widget is
    /// still a way in when it has nothing to report.
    @ViewBuilder
    private var readout: some View {
        if let snapshot = entry.snapshot {
            if entry.isStale {
                WidgetPromptText("Open Vellum for the latest.")
            } else if snapshot.unreadCount <= 0, snapshot.inProgressCount <= 0 {
                WidgetPromptText("All caught up.")
            } else {
                VStack(alignment: .leading, spacing: 6) {
                    if snapshot.unreadCount > 0 {
                        countLine(icon: "bubble.left", text: "\(snapshot.unreadCount) unread")
                    }
                    if snapshot.inProgressCount > 0 {
                        countLine(icon: "ellipsis.bubble", text: "\(snapshot.inProgressCount) in progress")
                    }
                }
            }
        } else {
            WidgetPromptText("Open Vellum to see what is waiting.")
        }
    }

    /// The glyph is decorative: the text beside it already says everything
    /// VoiceOver needs to read.
    ///
    /// The line is `.privacySensitive()` while the glyph beside it is not,
    /// matching the Quick Actions chip: a locked device still shows that
    /// something is waiting without spelling out how far behind its owner is.
    private func countLine(icon: String, text: String) -> some View {
        HStack(spacing: 6) {
            Image(systemName: icon)
                .font(.system(size: 12))
                .foregroundStyle(WidgetTheme.brand)
                .frame(width: 14)
                .accessibilityHidden(true)
            Text(text)
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(WidgetTheme.textPrimary)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                .privacySensitive()
        }
    }
}
