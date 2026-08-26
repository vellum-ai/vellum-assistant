import AppIntents
import SwiftUI
import WidgetKit

/// The small Home Screen widget: the two most physical ways to start
/// something, on a card painted in the assistant's own colors, plus the
/// assistant looking up when something is waiting.
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

// A Storybook replica copies this file's measurements and palette, at
// `clients/web/src/components/ios-widget-previews/`. Nothing checks the two
// against each other, so a change here wants a look there.

/// The card: the two actions along the bottom, the assistant across the top,
/// and the count beside it while something is waiting.
///
/// The face is always drawn. It is the account's avatar rather than a
/// notification, so the card wears it whatever the snapshot says, and the chip
/// is the piece that arrives with unreads. That is also what decides where the
/// mark sits: a quiet card rests it near the middle, and a card carrying a
/// count moves it to the leading margin to leave the chip the other end of the
/// row.
///
/// There is no empty state and no signed-out state to draw: the buttons are
/// what the widget is, and they work with nothing synced at all. The chip and
/// the colors are what read the snapshot, so a missing snapshot costs the
/// widget its theming and its count and nothing else.
struct QuickActionsWidgetView: View {
    /// The card every dimension below is designed on. Widget families render
    /// at slightly different sizes per device, so the layout multiplies its
    /// measurements by the ratio between the two and keeps the design's
    /// proportions everywhere instead of gaining margin on large phones and
    /// clipping on small ones.
    private static let designSize = CGSize(width: 160, height: 161)

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

    /// Space above the mark and the chip, inside the card's margin, and the
    /// nudge the eyes sit in from the leading margin.
    private static let markInset: CGFloat = 13
    private static let markLeadingInset: CGFloat = 2

    /// How far right of the card's center the quiet mark rests, on the design
    /// canvas. The design does not sit the pair on the center line: it settles
    /// it a nudge past, leaning the composition into the rightward glance the
    /// pupils already have, so the face reads as looking across the card rather
    /// than as a mark parked in the middle of it.
    private static let quietMarkCenterOffset: CGFloat = 11.5

    private static let chipHeight: CGFloat = 31

    /// The chip's fill: a wash of the dark the card is missing, rather than a
    /// pale pill placed on top of it. Same treatment over an accent as over a
    /// blurred photo, since both are surfaces the chip has to sink into.
    ///
    /// It has a flattened counterpart because a dark wash stops working once
    /// the card underneath is the system's own dark material: there is no light
    /// left to take away, and the chip would read as nothing at all. See
    /// ``WidgetFlattenedFill``.
    private static let chipFill = Color.black.opacity(0.10)

    /// How strongly a control's fill washes the card, by how bright the color
    /// doing the washing is. A white wash lifts a dark card further than a
    /// black wash deepens a light one, so the two weights are not the same
    /// number.
    private static let controlFillOnWhite = 0.14
    private static let controlFillOnDark = 0.10

    /// Width the chip needs at this count, from its fixed parts (the bubble,
    /// the gaps, the padding) plus a digit's worth of count text per glyph.
    /// Estimated rather than measured so the eyes can be sized in the same
    /// pass that lays them out; the design draws full-height eyes beside a
    /// one-digit chip, and only wider counts buy width from the eyes.
    private static func chipAllowance(for count: Int, scale: CGFloat) -> CGFloat {
        let glyphs = count > 99 ? 3 : String(count).count
        return (45 + 9.5 * CGFloat(glyphs)) * scale
    }

    /// The least space between the mark and the chip before the mark gives
    /// way.
    private static let markChipGap: CGFloat = 12

    let entry: SnapshotEntry

    @Environment(\.widgetRenderingMode) private var renderingMode

    /// Whether the system is drawing the widget in one of its monochrome modes.
    /// See the note at the top of `WidgetActionControls.swift`.
    private var isFlattened: Bool { renderingMode != .fullColor }

    var body: some View {
        GeometryReader { geo in
            let scale = min(
                geo.size.width / Self.designSize.width,
                geo.size.height / Self.designSize.height
            )
            VStack(spacing: 0) {
                if let count = unreadCount {
                    let contentWidth = geo.size.width - Self.contentMargin * scale * 2
                    let markWidth = contentWidth - Self.chipAllowance(for: count, scale: scale)
                        - Self.markChipGap * scale
                    markRow(count: count, markWidth: markWidth, scale: scale)
                } else {
                    quietMarkRow(scale: scale)
                }
                Spacer(minLength: 0)
                controlRow(diameter: Self.controlDiameter * scale, scale: scale)
            }
            .padding(Self.contentMargin * scale)
            .frame(width: geo.size.width, height: geo.size.height)
        }
    }

    /// The mark at the leading margin, the chip at the trailing one: one row
    /// across the top of the card rather than two things dropped on it.
    private func markRow(count: Int, markWidth: CGFloat, scale: CGFloat) -> some View {
        HStack(alignment: .top, spacing: 0) {
            avatarMark(
                eyeHeight: fittedEyeHeight(in: markWidth, scale: scale),
                imageSize: fittedImageSize(in: markWidth, scale: scale),
                scale: scale
            )
            .padding(.leading, Self.markLeadingInset * scale)
            Spacer(minLength: 0)
            unreadChip(count: count, scale: scale)
        }
        .padding(.top, Self.markInset * scale)
    }

    /// The mark alone, at the size the design draws it when nothing shares the
    /// row with it.
    ///
    /// Nothing is competing for the width here, so the mark takes its full size
    /// rather than the fitted one, and it is placed from the card's center
    /// instead of from a margin: what the design lines the pair up against is
    /// the card, not the edge the chip layout hangs it off.
    private func quietMarkRow(scale: CGFloat) -> some View {
        avatarMark(
            eyeHeight: WidgetAvatarEyes.defaultEyeHeight * scale,
            imageSize: Self.avatarImageSize * scale,
            scale: scale
        )
        .frame(maxWidth: .infinity)
        .offset(x: quietMarkOffset * scale)
        .padding(.top, Self.markInset * scale)
    }

    /// How far off the center line the quiet mark rests, which is a question
    /// about what the mark is.
    ///
    /// The eyes lean past center into the rightward glance their pupils already
    /// have, so the face reads as looking across the card. A photo has no
    /// glance to lean into: it is a square of someone's own picture, and the
    /// same nudge only reads as a square hung crooked. So it sits on the line.
    private var quietMarkOffset: CGFloat {
        drawsPhotoMark ? 0 : Self.quietMarkCenterOffset
    }

    /// Height the eyes can afford beside the chip. The pair's own width is its
    /// height times ``WidgetAvatarEyes/pairAspect``, so what the chip does not
    /// take decides how tall they can be; wide counts shrink the eyes rather
    /// than compress the row.
    private func fittedEyeHeight(in markWidth: CGFloat, scale: CGFloat) -> CGFloat {
        let available = markWidth / WidgetAvatarEyes.pairAspect
        return min(WidgetAvatarEyes.defaultEyeHeight * scale, max(24 * scale, available))
    }

    /// The photo mark under the same constraint as the eyes.
    private func fittedImageSize(in markWidth: CGFloat, scale: CGFloat) -> CGFloat {
        min(Self.avatarImageSize * scale, max(24 * scale, markWidth))
    }

    /// The assistant, however this account's assistant can be drawn: its own
    /// photo where there is one, and the eyes the kit draws where the card is
    /// already wearing its color.
    ///
    /// Both sizes are the caller's because the two rows size the mark
    /// differently, while which of the two marks to draw is a fact about the
    /// account and belongs in one place.
    @ViewBuilder
    private func avatarMark(eyeHeight: CGFloat, imageSize: CGFloat, scale: CGFloat) -> some View {
        if drawsPhotoMark, let image = entry.avatarImage {
            WidgetAvatarImageView(
                image: image,
                size: imageSize,
                cornerRadius: Self.avatarImageCornerRadius * scale
            )
        } else {
            WidgetAvatarEyes(eyeHeight: eyeHeight)
        }
    }

    /// Whether the mark this card draws is the account's own photo rather than
    /// the eyes. The placement above and the mark below both ask it, and a card
    /// that answered differently in the two places would hang the photo off a
    /// line drawn for something else.
    private var drawsPhotoMark: Bool {
        entry.avatarKind == .image && entry.avatarImage != nil
    }

    /// How many conversations are waiting, and the way to them.
    ///
    /// The chip is a tap target rather than decoration: it is the one thing on
    /// the card that reports the inbox, so following it has to land on the
    /// inbox. Without a button of its own the tap falls through to the widget's
    /// default open, which parks the user wherever they left off and reads as
    /// the count doing nothing.
    ///
    /// The number is `.privacySensitive()` while the glyph beside it is not, so
    /// a locked device still shows that something arrived without spelling out
    /// how far behind its owner is. Counts above two digits collapse to `99+`:
    /// past that the exact figure stops being information and the chip would
    /// grow into the mark across from it.
    private func unreadChip(count: Int, scale: CGFloat) -> some View {
        Button(intent: OpenConversationsIntent()) {
            HStack(spacing: 5 * scale) {
                WidgetUnreadMark(isFilled: false, size: 16 * scale)
                Text(count > 99 ? "99+" : "\(count)")
                    .font(.system(size: 16 * scale, weight: .medium))
                    .privacySensitive()
            }
            .foregroundStyle(palette.onSurface)
            .padding(.horizontal, 10 * scale)
            .frame(height: Self.chipHeight * scale)
            .background(isFlattened ? WidgetFlattenedFill.chip : Self.chipFill, in: Capsule())
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(count) unread")
        }
        .buttonStyle(.plain)
        .accessibilityHint("Opens your conversations")
    }

    /// The pair the card is built around, sized to the margins so they land in
    /// the same place whatever sits above them.
    private func controlRow(diameter: CGFloat, scale: CGFloat) -> some View {
        HStack(spacing: Self.controlGap * scale) {
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
    /// It gates the chip and the row layout built around it, and nothing else.
    /// The mark is drawn either way: the eyes are which assistant this account
    /// has rather than a claim about right now, so a snapshot too old to count
    /// with is still new enough to say whose face it is.
    ///
    /// It gates the chip and the row layout built around it, and nothing else.
    /// The mark is drawn either way: the eyes are which assistant this account
    /// has rather than a claim about right now, so a snapshot too old to count
    /// with is still new enough to say whose face it is.
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

#Preview("Stale, was unread") {
    // The count is a claim about now and drops; the face is not and stays. The
    // card should be indistinguishable from a quiet one.
    previewAppearances {
        previewCard(
            previewEntry(unread: 3, avatar: previewCharacterAvatar(accentHex: "#0E9B8B"), isStale: true)
        )
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

#Preview("Flattened") {
    // The chip and the two circles have to stay visible as shapes once the card
    // under them is the system's own material rather than the accent.
    previewFlattened {
        previewWidgetCard {
            QuickActionsWidgetView(
                entry: previewEntry(unread: 3, avatar: previewCharacterAvatar(accentHex: "#0E9B8B"))
            )
        } background: {
            previewFlattenedGround
        }
    }
}

#endif
