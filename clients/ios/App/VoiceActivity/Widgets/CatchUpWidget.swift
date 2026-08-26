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

// A Storybook replica copies this file's measurements and palette, at
// `clients/web/src/components/ios-widget-previews/`. Nothing checks the two
// against each other, so a change here wants a look there.

/// Actions on the left, conversations on the right.
///
/// The split is the point: the actions are always available and always in the
/// same place, so the half of the widget that changes cannot move the half the
/// user aims at.
struct CatchUpWidgetView: View {
    let entry: SnapshotEntry

    /// The card every dimension below is designed on. Widget families render
    /// at slightly different sizes per device, so the layout multiplies its
    /// measurements by the ratio between the two and keeps the design's
    /// proportions everywhere instead of gaining margin on large phones and
    /// clipping on small ones.
    private static let designSize = CGSize(width: 339, height: 161)

    /// Width of the action column, sized to the two tiles rather than to a
    /// share of the widget, so the rows beside it get every remaining point.
    private static let actionColumnWidth: CGFloat = 71

    /// The widget disables the system content margins and draws this one
    /// instead: the default margins leave the row list short of the three
    /// rows it is laid out for.
    private static let contentMargin: CGFloat = 16

    /// Gap between the action column and the rows, and between the two tiles.
    private static let columnGap: CGFloat = 14
    private static let tileGap: CGFloat = 7

    /// The header hangs slightly below the top margin and slightly into the
    /// row column, so it reads as a label on the list rather than as a row.
    private static let headerTopInset: CGFloat = 3
    private static let headerLeadingInset: CGFloat = 4
    private static let headerBottomGap: CGFloat = 5

    var body: some View {
        GeometryReader { geo in
            let scale = min(
                geo.size.width / Self.designSize.width,
                geo.size.height / Self.designSize.height
            )
            HStack(alignment: .top, spacing: Self.columnGap * scale) {
                VStack(spacing: Self.tileGap * scale) {
                    WidgetActionTile.newChat(accent: entry.softAccent, avatarImage: entry.avatarImage, scale: scale)
                    WidgetActionTile.voice(scale: scale)
                }
                .frame(width: Self.actionColumnWidth * scale)

                VStack(alignment: .leading, spacing: 0) {
                    Text("Catch up:")
                        .font(.system(size: 10 * scale))
                        .foregroundStyle(WidgetTheme.textSecondary)
                        .padding(.top, Self.headerTopInset * scale)
                        .padding(.leading, Self.headerLeadingInset * scale)
                        .padding(.bottom, Self.headerBottomGap * scale)
                    if entry.conversations.isEmpty {
                        emptyPrompt(scale: scale)
                        Spacer(minLength: 0)
                    } else {
                        rowList(scale: scale)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(Self.contentMargin * scale)
            .frame(width: geo.size.width, height: geo.size.height, alignment: .top)
        }
    }

    /// The number of rows the card is laid out for. The producer sends at most
    /// this many; a snapshot carrying more is malformed, and drawing its
    /// overflow would push rows off the card.
    private static let maxRows = 3

    /// The rows, flush against each other: the space between one title and the
    /// next belongs to the row that owns it, so the list keeps one rhythm
    /// whether or not a row carries a subtitle.
    ///
    /// Each row is drawn at its design height, except that the full count of
    /// rows must fit in what the header leaves: the design's own three rows
    /// overrun the content box by two points, so the rows give that sliver
    /// back rather than lean into the margin the card cannot spare on every
    /// device.
    private func rowList(scale: CGFloat) -> some View {
        GeometryReader { proxy in
            let rows = Array(entry.conversations.prefix(Self.maxRows))
            let height = min(
                CatchUpRow.designHeight * scale,
                proxy.size.height / CGFloat(max(1, rows.count))
            )
            VStack(alignment: .leading, spacing: 0) {
                ForEach(rows, id: \.id) { conversation in
                    linkedRow(for: conversation, height: height, scale: scale)
                }
            }
        }
    }

    /// The row, wrapped in a `Link` when this build declares a URL scheme.
    ///
    /// A missing scheme drops the link and keeps the row: there is no fallback
    /// scheme to reach for (guessing one would send a Dev build's tap into the
    /// production app), and the titles are still true, so the widget loses a
    /// tap target rather than its content.
    @ViewBuilder
    private func linkedRow(
        for conversation: WidgetSnapshotConversation,
        height: CGFloat,
        scale: CGFloat
    ) -> some View {
        let row = CatchUpRow(
            conversation: conversation,
            isStale: entry.isStale,
            height: height,
            scale: scale
        )
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
    private func emptyPrompt(scale: CGFloat) -> some View {
        WidgetPromptText("Open Vellum to see your recent chats.", size: 11 * scale)
            .padding(.top, 2 * scale)
            .padding(.leading, CatchUpRow.leadingInset * scale)
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

    /// The height the owner resolved for this row: the design height, shaved
    /// by up to a point when the full list has to fit the space under the
    /// header.
    let height: CGFloat

    /// The owning card's ratio to the size it was designed at. Every dimension
    /// below is a design value multiplied by it.
    let scale: CGFloat

    /// The row's height when nothing constrains it, and where its pieces sit
    /// in it. The text block hangs from a fixed top inset rather than
    /// centering, so a row without a subtitle keeps its title on the same
    /// line as its neighbors'.
    static let designHeight: CGFloat = 37
    static let leadingInset: CGFloat = 8
    private static let textTopInset: CGFloat = 6
    private static let glyphSize: CGFloat = 12
    private static let glyphTextGap: CGFloat = 7

    /// Where the glyph hangs, by how much text ends up beside it.
    ///
    /// It centers against the lines the row actually draws, which is not one
    /// number: the design's two-line row puts the glyph's middle between the
    /// title and the subtitle, and a row carrying no subtitle has only the
    /// title to center on. Left at the two-line inset, the glyph on a
    /// title-only row hangs below the words instead of beside them.
    private static let glyphTwoLineTopInset: CGFloat = 12.5
    private static let glyphTitleOnlyTopInset: CGFloat = 7

    var body: some View {
        HStack(alignment: .top, spacing: Self.glyphTextGap * scale) {
            statusGlyph
                .frame(width: Self.glyphSize * scale, height: Self.glyphSize * scale)
                .padding(.top, glyphTopInset * scale)
            VStack(alignment: .leading, spacing: 2 * scale) {
                Text(conversation.title)
                    .font(.system(size: 12 * scale, weight: .medium))
                    .foregroundStyle(WidgetTheme.textPrimary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .privacySensitive()
                if let subtitle = renderedSubtitle {
                    Text(subtitle)
                        .font(.system(size: 7 * scale, weight: .medium))
                        .foregroundStyle(WidgetTheme.textSecondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .privacySensitive()
                }
            }
            .padding(.top, Self.textTopInset * scale)
        }
        .padding(.leading, Self.leadingInset * scale)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .frame(height: height, alignment: .top)
    }

    /// The subtitle this row draws, which is not quite the one the snapshot
    /// carries: a group the producer sent as an empty string is a subtitle with
    /// nothing in it to draw.
    ///
    /// The one owner of that question, because the glyph's inset asks it too
    /// and the two cannot be allowed to answer differently: a glyph centered
    /// for a line the row never drew is exactly the misalignment this avoids.
    private var renderedSubtitle: String? {
        guard let subtitle = conversation.subtitle, !subtitle.isEmpty else {
            return nil
        }
        return subtitle
    }

    /// Where the glyph hangs for the text beside it. See the inset pair above.
    private var glyphTopInset: CGFloat {
        renderedSubtitle == nil ? Self.glyphTitleOnlyTopInset : Self.glyphTwoLineTopInset
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
                .font(.system(size: 11 * scale, weight: .bold))
                .foregroundStyle(WidgetTheme.textSecondary)
                .accessibilityLabel("Working")
        } else if conversation.hasUnseen {
            bubble
                .overlay(alignment: .topTrailing) {
                    // Accentable for the reason ``WidgetUnreadMark``'s dot is:
                    // this row draws the same mark at row scale, and a dot left
                    // out of the tint would flatten into the white bubble it
                    // rides and stop marking anything.
                    Circle()
                        .fill(WidgetTheme.unseenIndicator)
                        .frame(width: 4 * scale, height: 4 * scale)
                        .offset(x: 1 * scale, y: -1 * scale)
                        .widgetAccentable()
                }
                .accessibilityLabel("Unread")
        } else {
            bubble
                .accessibilityHidden(true)
        }
    }

    private var bubble: some View {
        Image(systemName: "bubble.left")
            .font(.system(size: 11 * scale))
            .foregroundStyle(WidgetTheme.textPrimary)
    }
}
