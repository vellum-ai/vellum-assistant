import SwiftUI
import VellumAssistantShared
#if os(macOS)
import AppKit

// MARK: - Emoji Navigation

enum EmojiNavigation {
    case up, down, select, tab, dismiss
}

// MARK: - Emoji Picker Logic (ComposerView extension)

extension ComposerView {

    /// Walks backward from `cursorPosition` through `inputText` to find an
    /// unmatched `:` followed by 2+ alphanumeric/underscore characters.
    /// Returns nil if no valid trigger is found.
    func emojiTriggerRange() -> (colonIndex: String.Index, filter: String)? {
        guard !showSlashMenu else { return nil }
        guard cursorPosition > 0, cursorPosition <= inputText.utf16.count else { return nil }

        let cursorIdx = String.Index(utf16Offset: cursorPosition, in: inputText)
        var idx = cursorIdx

        // Walk backward looking for the triggering `:`
        while idx > inputText.startIndex {
            idx = inputText.index(before: idx)
            let ch = inputText[idx]

            if ch == ":" {
                // Found the colon — extract the filter between colon and cursor
                let afterColon = inputText.index(after: idx)
                let filter = String(inputText[afterColon..<cursorIdx])

                // Must have at least 2 characters after the colon
                guard filter.count >= 2 else { return nil }

                return (colonIndex: idx, filter: filter)
            }

            // Only allow alphanumeric characters and underscores between `:` and cursor
            if ch.isWhitespace || (!ch.isLetter && !ch.isNumber && ch != "_") {
                return nil
            }
        }

        return nil
    }

    func updateEmojiState() {
        if suppressEmojiReopen {
            suppressEmojiReopen = false
            return
        }
        if let trigger = emojiTriggerRange() {
            let results = EmojiCatalog.search(query: trigger.filter)
            if !results.isEmpty {
                withAnimation(VAnimation.fast) { showEmojiMenu = true }
                if emojiFilter != trigger.filter {
                    emojiSelectedIndex = 0
                }
                emojiFilter = trigger.filter
            } else {
                withAnimation(VAnimation.fast) { showEmojiMenu = false }
            }
        } else {
            withAnimation(VAnimation.fast) { showEmojiMenu = false }
        }
    }

    func filteredEmoji(_ filter: String) -> [EmojiEntry] {
        EmojiCatalog.search(query: filter, limit: 8)
    }

    func selectEmoji(_ entry: EmojiEntry) {
        guard let trigger = emojiTriggerRange() else { return }

        let colonOffset = trigger.colonIndex.utf16Offset(in: inputText)
        let cursorUtf16 = cursorPosition
        let length = cursorUtf16 - colonOffset
        let nsRange = NSRange(location: colonOffset, length: length)

        textReplacer.replaceText?(nsRange, entry.emoji)

        withAnimation(VAnimation.fast) { showEmojiMenu = false }
        emojiSelectedIndex = 0
    }

    func handleEmojiNavigation(_ action: EmojiNavigation) {
        if showEmojiMenu {
            let filtered = filteredEmoji(emojiFilter)
            guard !filtered.isEmpty else { return }
            switch action {
            case .up:
                emojiSelectedIndex = (emojiSelectedIndex - 1 + filtered.count) % filtered.count
            case .down:
                emojiSelectedIndex = (emojiSelectedIndex + 1) % filtered.count
            case .select:
                selectEmoji(filtered[emojiSelectedIndex])
            case .tab:
                selectEmoji(filtered[emojiSelectedIndex])
            case .dismiss:
                withAnimation(VAnimation.fast) { showEmojiMenu = false }
                suppressEmojiReopen = true
            }
        }
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
