import SwiftUI
import WidgetKit

/// The small Home Screen widget: the two most physical ways to start
/// something, on a card painted in the assistant's own colors, plus a count of
/// what is waiting.
///
/// Small only. Every action here is one tap target and none of them grow with
/// more room, so a medium instance would be the same buttons with half a card
/// of padding around them. `CatchUpWidget` is the medium answer.
///
/// Static rather than configurable: the avatar decides what the card looks
/// like, and an account that has picked its assistant has already answered
/// anything a setting here could ask.
///
/// The widget declares no `widgetURL`, so a tap outside the buttons falls
/// through to WidgetKit's default of launching the app, which is the same
/// "land where you left off" behavior `OpenVellumIntent` gives the Control
/// Center control. Nothing here needs a destination the app does not already
/// have the user parked on.
struct QuickActionsWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(
            kind: VellumWidgetKind.quickActions,
            provider: SnapshotProvider()
        ) { entry in
            QuickActionsWidgetView(entry: entry)
                .containerBackground(for: .widget) {
                    QuickActionsCardBackground(entry: entry)
                }
        }
        .configurationDisplayName("Quick Actions")
        .description("Take a photo or start a voice conversation, on a card in your assistant's colors.")
        .supportedFamilies([.systemSmall])
        .contentMarginsDisabled()
    }
}

/// The card: the assistant looking back from the top, the two actions along
/// the bottom, and the unread count tucked into the corner the mark leaves
/// empty.
///
/// There is no empty state and no signed-out state to draw: the buttons are
/// what the widget is, and they work with nothing synced at all. The chip and
/// the colors are what read the snapshot, so a missing snapshot costs the
/// widget its theming and its count and nothing else.
struct QuickActionsWidgetView: View {
    /// The widget disables the system content margins and draws this one
    /// instead: the controls are laid out flush to the card's own margin, and
    /// the default insets would leave them a card too small to hold them.
    private static let contentMargin: CGFloat = 16

    /// The camera and voice circles, and the gap between them. Two of them plus
    /// the gap is exactly the width the margins leave, which is what makes the
    /// pair read as the base of the card rather than as buttons on it.
    private static let controlDiameter: CGFloat = 61
    private static let controlGap: CGFloat = 6

    /// The avatar's slot when the avatar is a photo rather than a face to
    /// draw. Larger than the eyes are tall, because a picture needs area to
    /// read as a face where two ovals need only their outline.
    private static let avatarImageSize: CGFloat = 44
    private static let avatarImageCornerRadius: CGFloat = 15

    /// Space above the mark and the chip, inside the card's margin.
    private static let markInset: CGFloat = 13

    private static let chipHeight: CGFloat = 31

    /// The chip's fill: a wash of the dark the card is missing, rather than a
    /// pale pill placed on top of it. Same treatment over an accent as over a
    /// blurred photo, since both are surfaces the chip has to sink into.
    private static let chipFill = Color.black.opacity(0.16)

    /// How strongly a control's fill washes the card, by how bright the color
    /// doing the washing is. A white wash lifts a dark card further than a
    /// black wash deepens a light one, so the two weights are not the same
    /// number.
    private static let controlFillOnWhite = 0.14
    private static let controlFillOnDark = 0.10

    let entry: SnapshotEntry

    var body: some View {
        GeometryReader { geo in
            VStack(spacing: 0) {
                markRow(width: geo.size.width)
                Spacer(minLength: 0)
                controlRow(
                    diameter: min(
                        Self.controlDiameter,
                        (geo.size.width - Self.controlGap) / 2
                    )
                )
            }
            .frame(width: geo.size.width, height: geo.size.height)
        }
        .padding(Self.contentMargin)
    }

    /// The mark, and the chip when there is something to count.
    ///
    /// The mark sits centered until the chip arrives and then moves to the left
    /// margin. A chip in the corner over centered eyes reads as two things
    /// dropped on a card; the two at opposite margins read as one row across
    /// the top of it.
    private func markRow(width: CGFloat) -> some View {
        HStack(alignment: .top, spacing: 0) {
            if unreadCount == nil {
                Spacer(minLength: 0)
            }
            avatarMark(width: width)
            Spacer(minLength: 0)
            unreadChip
        }
        .padding(.top, Self.markInset)
    }

    /// Height the eyes can afford beside the chip. The pair's own width is its
    /// height times ``WidgetAvatarEyes/pairAspect``, so what the chip does not
    /// take decides how tall they can be; on compact cards the eyes give way so
    /// the row never compresses either mark.
    private func fittedEyeHeight(in width: CGFloat) -> CGFloat {
        guard unreadCount != nil else {
            return WidgetAvatarEyes.defaultEyeHeight
        }
        let available = (width - Self.chipAllowance) / WidgetAvatarEyes.pairAspect
        return min(WidgetAvatarEyes.defaultEyeHeight, max(24, available))
    }

    /// The photo mark under the same constraint as the eyes.
    private func fittedImageSize(in width: CGFloat) -> CGFloat {
        guard unreadCount != nil else {
            return Self.avatarImageSize
        }
        return min(Self.avatarImageSize, max(24, width - Self.chipAllowance))
    }

    /// Width the chip's widest form, the collapsed `99+`, can occupy: the 16pt
    /// bubble, the 15pt count, and the padding around both.
    private static let chipAllowance: CGFloat = 73

    /// The assistant, however this account's assistant can be drawn: its own
    /// photo where there is one, and the eyes the kit draws where the card is
    /// already wearing its color.
    @ViewBuilder
    private func avatarMark(width: CGFloat) -> some View {
        if entry.avatarKind == .image, let image = entry.avatarImage {
            WidgetAvatarImageView(
                image: image,
                size: fittedImageSize(in: width),
                cornerRadius: Self.avatarImageCornerRadius
            )
        } else {
            WidgetAvatarEyes(eyeHeight: fittedEyeHeight(in: width))
        }
    }

    /// How many conversations are waiting, when that is worth saying.
    ///
    /// The number is `.privacySensitive()` while the glyph beside it is not, so
    /// a locked device still shows that something arrived without spelling out
    /// how far behind its owner is. Counts above two digits collapse to `99+`:
    /// past that the exact figure stops being information and the chip would
    /// grow into the mark across from it.
    @ViewBuilder
    private var unreadChip: some View {
        if let count = unreadCount {
            HStack(spacing: 4) {
                WidgetUnreadMark(isFilled: true, size: 16)
                Text(count > 99 ? "99+" : "\(count)")
                    .font(.system(size: 15, weight: .semibold))
                    .privacySensitive()
            }
            .foregroundStyle(palette.onSurface)
            .padding(.horizontal, 9)
            .frame(height: Self.chipHeight)
            .background(Self.chipFill, in: Capsule())
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(count) unread")
        }
    }

    /// The pair the card is built around, sized to the margins so they land in
    /// the same place whatever the avatar above them turns out to be. The
    /// diameter follows the card's width on compact widgets, where two full
    /// 61pt circles plus their gap would overrun the margins, and the row's
    /// own height is the resolved diameter so the column never reserves more
    /// than it draws.
    private func controlRow(diameter: CGFloat) -> some View {
        HStack(spacing: Self.controlGap) {
            CircleActionButton(
                intent: OpenCameraIntent(),
                icon: Image(systemName: "camera.fill"),
                label: "Take a photo",
                fill: controlFill,
                tint: palette.onSurface,
                diameter: diameter
            )
            CircleActionButton(
                intent: StartNewVoiceConversationIntent(),
                icon: Image(systemName: "waveform"),
                label: "New voice conversation",
                fill: controlFill,
                tint: palette.onSurface,
                diameter: diameter
            )
        }
    }

    /// Every color drawn on the card, derived from the accent behind it rather
    /// than fixed white: a pale avatar would otherwise paint white glyphs on a
    /// white card.
    private var palette: WidgetAvatarPalette {
        entry.avatarPalette
    }

    private var controlFill: Color {
        palette.controlFill(onWhite: Self.controlFillOnWhite, onDark: Self.controlFillOnDark)
    }

    /// The number for the unread chip, or nil when there is no chip to draw:
    /// nothing unread, nothing synced, or a snapshot old enough that the count
    /// is a claim about an inbox from half an hour ago.
    ///
    /// `CatchUpRow` keeps its unread dot past that same threshold, and the two
    /// are consistent rather than in tension. A dot says "this conversation
    /// has something in it you have not read", which stays true until someone
    /// opens the app and resyncs. A count says how many are waiting *now*, and
    /// messages arriving while the app is closed are exactly what the widget
    /// cannot see. So the fact survives staleness and the tally does not.
    private var unreadCount: Int? {
        guard !entry.isStale,
              let count = entry.snapshot?.unreadCount,
              count > 0
        else {
            return nil
        }
        return count
    }
}

/// The card itself, which is to say the avatar: an accent painted flat, a
/// custom photo blurred under a scrim, or the brand block for an account with
/// neither.
///
/// Separate from the content because `containerBackground` is what gets handed
/// the widget's full bounds, corner radius and all, and a blurred photo that
/// stops at the content's edge is a photo with a frame around it.
struct QuickActionsCardBackground: View {
    let entry: SnapshotEntry

    var body: some View {
        switch entry.avatarKind {
        case .image:
            BlurredAvatarBackground(image: entry.avatarImage)
        case .character, .none:
            entry.avatarPalette.surface
        }
    }
}

#if DEBUG

/// This widget's card: the shared wrapper over the avatar background, which is
/// what the widget itself paints its container with.
private func previewCard(_ entry: SnapshotEntry) -> some View {
    previewWidgetCard {
        QuickActionsWidgetView(entry: entry)
    } background: {
        QuickActionsCardBackground(entry: entry)
    }
}

private func previewCharacterAvatar(accentHex: String) -> WidgetSnapshotAvatar {
    WidgetSnapshotAvatar(kind: "character", accentHex: accentHex, imageData: nil)
}

#Preview("Character, nothing unread") {
    previewAppearances {
        previewCard(previewEntry(unread: 0, avatar: previewCharacterAvatar(accentHex: "#0E9B8B")))
    }
}

#Preview("Character, unread") {
    previewAppearances {
        HStack(spacing: 12) {
            previewCard(previewEntry(unread: 3, avatar: previewCharacterAvatar(accentHex: "#0E9B8B")))
            // The light one: its glyphs, chip text and control fills all have
            // to come out dark, or the card is white on yellow.
            previewCard(previewEntry(unread: 12, avatar: previewCharacterAvatar(accentHex: "#F2C94C")))
        }
    }
}

#Preview("Custom image, unread") {
    let avatar = WidgetSnapshotAvatar(
        kind: "image",
        accentHex: nil,
        imageData: previewAvatarPhoto().pngData()
    )
    previewAppearances {
        previewCard(previewEntry(unread: 5, avatar: avatar))
    }
}

#Preview("No avatar") {
    previewAppearances {
        HStack(spacing: 12) {
            previewCard(previewEntry(unread: 0, avatar: nil))
            previewCard(previewEntry(unread: 128, avatar: nil))
        }
    }
}

#endif
