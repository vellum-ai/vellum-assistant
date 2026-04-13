import SwiftUI
import VellumAssistantShared
#if os(macOS)
import AppKit

// MARK: - Emoji Picker Logic (ComposerView extension)

extension ComposerView {

    func selectEmoji(_ entry: EmojiEntry) {
        guard let trigger = composerController.emojiTriggerRange() else { return }

        let colonOffset = trigger.colonIndex.utf16Offset(in: inputText)
        let cursorUtf16 = cursorPosition
        let length = cursorUtf16 - colonOffset
        let nsRange = NSRange(location: colonOffset, length: length)

        textReplacer.replaceText?(nsRange, entry.emoji)

        composerController.closeEmojiMenu()
    }
}

// MARK: - Emoji Picker Popup

struct EmojiPickerPopup: View {
    let entries: [EmojiEntry]
    let selectedIndex: Int
    let onSelect: (EmojiEntry) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(entries.enumerated()), id: \.element.id) { index, entry in
                EmojiPickerRow(
                    entry: entry,
                    isSelected: index == selectedIndex,
                    onSelect: { onSelect(entry) }
                )
            }
        }
        .padding(.vertical, VSpacing.xs)
        .background(VColor.surfaceBase)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
        .overlay(RoundedRectangle(cornerRadius: VRadius.lg)
            .stroke(VColor.borderBase, lineWidth: 1))
        .shadow(color: VColor.auxBlack.opacity(0.3), radius: 12, y: -4)
    }
}

// MARK: - Emoji Picker Row

struct EmojiPickerRow: View {
    let entry: EmojiEntry
    let isSelected: Bool
    let onSelect: () -> Void
    @State private var isHovered = false

    var body: some View {
        Button(action: onSelect) {
            HStack(spacing: VSpacing.md) {
                Text(entry.emoji)
                    .font(.system(size: 20))
                Text(":\(entry.shortcode):")
                    .font(VFont.bodyMediumEmphasised)
                    .foregroundStyle(VColor.contentDefault)
                Spacer()
            }
            .padding(.horizontal, VSpacing.lg)
            .padding(.vertical, VSpacing.sm)
            .background(isSelected || isHovered ? VColor.contentEmphasized.opacity(0.06) : Color.clear)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering in isHovered = hovering }
        .pointerCursor()
    }
}
#endif
