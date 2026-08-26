import AppIntents
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

// A Storybook replica copies this file's measurements and palette, at
// `clients/web/src/components/ios-widget-previews/`. Nothing checks the two
// against each other, so a change here wants a look there.

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

    /// The card every dimension below is designed on. Widget families render
    /// at slightly different sizes per device, so the layout multiplies its
    /// measurements by the ratio between the two and keeps the design's
    /// proportions everywhere instead of gaining margin on large phones and
    /// clipping on small ones.
    private static let designSize = CGSize(width: 160, height: 161)

    /// The widget disables the system content margins and draws this one
    /// instead: the layout is drawn at these margins, and the system's own
    /// inset would leave the controls short of the size they are specified at.
    private static let contentMargin: CGFloat = 16

    /// The height of a control band, and the minimum gap between the card's
    /// two bands.
    private static let controlHeight: CGFloat = 61
    private static let bandGap: CGFloat = 7

    /// Gap inside a band: between the two circles, and between the two tiles.
    private static let circleGap: CGFloat = 6
    private static let tileGap: CGFloat = 8

    /// Gap between the two count lines, and the column their glyphs sit in.
    /// The column is wide enough for the wider of the two, so the counts start
    /// at the same place whichever lines are drawn.
    private static let countGap: CGFloat = 16
    private static let glyphColumnWidth: CGFloat = 17
    private static let countGlyphGap: CGFloat = 7
    private static let countTextSize: CGFloat = 14

    var body: some View {
        GeometryReader { proxy in
            let scale = min(
                proxy.size.width / Self.designSize.width,
                proxy.size.height / Self.designSize.height
            )
            let control = Self.controlHeight * scale
            VStack(spacing: 0) {
                if isActive {
                    counts(scale: scale)
                    Spacer(minLength: Self.bandGap * scale)
                    actionTiles(height: control, scale: scale)
                } else {
                    circles(diameter: control, scale: scale)
                    Spacer(minLength: Self.bandGap * scale)
                    chatPill(height: control, scale: scale)
                }
            }
            .padding(Self.contentMargin * scale)
            .frame(width: proxy.size.width, height: proxy.size.height)
        }
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

    /// The two most physical actions, as circles: a shape the eye separates
    /// from the wide pill under them before it reads either one.
    private func circles(diameter: CGFloat, scale: CGFloat) -> some View {
        HStack(spacing: Self.circleGap * scale) {
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
    /// say so. It carries the accent for the same reason it gets the width, and
    /// on a themed Home Screen it carries the user's tint in the accent's
    /// place, so the circles above it keep reading as the secondary pair.
    private func chatPill(height: CGFloat, scale: CGFloat) -> some View {
        PillActionButton(
            intent: OpenNewChatIntent(),
            title: "Chat",
            fill: entry.softAccent.fill,
            tint: entry.softAccent.onFill,
            height: height,
            carriesAccent: true,
            avatarImage: entry.avatarImage,
            showsAppIcon: true,
            scale: scale
        )
    }

    /// The pair the readout state ends on. Voice keeps the neutral fill, so the
    /// two read as a primary action and a secondary one.
    private func actionTiles(height: CGFloat, scale: CGFloat) -> some View {
        HStack(spacing: Self.tileGap * scale) {
            WidgetActionTile.newChat(accent: entry.softAccent, avatarImage: entry.avatarImage, scale: scale)
            WidgetActionTile.voice(scale: scale)
        }
        .frame(height: height)
    }

    /// The counts, each dropping its line rather than printing "0".
    private func counts(scale: CGFloat) -> some View {
        VStack(alignment: .leading, spacing: Self.countGap * scale) {
            if let count = entry.snapshot?.unreadCount, count > 0 {
                unreadCountLine(count: count, scale: scale)
            }
            if let count = entry.snapshot?.inProgressCount, count > 0 {
                countLine(glyph: inProgressGlyph(scale: scale), text: "\(count) in progress", scale: scale)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// The unread line, which is also the way to the conversations it counts.
    ///
    /// A tap target rather than a readout: the line reports the inbox, so
    /// following it has to land on the inbox. Without a button of its own the
    /// tap falls through to the widget's default open, which parks the user
    /// wherever they left off and reads as the count doing nothing.
    ///
    /// The in-progress line beside it gets no such button. It counts turns the
    /// assistant is still working on rather than replies waiting to be read, so
    /// the list is not where following it would go, and there is no destination
    /// worth minting a second command for.
    ///
    /// The label takes the full width so the target is the row rather than the
    /// few points the text happens to occupy.
    private func unreadCountLine(count: Int, scale: CGFloat) -> some View {
        Button(intent: OpenConversationsIntent()) {
            countLine(glyph: unreadGlyph(scale: scale), text: "\(count) unread", scale: scale)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .buttonStyle(.plain)
        .accessibilityHint("Opens your conversations")
    }

    /// The glyph is decorative: the text beside it already says everything
    /// VoiceOver needs to read.
    ///
    /// The line is `.privacySensitive()` while the glyph beside it is not,
    /// matching the Quick Actions chip: a locked device still shows that
    /// something is waiting without spelling out how far behind its owner is.
    private func countLine(glyph: some View, text: String, scale: CGFloat) -> some View {
        HStack(spacing: Self.countGlyphGap * scale) {
            glyph
                .frame(width: Self.glyphColumnWidth * scale, alignment: .leading)
                .accessibilityHidden(true)
            Text(text)
                .font(.system(size: Self.countTextSize * scale, weight: .medium))
                .foregroundStyle(WidgetTheme.textPrimary)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                .privacySensitive()
        }
    }

    /// The outline bubble, since this card is the white one, in the primary
    /// text color the line beside it is drawn in.
    private func unreadGlyph(scale: CGFloat) -> some View {
        WidgetUnreadMark(isFilled: false, size: 16 * scale)
            .foregroundStyle(WidgetTheme.textPrimary)
    }

    /// The dots a Catch Up row marks a turn in flight with, at the size this
    /// card's lines are drawn at.
    private func inProgressGlyph(scale: CGFloat) -> some View {
        Image(systemName: "ellipsis")
            .font(.system(size: 16 * scale, weight: .bold))
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

#Preview("Flattened") {
    // The only card that draws all four controls, so it is where the flattened
    // fills are worth looking at: both states, since the tiles and the pill are
    // on opposite sides of the flip.
    previewFlattened {
        HStack(spacing: 12) {
            previewWidgetCard {
                StatusWidgetView(entry: previewEntry())
            } background: {
                previewFlattenedGround
            }
            previewWidgetCard {
                StatusWidgetView(entry: previewEntry(unread: 3, inProgress: 2))
            } background: {
                previewFlattenedGround
            }
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
