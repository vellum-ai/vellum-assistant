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
    let selectionBehavior: ChatSlashCommandSelectionBehavior

    static let all: [SlashCommand] = ChatSlashCommandCatalog.commands(
        for: .macos,
        surface: .picker
    ).map(SlashCommand.init(descriptor:))

    init(descriptor: ChatSlashCommandDescriptor) {
        self.name = descriptor.name
        self.description = descriptor.description
        self.icon = descriptor.icon
        self.selectionBehavior = descriptor.selectionBehavior
    }

    var selectedInputText: String {
        switch selectionBehavior {
        case .autoSend:
            "/\(name)"
        case .insertTrailingSpace:
            "/\(name) "
        }
    }

    var shouldAutoSendOnSelect: Bool {
        selectionBehavior == .autoSend
    }
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
        attr.foregroundColor = VColor.contentDefault
        if let swiftRange = slashCommandRange,
           let attrStart = AttributedString.Index(swiftRange.lowerBound, within: attr),
           let attrEnd = AttributedString.Index(swiftRange.upperBound, within: attr) {
            attr[attrStart..<attrEnd].foregroundColor = VColor.primaryBase
        }
        return attr
    }

    func selectSlashCommand(_ command: SlashCommand) {
        composerController.closeSlashMenu()
        inputText = command.selectedInputText
        if command.shouldAutoSendOnSelect {
            onSend()
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
        .background(VColor.surfaceBase)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.lg)
                .stroke(VColor.borderBase, lineWidth: 1)
        )
        .shadow(color: VColor.auxBlack.opacity(0.3), radius: 12, y: -4)
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
                VAvatarImage(image: appearance.chatAvatarImage, size: 28, isTransparent: appearance.isChatAvatarTransparent)
                    .allowsHitTesting(false)

                VStack(alignment: .leading, spacing: 2) {
                    Text("/\(command.name)")
                        .font(VFont.bodyMediumEmphasised)
                        .foregroundStyle(VColor.contentDefault)
                    Text(command.description)
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentTertiary)
                }
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
