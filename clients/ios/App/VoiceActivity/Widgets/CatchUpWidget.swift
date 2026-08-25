import SwiftUI
import WidgetKit

/// The medium Home Screen widget: what happened while you were away, and the
/// two ways to start something new.
///
/// Medium only. The left column's two actions and three legible conversation
/// rows are what the widget is for, and neither the small nor the large family
/// renders that: small fits one of the two halves, and large would pad three
/// rows with empty card.
///
/// Every row is a `Link` rather than a `Button(intent:)`. Opening a
/// conversation is navigation, the URL is the same one the SPA already parses
/// from Siri and from Safari, and the system opens a `Link` itself, which is
/// one fewer process hop than an intent that would only turn around and hand
/// the same URL to the shell.
struct CatchUpWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(
            kind: VellumWidgetKind.catchUp,
            provider: SnapshotProvider()
        ) { entry in
            CatchUpWidgetView(entry: entry)
                .containerBackground(WidgetTheme.surface, for: .widget)
        }
        .configurationDisplayName("Catch Up")
        .description("See your most recent Vellum conversations and start a new chat or a voice session.")
        .supportedFamilies([.systemMedium])
        .contentMarginsDisabled()
    }
}

/// Actions on the left, conversations on the right.
///
/// The split is the point: the actions are always available and always in the
/// same place, so the half of the widget that changes cannot move the half the
/// user aims at.
struct CatchUpWidgetView: View {
    let entry: SnapshotEntry

    /// Width of the action column, sized to the two tiles rather than to a
    /// share of the widget, so the rows beside it get every remaining point.
    private static let actionColumnWidth: CGFloat = 71

    /// The widget disables the system content margins and draws this one
    /// instead: the default margins leave the row list short of the three
    /// rows it is laid out for.
    private static let contentMargin: CGFloat = 16

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            VStack(spacing: 7) {
                WidgetActionTile.newChat(accent: entry.softAccent, avatarImage: entry.avatarImage)
                WidgetActionTile.voice
            }
            .frame(width: Self.actionColumnWidth)

            VStack(alignment: .leading, spacing: 0) {
                Text("Catch up:")
                    .font(.system(size: 10))
                    .foregroundStyle(WidgetTheme.textSecondary)
                    .padding(.bottom, 5)
                if entry.conversations.isEmpty {
                    emptyPrompt
                    Spacer(minLength: 0)
                } else {
                    rowList
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(Self.contentMargin)
    }

    /// The rows, sized to the space left under the header rather than to a
    /// fixed height: the medium widget is 148pt tall on a 4.7-inch phone, which
    /// is too short for three rows at the height the taller phones draw them.
    private var rowList: some View {
        GeometryReader { proxy in
            let height = rowHeight(fitting: proxy.size.height)
            VStack(alignment: .leading, spacing: 0) {
                ForEach(entry.conversations, id: \.id) { conversation in
                    linkedRow(for: conversation, height: height)
                }
                Spacer(minLength: 0)
            }
        }
    }

    /// The rows split the available height evenly, capped so a tall widget does
    /// not stretch them past the height they are designed at, and floored so a
    /// short one keeps them legible instead of collapsing the subtitle.
    private func rowHeight(fitting available: CGFloat) -> CGFloat {
        let share = available / CGFloat(max(1, entry.conversations.count))
        return min(CatchUpRow.preferredHeight, max(CatchUpRow.minimumHeight, share))
    }

    /// The row, wrapped in a `Link` when this build declares a URL scheme.
    ///
    /// A missing scheme drops the link and keeps the row: there is no fallback
    /// scheme to reach for (guessing one would send a Dev build's tap into the
    /// production app), and the titles are still true, so the widget loses a
    /// tap target rather than its content.
    @ViewBuilder
    private func linkedRow(for conversation: WidgetSnapshotConversation, height: CGFloat) -> some View {
        let row = CatchUpRow(conversation: conversation, isStale: entry.isStale, height: height)
        if let url = ThreadDeepLink(threadId: conversation.id).url() {
            Link(destination: url) { row }
        } else {
            row
        }
    }

    /// One line covering both empty cases, because they are the same to the
    /// person reading it: nothing synced (signed out, fresh install, a shell
    /// older than the sync) and nothing to sync (no conversations yet) both
    /// end with opening the app. The actions beside it stay live, so the
    /// widget is still a way in.
    private var emptyPrompt: some View {
        WidgetPromptText("Open Vellum to see your recent chats.", size: 11)
            .padding(.top, 2)
    }
}

/// One conversation: a status glyph, the title, and the group it belongs to.
///
/// Title and subtitle are `.privacySensitive()`, so iOS redacts them on a
/// locked device. That redaction is what makes it defensible to carry titles
/// into the snapshot at all: the widget can say a conversation is waiting
/// without spelling out which one to whoever picks the phone up.
struct CatchUpRow: View {
    let conversation: WidgetSnapshotConversation

    /// Whether the snapshot behind this row has stopped being trustworthy
    /// about work in flight. See ``SnapshotProvider/staleAfter``.
    let isStale: Bool

    /// Rows sit flush against each other, so the space between a title and the
    /// next one belongs to the row that owns it rather than to a gap the eye
    /// has to assign. The owner picks the height from what the widget has room
    /// for, between ``minimumHeight`` and ``preferredHeight``.
    let height: CGFloat

    /// The height a row is drawn at when the widget has the room, and the floor
    /// it stops shrinking at when it does not: below the floor the title and
    /// subtitle stop clearing their own line heights.
    static let preferredHeight: CGFloat = 37
    static let minimumHeight: CGFloat = 31

    var body: some View {
        HStack(spacing: 7) {
            statusGlyph
                .frame(width: 12, height: 12)
            VStack(alignment: .leading, spacing: 2) {
                Text(conversation.title)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(WidgetTheme.textPrimary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .privacySensitive()
                if let subtitle = conversation.subtitle, !subtitle.isEmpty {
                    Text(subtitle)
                        .font(.system(size: 9, weight: .medium))
                        .foregroundStyle(WidgetTheme.textSecondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .privacySensitive()
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .frame(height: height)
    }

    /// Working beats unread, and staleness beats working.
    ///
    /// A turn in flight is the more useful of the two facts and the more
    /// perishable, which is why it is the one that drops once the snapshot
    /// ages out: nothing has confirmed that turn is still running, and an
    /// indicator claiming otherwise is the row lying. Unread survives, because
    /// it is a fact about a message that already arrived and stays true until
    /// someone reads it, which takes opening the app and resyncing.
    ///
    /// The working treatment is deliberately generic. The snapshot carries no
    /// `statusText`, so this says "something is happening here" and nothing
    /// more, rather than fossilizing wording the SPA deploys continuously.
    @ViewBuilder
    private var statusGlyph: some View {
        if conversation.isProcessing && !isStale {
            Image(systemName: "ellipsis")
                .font(.system(size: 11, weight: .bold))
                .foregroundStyle(WidgetTheme.textSecondary)
                .accessibilityLabel("Working")
        } else if conversation.hasUnseen {
            bubble
                .overlay(alignment: .topTrailing) {
                    Circle()
                        .fill(WidgetTheme.unseenIndicator)
                        .frame(width: 4, height: 4)
                        .offset(x: 1, y: -1)
                }
                .accessibilityLabel("Unread")
        } else {
            bubble
                .accessibilityHidden(true)
        }
    }

    private var bubble: some View {
        Image(systemName: "bubble.left")
            .font(.system(size: 11))
            .foregroundStyle(WidgetTheme.textPrimary)
    }
}
