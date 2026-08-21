import AppIntents
import SwiftUI

// The controls every Vellum Home Screen widget builds its actions out of: a
// tile, a circle, a pill, and the secondary line of text that stands in when
// there is nothing to list. They live here rather than beside whichever widget
// reached for them first, because a control that lives in one widget's file is
// a control the next widget copies.

/// One tile in an action column: a glyph over a word, filling a rounded
/// square, wired to an App Intent.
///
/// Generic over the intent because `Button(intent:)` takes a concrete
/// `AppIntent` and the tiles run different ones. Both intents declare
/// `openAppWhenRun`, so the system performs them in the app process; the appex
/// only needs the types to exist.
struct WidgetActionTile<ActionIntent: AppIntent>: View {
    /// Matched to the squircle the system clips the widget itself with, so a
    /// tile reads as a smaller instance of the card it sits on.
    private static var cornerRadius: CGFloat { 14 }

    let intent: ActionIntent
    let icon: Image
    let title: String
    let fill: Color
    let tint: Color

    var body: some View {
        Button(intent: intent) {
            VStack(spacing: 4) {
                icon
                    .font(.system(size: 22))
                    .foregroundStyle(tint)
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
}

extension WidgetActionTile where ActionIntent == OpenNewChatIntent {
    /// The New Chat tile, spelled once so the widgets offering it cannot drift
    /// into different wording, glyphs or colors. The frame around it stays with
    /// the caller: the column and the row size their tiles differently.
    static var newChat: Self {
        WidgetActionTile(
            intent: OpenNewChatIntent(),
            icon: Image("VellumV"),
            title: "New Chat",
            fill: WidgetTheme.newChatFill,
            tint: WidgetTheme.brand
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

    var body: some View {
        Button(intent: intent) {
            HStack(spacing: 6) {
                icon
                    .font(.system(size: height * 0.4))
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
