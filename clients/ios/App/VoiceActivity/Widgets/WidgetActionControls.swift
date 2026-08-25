import AppIntents
import SwiftUI
import UIKit
import WidgetKit

// The pieces every Vellum Home Screen widget builds itself out of: a tile, a
// circle, a pill, the unread mark, and the secondary line of text that stands
// in when there is nothing to list. They live here rather than beside whichever
// widget reached for them first, because a control that lives in one widget's
// file is a control the next widget copies.
//
// Each control that carries a fill also knows what to do when the system
// flattens the widget: a themed Home Screen, StandBy, or the lock screen. In
// those modes WidgetKit throws away every color a widget sets and redraws it in
// two monochrome groups, keeping only each view's alpha, so a fill picked to
// sit on a white card comes out either as an opaque block that swallows the
// glyph on it or as a wash too faint to see. The controls answer by swapping to
// a translucent white, which survives the flattening as the same soft ground it
// was drawn as.

/// The grounds a control draws on once WidgetKit flattens the widget.
///
/// White rather than the control's own color because only alpha survives the
/// flattening: a translucent white is the one way to ask for the soft ground
/// the full-color card gets and be given it. The weights differ by shape rather
/// than by accident, since a small round ground has less area to make the same
/// wash felt with than a tile does.
///
/// Collected here rather than spelled at each use for the reason
/// ``WidgetTheme`` collects the full-color palette: four controls picking their
/// own number is four controls drifting apart.
enum WidgetFlattenedFill {
    static let tile = Color.white.opacity(0.12)
    static let circle = Color.white.opacity(0.14)
    static let pill = Color.white.opacity(0.12)
    static let chip = Color.white.opacity(0.12)
}

/// One tile in an action column: a glyph over a word, filling a rounded
/// square, wired to an App Intent.
///
/// Generic over the intent because `Button(intent:)` takes a concrete
/// `AppIntent` and the tiles run different ones. Both intents declare
/// `openAppWhenRun`, so the system performs them in the app process; the appex
/// only needs the types to exist.
struct WidgetActionTile<ActionIntent: AppIntent>: View {
    /// A corner tighter than the widget's own squircle, so the tile reads as a
    /// control on the card rather than as a second card.
    private static var cornerRadius: CGFloat { 12 }

    private static var iconSize: CGFloat { 24 }

    private static var labelSize: CGFloat { 8 }

    let intent: ActionIntent
    let icon: Image
    let title: String
    let fill: Color
    let tint: Color

    /// Whether this tile is the one that wears the user's own tint on a themed
    /// Home Screen. At most one tile per card claims it, so the pair keeps the
    /// primary-and-secondary reading it has in full color instead of coming out
    /// as two identical blocks.
    var carriesAccent: Bool = false

    /// The user's avatar, drawn in place of ``icon`` when the snapshot carries
    /// one. Optional because the tiles standing for an action rather than for
    /// the assistant keep their symbol, and because nothing has synced yet on a
    /// fresh install.
    var avatarImage: UIImage? = nil

    /// The owning card's ratio to the size it was designed at, so the tile
    /// keeps its share of a card that renders larger or smaller than the
    /// design. See the design-size note on each widget view.
    var scale: CGFloat = 1

    @Environment(\.widgetRenderingMode) private var renderingMode

    /// Whether the system is drawing the widget in one of its monochrome modes.
    /// See the note at the top of this file.
    private var isFlattened: Bool { renderingMode != .fullColor }

    var body: some View {
        Button(intent: intent) {
            VStack(spacing: 4 * scale) {
                glyph
                Text(title)
                    .font(.system(size: Self.labelSize * scale, weight: .medium))
                    .foregroundStyle(WidgetTheme.textPrimary)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background { ground }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(title)
    }

    /// The tile's ground, drawn as its own shape view rather than handed to
    /// `background(_:in:)`, because that is what lets `widgetAccentable()` be
    /// scoped to it. The modifier tints everything beneath it, so a tile that
    /// marked its button would hand the glyph and the word the same tint as the
    /// ground behind them and leave the reader a blank square.
    ///
    /// Marking the shape is harmless in full color, where nothing consults it,
    /// so the accent-carrying tile claims it in every mode rather than only in
    /// the one where it matters.
    @ViewBuilder
    private var ground: some View {
        let shape = RoundedRectangle(cornerRadius: Self.cornerRadius * scale)
            .fill(isFlattened ? WidgetFlattenedFill.tile : fill)
        if carriesAccent {
            shape.widgetAccentable()
        } else {
            shape
        }
    }

    /// A symbol takes its size from the font and its color from the tile's
    /// tint; a bitmap can do neither, so it is sized and clipped instead.
    @ViewBuilder
    private var glyph: some View {
        if let avatarImage {
            WidgetAvatarImageView(image: avatarImage, size: Self.iconSize * scale)
        } else {
            icon
                .font(.system(size: Self.iconSize * scale))
                .foregroundStyle(tint)
        }
    }
}

extension WidgetActionTile where ActionIntent == OpenNewChatIntent {
    /// The New Chat tile, spelled once so the widgets offering it cannot drift
    /// into different wording, glyphs or colors. The frame around it stays with
    /// the caller: the column and the row size their tiles differently.
    ///
    /// The accent themes the tile and the avatar replaces its mark, both from
    /// the snapshot, so the tile that starts a chat with the assistant looks
    /// like that assistant. On a themed Home Screen there is no accent to read,
    /// so this is also the tile that carries the user's own tint, which is the
    /// same job by the only means that mode leaves.
    static func newChat(accent: WidgetSoftAccent, avatarImage: UIImage? = nil, scale: CGFloat = 1) -> Self {
        WidgetActionTile(
            intent: OpenNewChatIntent(),
            icon: Image("VellumV"),
            title: "New Chat",
            fill: accent.fill,
            tint: accent.onFill,
            carriesAccent: true,
            avatarImage: avatarImage,
            scale: scale
        )
    }
}

extension WidgetActionTile where ActionIntent == StartNewVoiceConversationIntent {
    /// The Voice tile, the secondary half of the pair. Neutral fill against
    /// ``newChat``'s tinted one, so the two read as a primary action and a
    /// secondary one rather than as two peers.
    static func voice(scale: CGFloat = 1) -> Self {
        WidgetActionTile(
            intent: StartNewVoiceConversationIntent(),
            icon: Image(systemName: "waveform"),
            title: "Voice",
            fill: WidgetTheme.voiceFill,
            tint: WidgetTheme.textPrimary,
            scale: scale
        )
    }
}

/// A round tap target running an App Intent, with the glyph as its whole label.
///
/// Generic over the intent for the reason ``WidgetActionTile`` is.
struct CircleActionButton<ActionIntent: AppIntent>: View {
    let intent: ActionIntent
    let icon: Image
    let label: String
    let fill: Color
    let tint: Color
    let diameter: CGFloat

    @Environment(\.widgetRenderingMode) private var renderingMode

    /// Whether the system is drawing the widget in one of its monochrome modes.
    /// See the note at the top of this file.
    private var isFlattened: Bool { renderingMode != .fullColor }

    var body: some View {
        Button(intent: intent) {
            icon
                .font(.system(size: diameter * 0.4))
                .foregroundStyle(tint)
                .frame(width: diameter, height: diameter)
                .background(isFlattened ? WidgetFlattenedFill.circle : fill, in: Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
}

/// A full-width capsule running an App Intent, glyph beside a word.
struct PillActionButton<ActionIntent: AppIntent>: View {
    let intent: ActionIntent
    let icon: Image
    let title: String
    let fill: Color
    let tint: Color
    let height: CGFloat

    /// See ``WidgetActionTile/carriesAccent``. The pill is the idle card's
    /// primary action the way the New Chat tile is the active card's, so both
    /// states hand the tint to the control doing that job and the flip between
    /// them does not move the user's own color onto something else.
    var carriesAccent: Bool = false

    /// See ``WidgetActionTile/avatarImage``.
    var avatarImage: UIImage? = nil

    /// See ``WidgetActionTile/scale``. The glyph already follows the height;
    /// this scales the word beside it.
    var scale: CGFloat = 1

    @Environment(\.widgetRenderingMode) private var renderingMode

    /// Whether the system is drawing the widget in one of its monochrome modes.
    /// See the note at the top of this file.
    private var isFlattened: Bool { renderingMode != .fullColor }

    var body: some View {
        Button(intent: intent) {
            HStack(spacing: 6 * scale) {
                glyph
                Text(title)
                    .font(.system(size: 15 * scale, weight: .semibold))
            }
            .foregroundStyle(tint)
            .frame(maxWidth: .infinity)
            .frame(height: height)
            .background { ground }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(title)
    }

    /// The pill's ground, its own shape view for the reason the tile's is:
    /// `widgetAccentable()` tints everything beneath it, so a pill that marked
    /// its button would sink the glyph and the word into the ground behind
    /// them. Marking the shape alone leaves them in the default group, legible
    /// against the tint.
    @ViewBuilder
    private var ground: some View {
        let shape = Capsule().fill(isFlattened ? WidgetFlattenedFill.pill : fill)
        if carriesAccent {
            shape.widgetAccentable()
        } else {
            shape
        }
    }

    /// The glyph is sized off the pill's height either way, so swapping the
    /// symbol for the avatar does not move the word beside it.
    @ViewBuilder
    private var glyph: some View {
        if let avatarImage {
            WidgetAvatarImageView(image: avatarImage, size: iconSize)
        } else {
            icon
                .font(.system(size: iconSize))
        }
    }

    private var iconSize: CGFloat { height * 0.4 }
}

/// The mark a widget says "something is waiting" with: a speech bubble wearing
/// the unseen dot in its top-right corner.
///
/// One view rather than one per card, so the dot lands in the same place on
/// each of them. It carries no foreground of its own: the bubble takes the
/// color of whatever it is drawn on, while the dot keeps
/// ``WidgetTheme/unseenIndicator`` on every surface, which is what makes it
/// read as an alert rather than as more chrome.
///
/// The dot is the mark's one accentable piece, so on a themed Home Screen it
/// comes out in the user's tint while the bubble around it stays white. Amber
/// is what the alert reading wants and what the flattening will not grant, but
/// the dot's real job is to separate from the bubble it rides, and a tint the
/// bubble does not share does that as well as amber did.
struct WidgetUnreadMark: View {
    /// Whether the bubble is solid. A card painted in the assistant's own color
    /// wants the filled one; a white card wants the outline its rows draw.
    let isFilled: Bool

    /// Point size of the bubble. The dot rides its corner at the design's
    /// share of it, so the mark scales as one piece: every card draws the
    /// bubble at the same 16pt design size, and a dot fixed in points would
    /// drift off the corner on the devices that render a card larger.
    let size: CGFloat

    private var dotDiameter: CGFloat { size * 0.375 }
    private var dotNudge: CGFloat { size * 0.0625 }

    var body: some View {
        Image(systemName: isFilled ? "bubble.left.fill" : "bubble.left")
            .font(.system(size: size))
            .overlay(alignment: .topTrailing) {
                Circle()
                    .fill(WidgetTheme.unseenIndicator)
                    .frame(width: dotDiameter, height: dotDiameter)
                    .offset(x: dotNudge, y: -dotNudge)
                    .widgetAccentable()
            }
    }
}

/// The quiet line a widget prints when it has nothing to list: an empty state,
/// a snapshot too old to read as a status, or an account with nothing synced.
///
/// One treatment for all of them, because they are one thing to the person
/// reading: a sentence that is not the widget's content, sized down and in the
/// secondary color so it does not compete with the actions beside it. The
/// size is adjustable for the narrower medium-widget column; spacing stays
/// with the caller.
struct WidgetPromptText: View {
    private let text: String
    private let size: CGFloat

    init(_ text: String, size: CGFloat = 12) {
        self.text = text
        self.size = size
    }

    var body: some View {
        Text(text)
            .font(.system(size: size, weight: .medium))
            .foregroundStyle(WidgetTheme.textSecondary)
            .lineLimit(2)
    }
}
