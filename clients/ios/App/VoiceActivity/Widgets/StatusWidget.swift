import SwiftUI
import UIKit
import WidgetKit

/// The small Home Screen widget, in the two states it has: what is waiting when
/// something is, and the ways in when nothing is.
///
/// Small only. Two numbers over two buttons, or three buttons on their own, is
/// what the family fits, and it is the whole idea: this is the widget for
/// someone who wants the count without the list, so a medium version would just
/// be the Catch Up widget with its rows deleted.
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
        .description("See what is unread or still working in Vellum, with camera, voice and chat a tap away when nothing is waiting.")
        .supportedFamilies([.systemSmall])
        .contentMarginsDisabled()
    }
}

/// One card that swaps what it is for: a readout when the account has something
/// waiting, a launcher when it does not.
///
/// A count is worth a small widget's card only while there is a count. A card
/// printing "All caught up." over two buttons spends most of itself saying
/// nothing, so the space goes instead to the three things people open the app
/// to do.
///
/// Both states are laid out on the same margins and the same two bands, so the
/// flip changes what the card offers rather than where it draws.
struct StatusWidgetView: View {
    let entry: SnapshotEntry

    /// The widget disables the system content margins and draws this one
    /// instead: the layout is drawn at these margins, and the system's own
    /// inset would leave the controls short of the size they are specified at.
    private static let contentMargin: CGFloat = 16

    /// The height a control is drawn at where the family has room for it, and
    /// the gap between the card's two bands. A shorter widget splits what it
    /// has between the bands rather than overflowing its margins.
    private static let preferredControlHeight: CGFloat = 61
    private static let bandGap: CGFloat = 7

    /// Gap inside a band: between the two circles, and between the two tiles.
    private static let circleGap: CGFloat = 6
    private static let tileGap: CGFloat = 8

    /// Gap between the two count lines, and the column their glyphs sit in.
    /// The column is wide enough for the wider of the two, so the counts start
    /// at the same place whichever lines are drawn.
    private static let countGap: CGFloat = 12
    private static let glyphColumnWidth: CGFloat = 20

    var body: some View {
        GeometryReader { proxy in
            let control = Self.controlHeight(fitting: proxy.size)
            VStack(spacing: 0) {
                if isActive {
                    counts
                    Spacer(minLength: Self.bandGap)
                    actionTiles(height: control)
                } else {
                    circles(diameter: control)
                    Spacer(minLength: Self.bandGap)
                    chatPill(height: control)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .padding(Self.contentMargin)
    }

    /// Whether there is anything to report.
    ///
    /// A stale snapshot is not. Its counts are claims about an inbox from half
    /// an hour ago, and on a card that is nothing but a readout, a lone
    /// "2 unread" also asserts that nothing is running, which an aged snapshot
    /// cannot know. The launcher is a true thing to show in their place, and a
    /// more useful one than a sentence apologizing for the counts.
    private var isActive: Bool {
        guard !entry.isStale, let snapshot = entry.snapshot else {
            return false
        }
        return snapshot.unreadCount > 0 || snapshot.inProgressCount > 0
    }

    /// The height of one control, capped at the size the card is laid out for
    /// and otherwise cut to whichever dimension runs out first.
    ///
    /// Both states stack two bands of controls, or one band under the counts,
    /// so the same number sizes the circles, the pill and the tiles. Deriving
    /// it rather than fixing it is what keeps the card inside its margins on
    /// the smaller phones, where a small widget is a good deal short of the
    /// size this is drawn at.
    private static func controlHeight(fitting size: CGSize) -> CGFloat {
        min(preferredControlHeight, (size.height - bandGap) / 2, (size.width - circleGap) / 2)
    }

    /// The two most physical actions, as circles: a shape the eye separates
    /// from the wide pill under them before it reads either one.
    private func circles(diameter: CGFloat) -> some View {
        HStack(spacing: Self.circleGap) {
            CircleActionButton(
                intent: OpenCameraIntent(),
                icon: Image(systemName: "camera.fill"),
                label: "Take a photo",
                fill: WidgetTheme.voiceFill,
                tint: WidgetTheme.textPrimary,
                diameter: diameter
            )
            CircleActionButton(
                intent: StartNewVoiceConversationIntent(),
                icon: Image(systemName: "waveform"),
                label: "New voice conversation",
                fill: WidgetTheme.voiceFill,
                tint: WidgetTheme.textPrimary,
                diameter: diameter
            )
        }
    }

    /// Chat, given the whole width because it is the action most people want
    /// most often, and the pill is the only shape on a small widget that can
    /// say so.
    private func chatPill(height: CGFloat) -> some View {
        PillActionButton(
            intent: OpenNewChatIntent(),
            icon: Image("VellumV"),
            title: "Chat",
            fill: entry.softAccent.fill,
            tint: entry.softAccent.onFill,
            height: height,
            avatarImage: entry.avatarImage
        )
    }

    /// The pair the readout state ends on. Voice keeps the neutral fill, so the
    /// two read as a primary action and a secondary one.
    private func actionTiles(height: CGFloat) -> some View {
        HStack(spacing: Self.tileGap) {
            WidgetActionTile.newChat(accent: entry.softAccent, avatarImage: entry.avatarImage)
            WidgetActionTile.voice
        }
        .frame(height: height)
    }

    /// The counts, each dropping its line rather than printing "0".
    private var counts: some View {
        VStack(alignment: .leading, spacing: Self.countGap) {
            if let count = entry.snapshot?.unreadCount, count > 0 {
                countLine(glyph: unreadGlyph, text: "\(count) unread")
            }
            if let count = entry.snapshot?.inProgressCount, count > 0 {
                countLine(glyph: inProgressGlyph, text: "\(count) in progress")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// The glyph is decorative: the text beside it already says everything
    /// VoiceOver needs to read.
    ///
    /// The line is `.privacySensitive()` while the glyph beside it is not,
    /// matching the Quick Actions chip: a locked device still shows that
    /// something is waiting without spelling out how far behind its owner is.
    private func countLine(glyph: some View, text: String) -> some View {
        HStack(spacing: 7) {
            glyph
                .frame(width: Self.glyphColumnWidth, alignment: .leading)
                .accessibilityHidden(true)
            Text(text)
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(WidgetTheme.textPrimary)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                .privacySensitive()
        }
    }

    /// The outline bubble, since this card is the white one, in the primary
    /// text color the line beside it is drawn in.
    private var unreadGlyph: some View {
        WidgetUnreadMark(isFilled: false, size: 16)
            .foregroundStyle(WidgetTheme.textPrimary)
    }

    /// The dots a Catch Up row marks a turn in flight with, at the size this
    /// card's lines are drawn at.
    private var inProgressGlyph: some View {
        Image(systemName: "ellipsis")
            .font(.system(size: 16, weight: .bold))
            .foregroundStyle(WidgetTheme.textSecondary)
    }
}

#if DEBUG

/// This widget's card: the shared wrapper over the flat surface token, which is
/// what the widget itself paints its container with.
private func statusPreviewCard(_ entry: SnapshotEntry) -> some View {
    previewWidgetCard {
        StatusWidgetView(entry: entry)
    } background: {
        WidgetTheme.surface
    }
}

#Preview("Idle") {
    previewAppearances {
        statusPreviewCard(previewEntry())
    }
}

#Preview("Active") {
    previewAppearances {
        statusPreviewCard(previewEntry(unread: 3, inProgress: 2))
    }
}

#Preview("Active, unread only") {
    previewAppearances {
        statusPreviewCard(previewEntry(unread: 1))
    }
}

#Preview("Custom avatar") {
    let avatar = WidgetSnapshotAvatar(
        kind: "image",
        accentHex: nil,
        imageData: previewAvatarPhoto().pngData()
    )
    previewAppearances {
        HStack(spacing: 12) {
            statusPreviewCard(previewEntry(avatar: avatar))
            statusPreviewCard(previewEntry(unread: 3, inProgress: 2, avatar: avatar))
        }
    }
}

#Preview("Character accent") {
    // The light accent is the one worth looking at: its wash has to stay a pale
    // card with the word still legible on it.
    let avatar = WidgetSnapshotAvatar(
        kind: "character",
        accentHex: "#F2C94C",
        imageData: previewAvatarPhoto().pngData()
    )
    previewAppearances {
        HStack(spacing: 12) {
            statusPreviewCard(previewEntry(avatar: avatar))
            statusPreviewCard(previewEntry(unread: 3, inProgress: 2, avatar: avatar))
        }
    }
}

#endif
