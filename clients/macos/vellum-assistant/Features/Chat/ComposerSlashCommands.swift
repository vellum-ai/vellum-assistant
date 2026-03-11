import SwiftUI
import VellumAssistantShared
#if os(macOS)
import AppKit
#endif

// MARK: - Slash Command Model

struct SlashCommand: Identifiable {
    var id: String { name }

    let name: String
    let description: String
    let icon: String

    static let all: [SlashCommand] = [
        SlashCommand(name: "commands", description: "List all available commands", icon: "terminal"),
        SlashCommand(name: "model", description: "Switch the active model", icon: "cpu"),
        SlashCommand(name: "models", description: "List all available models", icon: "list.bullet"),
        SlashCommand(name: "status", description: "Show session status and context usage", icon: "info.circle"),
        SlashCommand(name: "btw", description: "Ask a side question while the assistant is working", icon: "bubble.left.and.text.bubble.right"),
    ]
}

// MARK: - Slash Navigation

enum SlashNavigation {
    case up, down, select, tab, dismiss
}

// MARK: - Slash Command Logic (ComposerView extension)

extension ComposerView {
    /// Range of a slash command token (e.g. `/model`) at the start of input.
    var slashCommandRange: Range<String.Index>? {
        guard !inputText.isEmpty else { return nil }
        return inputText.range(of: #"^/\w+"#, options: .regularExpression)
    }

    /// Builds an `AttributedString` of the full input where the leading
    /// slash command token is highlighted and everything else is the
    /// primary text color. Used as a visual overlay on the transparent
    /// TextField when a slash command is present.
    func slashHighlightedText(font: Font) -> AttributedString {
        var attr = AttributedString(inputText)
        attr.font = font
        attr.foregroundColor = VColor.textPrimary
        if let swiftRange = slashCommandRange,
           let attrStart = AttributedString.Index(swiftRange.lowerBound, within: attr),
           let attrEnd = AttributedString.Index(swiftRange.upperBound, within: attr) {
            attr[attrStart..<attrEnd].foregroundColor = VColor.slashCommand
        }
        return attr
    }

    func filteredSlashCommands(_ filter: String) -> [SlashCommand] {
        SlashCommand.all.filter {
            filter.isEmpty || $0.name.lowercased().hasPrefix(filter.lowercased())
        }
    }

    func updateSlashState() {
        if suppressSlashReopen {
            suppressSlashReopen = false
            return
        }
        let text = inputText

        if text.hasPrefix("/") && !text.contains(" ") {
            let filter = String(text.dropFirst())
            let filtered = filteredSlashCommands(filter)
            if !filtered.isEmpty {
                withAnimation(VAnimation.fast) { showSlashMenu = true }
                if slashFilter != filter {
                    slashSelectedIndex = 0
                }
                slashFilter = filter
            } else {
                withAnimation(VAnimation.fast) { showSlashMenu = false }
            }
        } else {
            withAnimation(VAnimation.fast) { showSlashMenu = false }
        }
    }

    func selectSlashCommand(_ command: SlashCommand) {
        withAnimation(VAnimation.fast) { showSlashMenu = false }
        slashSelectedIndex = 0
        if command.name == "btw" {
            inputText = "/\(command.name) "
            // Don't auto-send — user needs to type the question
        } else {
            inputText = "/\(command.name)"
            onSend()
        }
    }

    func handleSlashNavigation(_ action: SlashNavigation) {
        if showSlashMenu {
            let filtered = filteredSlashCommands(slashFilter)
            guard !filtered.isEmpty else { return }
            switch action {
            case .up:
                slashSelectedIndex = (slashSelectedIndex - 1 + filtered.count) % filtered.count
            case .down:
                slashSelectedIndex = (slashSelectedIndex + 1) % filtered.count
            case .select:
                selectSlashCommand(filtered[slashSelectedIndex])
            case .tab:
                let command = filtered[slashSelectedIndex]
                let newText = "/\(command.name)"
                if inputText != newText {
                    suppressSlashReopen = true
                }
                inputText = newText
                withAnimation(VAnimation.fast) { showSlashMenu = false }
            case .dismiss:
                withAnimation(VAnimation.fast) { showSlashMenu = false }
                inputText = ""
            }
        }
    }
}

// MARK: - Slash Command Popup

struct SlashCommandPopup: View {
    let commands: [SlashCommand]
    let selectedIndex: Int
    let onSelect: (SlashCommand) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(commands.enumerated()), id: \.element.id) { index, command in
                SlashCommandRow(
                    command: command,
                    isSelected: index == selectedIndex,
                    onSelect: { onSelect(command) }
                )
            }
        }
        .padding(.vertical, VSpacing.xs)
        .background(VColor.surface)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.lg)
                .stroke(VColor.surfaceBorder, lineWidth: 1)
        )
        .shadow(color: .black.opacity(0.3), radius: 12, y: -4)
    }
}

// MARK: - Slash Command Row

struct SlashCommandRow: View {
    let command: SlashCommand
    let isSelected: Bool
    let onSelect: () -> Void
    @State private var appearance = AvatarAppearanceManager.shared
    @State private var isHovered = false

    var body: some View {
        Button(action: onSelect) {
            HStack(spacing: VSpacing.md) {
                Image(nsImage: appearance.chatAvatarImage)
                    .resizable()
                    .aspectRatio(contentMode: .fill)
                    .frame(width: 28, height: 28)
                    .clipShape(Circle())
                    .allowsHitTesting(false)

                VStack(alignment: .leading, spacing: 2) {
                    Text("/\(command.name)")
                        .font(VFont.bodyBold)
                        .foregroundColor(VColor.textPrimary)
                    Text(command.description)
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                }
                Spacer()
            }
            .padding(.horizontal, VSpacing.lg)
            .padding(.vertical, VSpacing.sm)
            .background(isSelected || isHovered ? VColor.hoverOverlay.opacity(0.06) : Color.clear)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering in isHovered = hovering }
        .pointerCursor()
    }
}
