import AppIntents
import SwiftUI
import UIKit

// The pieces every Vellum Home Screen widget builds itself out of: a tile, a
// circle, a pill, the unread mark, and the secondary line of text that stands
// in when there is nothing to list. They live here rather than beside whichever
// widget reached for them first, because a control that lives in one widget's
// file is a control the next widget copies.

/// One tile in an action column: a glyph over a word, filling a rounded
/// square, wired to an App Intent.
///
/// Generic over the intent because `Button(intent:)` takes a concrete
/// `AppIntent` and the tiles run different ones. Both intents declare
/// `openAppWhenRun`, so the system performs them in the app process; the appex
/// only needs the types to exist.
struct WidgetActionTile<ActionIntent: AppIntent>: View {
    /// Close to the squircle the system clips the widget itself with, so a tile
    /// reads as a smaller instance of the card it sits on rather than as a chip
    /// placed on top of it.
    private static var cornerRadius: CGFloat { 19 }

    private static var iconSize: CGFloat { 22 }

    let intent: ActionIntent
    let icon: Image
    let title: String
    let fill: Color
    let tint: Color

    /// The user's avatar, drawn in place of ``icon`` when the snapshot carries
    /// one. Optional because the tiles standing for an action rather than for
    /// the assistant keep their symbol, and because nothing has synced yet on a
    /// fresh install.
    var avatarImage: UIImage? = nil

    var body: some View {
        Button(intent: intent) {
            VStack(spacing: 4) {
                glyph
                Text(title)
                    .font(.system(size: 9, weight: .medium))
                    .foregroundStyle(WidgetTheme.textPrimary)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(fill, in: RoundedRectangle(cornerRadius: Self.cornerRadius))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(title)
    }

    /// A symbol takes its size from the font and its color from the tile's
    /// tint; a bitmap can do neither, so it is sized and clipped instead.
    @ViewBuilder
    private var glyph: some View {
        if let avatarImage {
            WidgetAvatarImageView(image: avatarImage, size: Self.iconSize)
        } else {
            icon
                .font(.system(size: Self.iconSize))
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
    /// like that assistant.
    static func newChat(accent: WidgetSoftAccent, avatarImage: UIImage? = nil) -> Self {
        WidgetActionTile(
            intent: OpenNewChatIntent(),
            icon: Image("VellumV"),
            title: "New Chat",
            fill: accent.fill,
            tint: accent.onFill,
            avatarImage: avatarImage
        )
    }
}

extension WidgetActionTile where ActionIntent == StartNewVoiceConversationIntent {
    /// The Voice tile, the secondary half of the pair. Neutral fill against
    /// ``newChat``'s tinted one, so the two read as a primary action and a
    /// secondary one rather than as two peers.
    static var voice: Self {
        WidgetActionTile(
            intent: StartNewVoiceConversationIntent(),
            icon: Image(systemName: "waveform"),
            title: "Voice",
            fill: WidgetTheme.voiceFill,
            tint: WidgetTheme.textPrimary
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

    var body: some View {
        Button(intent: intent) {
            icon
                .font(.system(size: diameter * 0.4))
                .foregroundStyle(tint)
                .frame(width: diameter, height: diameter)
                .background(fill, in: Circle())
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

    /// See ``WidgetActionTile/avatarImage``.
    var avatarImage: UIImage? = nil

    var body: some View {
        Button(intent: intent) {
            HStack(spacing: 6) {
                glyph
                Text(title)
                    .font(.system(size: 15, weight: .semibold))
            }
            .foregroundStyle(tint)
            .frame(maxWidth: .infinity)
            .frame(height: height)
            .background(fill, in: Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(title)
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
struct WidgetUnreadMark: View {
    /// Whether the bubble is solid. A card painted in the assistant's own color
    /// wants the filled one; a white card wants the outline its rows draw.
    let isFilled: Bool

    /// Point size of the bubble. The dot rides its corner at a fixed size
    /// rather than scaling with it, so the alert stays the same alert whichever
    /// card carries it.
    let size: CGFloat

    private static let dotDiameter: CGFloat = 6

    var body: some View {
        Image(systemName: isFilled ? "bubble.left.fill" : "bubble.left")
            .font(.system(size: size))
            .overlay(alignment: .topTrailing) {
                Circle()
                    .fill(WidgetTheme.unseenIndicator)
                    .frame(width: Self.dotDiameter, height: Self.dotDiameter)
                    .offset(x: 2, y: -2)
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
