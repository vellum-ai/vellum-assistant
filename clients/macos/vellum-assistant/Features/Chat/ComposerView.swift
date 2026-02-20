import SwiftUI
import VellumAssistantShared
#if os(macOS)
import AppKit
#endif

struct SlashCommand {
    let name: String
    let description: String
    let icon: String

    static let all: [SlashCommand] = [
        SlashCommand(name: "commands", description: "List all available commands", icon: "terminal"),
        SlashCommand(name: "model", description: "Switch the active model", icon: "cpu"),
        SlashCommand(name: "models", description: "List all available models", icon: "list.bullet"),
    ]
}

enum SlashNavigation {
    case up, down, select, dismiss
}

struct ComposerView: View {
    private let composerCompactHeight: CGFloat = 34
    private let composerMaxHeight: CGFloat = 200
    private let composerActionButtonSize: CGFloat = 34
    private let composerActionIconSize: CGFloat = 14
    private let compactActionOpticalYOffset: CGFloat = 0

    private enum ComposerActionFocus: Hashable {
        case stop
        case send
        case microphone
        case attachment
    }

    @Binding var inputText: String
    let hasAPIKey: Bool
    let isSending: Bool
    let isRecording: Bool
    let suggestion: String?
    let pendingAttachments: [ChatAttachment]
    let onSend: () -> Void
    let onStop: () -> Void
    let onAcceptSuggestion: () -> Void
    let onAttach: () -> Void
    let onRemoveAttachment: (String) -> Void
    let onPaste: () -> Void
    let onMicrophoneToggle: () -> Void
    var placeholderText: String = "What would you like to do?"
    /// Bound to ChatView's state so it can compute composerReservedHeight for safe area insets.
    @Binding var editorContentHeight: CGFloat

    /// Exposed to ChatView so composerReservedHeight stays in sync with the
    /// sticky expansion state (set true when text wraps, reset when text clears).
    @Binding var isComposerExpanded: Bool
    @State private var composerFocusRequestID: Int = 0
    @State private var isStopHovered = false
    @State private var isSendHovered = false
    @State private var isMicrophoneHovered = false
    @State private var isAttachmentHovered = false
    @State private var isComposerFocused = false
    @State private var isEditorOverflowing = false
    @FocusState private var focusedComposerAction: ComposerActionFocus?

    @State private var showSlashMenu = false
    @State private var slashFilter = ""
    @State private var slashSelectedIndex = 0
    @State private var avatarSeed: String = "default"

    /// The portion of the suggestion that extends beyond the current input.
    /// Returns nil when the composer content exceeds the max height (200pt) because
    /// the ghost text overlay is a sibling in the ZStack and would become misaligned
    /// once the TextEditor scrolls internally.
    private var ghostSuffix: String? {
        guard let suggestion else { return nil }
        guard !isEditorOverflowing else { return nil }
        if suggestion.hasPrefix(inputText) {
            let suffix = String(suggestion.dropFirst(inputText.count))
            return suffix.isEmpty ? nil : suffix
        }
        if inputText.isEmpty { return suggestion }
        return nil
    }

    var body: some View {
        VStack(spacing: VSpacing.sm) {
            // Slash command popup (above the composer)
            if showSlashMenu {
                SlashCommandPopup(
                    commands: filteredSlashCommands(slashFilter),
                    selectedIndex: slashSelectedIndex,
                    onSelect: { command in selectSlashCommand(command) },
                    avatarSeed: avatarSeed,
                    avatarPalette: AvatarAppearanceManager.shared.palette,
                    avatarOutfit: AvatarAppearanceManager.shared.outfit
                )
                .transition(.opacity.combined(with: .move(edge: .bottom)))
            }

            // Composer box
            VStack(spacing: 0) {
                if !pendingAttachments.isEmpty {
                    attachmentStrip
                }

                // Text field always lives at the same structural position
                // so that the NSViewRepresentable is never destroyed and
                // recreated when toggling between compact/expanded layouts.
                // In compact mode, buttons are overlaid at trailing edge;
                // in expanded mode, they sit on a separate row below.
                HStack(alignment: .center, spacing: VSpacing.md) {
                    composerTextField
                        .frame(height: clampedComposerHeight)
                        .frame(maxHeight: isComposerExpanded ? clampedComposerHeight : .infinity, alignment: .center)
                    if !isComposerExpanded {
                        composerActionButtons
                            .frame(maxHeight: .infinity, alignment: .center)
                            .offset(y: compactActionOpticalYOffset)
                    }
                }
                .frame(height: isComposerExpanded ? clampedComposerHeight : compactRowHeight, alignment: .center)

                if isComposerExpanded {
                    // Expanded: buttons on a separate row below the text area
                    HStack(spacing: VSpacing.md) {
                        Spacer()
                        composerActionButtons
                    }
                    .padding(.top, VSpacing.xs)
                }
            }
            .padding(.top, isComposerExpanded ? VSpacing.md : VSpacing.xs)
            .padding(.bottom, isComposerExpanded ? VSpacing.sm : VSpacing.xs)
            .padding(.leading, VSpacing.lg)
            .padding(.trailing, 2)
            .background(
                RoundedRectangle(cornerRadius: VRadius.lg)
                    .fill(VColor.surface)
                    .overlay(
                        RoundedRectangle(cornerRadius: VRadius.lg)
                            .fill(VColor.surfaceSubtle.opacity(0.4))
                    )
            )
            .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
            .overlay(
                RoundedRectangle(cornerRadius: VRadius.lg)
                    .stroke(
                        isComposerFocused ? VColor.surfaceBorder : VColor.surfaceBorder.opacity(0.95),
                        lineWidth: isComposerFocused ? 1.5 : 1
                    )
            )
            .overlay(
                RoundedRectangle(cornerRadius: VRadius.lg)
                    .stroke(VColor.surfaceBorder.opacity(isComposerFocused ? 0.12 : 0), lineWidth: 3)
            )
            .shadow(color: .clear, radius: 0)
        }
        .animation(VAnimation.fast, value: showSlashMenu)
        .padding(.horizontal, VSpacing.lg)
        .padding(.top, VSpacing.sm)
        .padding(.bottom, VSpacing.md)
        .frame(maxWidth: 700)
        .frame(maxWidth: .infinity)
        .animation(VAnimation.fast, value: editorContentHeight)
        .animation(VAnimation.fast, value: isComposerExpanded)
        .animation(VAnimation.fast, value: isComposerFocused)
        .onAppear {
            composerFocusRequestID += 1
            let identity = IdentityInfo.load()
            avatarSeed = identity?.name ?? "default"
        }
    }

    // isComposerExpanded is a @Binding — sticky latch set true when text
    // wraps past a single line, reset when text clears. Prevents layout
    // oscillation and keeps ChatView.composerReservedHeight in sync.

    /// How far above the composer's top edge the slash popup should float.
    /// Uses a small gap so the popup sits just above the composer box.
    private var slashPopupOffset: CGFloat {
        VSpacing.md
    }

    private var clampedComposerHeight: CGFloat {
        min(max(editorContentHeight, composerCompactHeight), composerMaxHeight)
    }

    private var compactRowHeight: CGFloat {
        max(clampedComposerHeight, composerActionButtonSize)
    }

    private var composerTextField: some View {
        ComposerTextView(
            text: $inputText,
            placeholder: ghostSuffix == nil ? placeholderText : nil,
            hasGhostSuffix: ghostSuffix != nil,
            isEnabled: hasAPIKey,
            minHeight: composerCompactHeight,
            maxHeight: composerMaxHeight,
            focusRequestID: composerFocusRequestID,
            onHeightChange: { height in
                editorContentHeight = height
            },
            onOverflowChange: { overflowing in
                isEditorOverflowing = overflowing
            },
            onFocusChange: { focused in
                isComposerFocused = focused
            },
            onSubmit: {
                inputText = inputText.replacingOccurrences(
                    of: "\\n$", with: "", options: .regularExpression
                )
                if canSend { onSend() }
            },
            onAcceptSuggestion: onAcceptSuggestion,
            onPaste: onPaste,
            isSlashMenuOpen: showSlashMenu,
            onSlashNavigate: handleSlashNavigation
        )
        .accessibilityLabel("Message")
        .overlay(alignment: .leading) {
            if let ghostSuffix {
                (Text(inputText)
                    .font(VFont.body)
                    .foregroundColor(.clear)
                + Text(ghostSuffix)
                    .font(VFont.body)
                    .foregroundColor(VColor.textSecondary.opacity(0.55)))
                    .lineLimit(1...12)
                    .fixedSize(horizontal: false, vertical: true)
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .onChange(of: inputText) {
            if inputText.isEmpty {
                withAnimation(VAnimation.fast) { isComposerExpanded = false }
                withAnimation(VAnimation.fast) {
                    showSlashMenu = false
                }
            } else {
                updateSlashState()
            }
        }
        .onChange(of: editorContentHeight) {
            if editorContentHeight > composerCompactHeight && !isComposerExpanded {
                withAnimation(VAnimation.fast) { isComposerExpanded = true }
            } else if editorContentHeight <= composerCompactHeight && isComposerExpanded {
                withAnimation(VAnimation.fast) { isComposerExpanded = false }
            }
        }
    }

    @ViewBuilder
    private var composerActionButtons: some View {
        HStack(spacing: 2) {
            if isSending {
                Button(action: onStop) {
                    ZStack {
                        Circle()
                            .fill(VColor.textPrimary)
                            .frame(width: 30, height: 30)
                        RoundedRectangle(cornerRadius: VRadius.xs)
                            .fill(VColor.surface)
                            .frame(width: 10, height: 10)
                    }
                }
                .buttonStyle(ComposerActionButtonStyle(
                    isHovered: isStopHovered,
                    isFocused: focusedComposerAction == .stop,
                    size: composerActionButtonSize
                ))
                .focused($focusedComposerAction, equals: .stop)
                .focusable(true)
                .onHover { hovering in
                    handleComposerButtonHover(
                        hovering,
                        state: $isStopHovered
                    )
                }
                .accessibilityLabel("Stop generation")
            } else {
                Button(action: onAttach) {
                    Image(systemName: "paperclip")
                        .font(.system(size: composerActionIconSize, weight: .regular))
                        .foregroundColor(VColor.textSecondary.opacity(0.82))
                }
                .buttonStyle(ComposerActionButtonStyle(
                    isHovered: isAttachmentHovered,
                    isFocused: focusedComposerAction == .attachment,
                    size: composerActionButtonSize
                ))
                .focused($focusedComposerAction, equals: .attachment)
                .focusable(true)
                .onHover { hovering in
                    handleComposerButtonHover(
                        hovering,
                        state: $isAttachmentHovered,
                        isEnabled: hasAPIKey
                    )
                }
                .accessibilityLabel("Attach file")
                .disabled(!hasAPIKey)

                if canSend {
                    Button {
                        composerFocusRequestID += 1
                        onSend()
                    } label: {
                        ZStack {
                            RoundedRectangle(cornerRadius: 10)
                                .fill(VColor.sendButton)
                                .frame(width: 30, height: 30)
                            Image(systemName: "arrow.up")
                                .font(.system(size: 13, weight: .semibold))
                                .foregroundColor(.white)
                        }
                    }
                    .buttonStyle(ComposerActionButtonStyle(
                        isHovered: isSendHovered,
                        isFocused: focusedComposerAction == .send,
                        size: composerActionButtonSize
                    ))
                    .focused($focusedComposerAction, equals: .send)
                    .focusable(true)
                    .onHover { hovering in
                        handleComposerButtonHover(
                            hovering,
                            state: $isSendHovered
                        )
                    }
                    .accessibilityLabel("Send message")
                    .transition(.scale.combined(with: .opacity))
                } else {
                    MicrophoneButton(
                        isRecording: isRecording,
                        iconSize: composerActionIconSize,
                        action: onMicrophoneToggle
                    )
                        .buttonStyle(ComposerActionButtonStyle(
                            isHovered: isMicrophoneHovered,
                            isFocused: focusedComposerAction == .microphone,
                            size: composerActionButtonSize
                        ))
                        .focused($focusedComposerAction, equals: .microphone)
                        .focusable(true)
                        .onHover { hovering in
                            handleComposerButtonHover(
                                hovering,
                                state: $isMicrophoneHovered,
                                isEnabled: hasAPIKey
                            )
                        }
                        .disabled(!hasAPIKey)
                        .transition(.scale.combined(with: .opacity))
                }
            }
        }
        .padding(.trailing, VSpacing.xs)
        .animation(VAnimation.spring, value: canSend)
    }

    private func handleComposerButtonHover(
        _ hovering: Bool,
        state: Binding<Bool>,
        isEnabled: Bool = true
    ) {
        let resolvedHover = isEnabled && hovering
        state.wrappedValue = resolvedHover
        #if os(macOS)
        if resolvedHover {
            NSCursor.pointingHand.set()
        } else {
            NSCursor.arrow.set()
        }
        #endif
    }

    // MARK: - Attachment Preview Strip

    private var attachmentStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: VSpacing.sm) {
                ForEach(pendingAttachments) { attachment in
                    attachmentChip(attachment)
                }
            }
            .padding(.top, VSpacing.sm)
            .padding(.bottom, VSpacing.xs)
        }
    }

    private func attachmentChip(_ attachment: ChatAttachment) -> some View {
        let fileSize = formattedFileSize(base64Length: attachment.dataLength)
        let isImage = attachment.mimeType.hasPrefix("image/")

        return HStack(spacing: VSpacing.sm) {
            if isImage, let nsImage = attachment.thumbnailImage {
                Image(nsImage: nsImage)
                    .resizable()
                    .aspectRatio(contentMode: .fill)
                    .frame(width: 28, height: 28)
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
            } else {
                RoundedRectangle(cornerRadius: VRadius.sm)
                    .fill(VColor.surfaceBorder.opacity(0.5))
                    .frame(width: 28, height: 28)
                    .overlay {
                        Image(systemName: iconForMimeType(attachment.mimeType, filename: attachment.filename))
                            .font(.system(size: 14))
                            .foregroundColor(VColor.textSecondary)
                    }
            }

            Text(attachment.filename)
                .font(VFont.caption)
                .foregroundColor(VColor.textSecondary)
                .lineLimit(1)
                .truncationMode(.middle)

            Text("· \(fileSize)")
                .font(VFont.caption)
                .foregroundColor(VColor.textMuted)

            Button {
                onRemoveAttachment(attachment.id)
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 10))
                    .foregroundColor(VColor.textMuted)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Remove \(attachment.filename)")
        }
        .padding(.vertical, VSpacing.xs)
        .padding(.horizontal, VSpacing.sm)
        .background(VColor.surfaceBorder.opacity(0.3))
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
        .frame(maxWidth: 280)
    }

    // MARK: - Helpers

    private func formattedFileSize(base64Length: Int) -> String {
        let bytes = base64Length * 3 / 4
        if bytes < 1024 {
            return "\(bytes) B"
        } else if bytes < 1024 * 1024 {
            return "\(bytes / 1024) KB"
        } else {
            let mb = Double(bytes) / (1024 * 1024)
            return String(format: "%.1f MB", mb)
        }
    }

    private func fileExtension(_ filename: String) -> String {
        let parts = filename.split(separator: ".")
        guard parts.count > 1, let last = parts.last else { return "" }
        return String(last).uppercased()
    }

    private func iconForMimeType(_ mimeType: String, filename: String) -> String {
        if mimeType == "application/pdf" { return "doc.fill" }
        if mimeType.hasPrefix("text/") { return "doc.text.fill" }
        if mimeType.hasPrefix("image/") { return "photo" }
        let ext = filename.split(separator: ".").last.map(String.init) ?? ""
        switch ext.lowercased() {
        case "pdf": return "doc.fill"
        case "csv": return "tablecells"
        case "md", "txt": return "doc.text.fill"
        default: return "doc.fill"
        }
    }

    var canSend: Bool {
        hasAPIKey && (!inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !pendingAttachments.isEmpty)
    }

    // MARK: - Slash Command Logic

    private func filteredSlashCommands(_ filter: String) -> [SlashCommand] {
        SlashCommand.all.filter {
            filter.isEmpty || $0.name.lowercased().hasPrefix(filter.lowercased())
        }
    }

    private func updateSlashState() {
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

    private func selectSlashCommand(_ command: SlashCommand) {
        withAnimation(VAnimation.fast) { showSlashMenu = false }
        slashSelectedIndex = 0
        inputText = "/\(command.name)"
        onSend()
    }

    private func handleSlashNavigation(_ action: SlashNavigation) {
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
            case .dismiss:
                withAnimation(VAnimation.fast) { showSlashMenu = false }
                inputText = ""
            }
        }
    }
}

private struct ComposerTextView: NSViewRepresentable {
    @Binding var text: String
    let placeholder: String?
    let hasGhostSuffix: Bool
    let isEnabled: Bool
    let minHeight: CGFloat
    let maxHeight: CGFloat
    let focusRequestID: Int
    let onHeightChange: (CGFloat) -> Void
    var onOverflowChange: ((Bool) -> Void)?
    let onFocusChange: (Bool) -> Void
    let onSubmit: () -> Void
    let onAcceptSuggestion: () -> Void
    let onPaste: () -> Void
    var isSlashMenuOpen = false
    var onSlashNavigate: ((SlashNavigation) -> Void)?

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    static func dismantleNSView(_ scrollView: NSScrollView, coordinator: Coordinator) {
        if let textView = coordinator.textView {
            textView.undoManager?.removeAllActions(withTarget: textView)
            textView.undoManager?.removeAllActions()
        }
        coordinator.textView = nil
    }

    func makeNSView(context: Context) -> NSScrollView {
        let scrollView = NSScrollView()
        scrollView.drawsBackground = false
        scrollView.borderType = .noBorder
        scrollView.hasVerticalScroller = true
        scrollView.hasHorizontalScroller = false
        scrollView.autohidesScrollers = true

        // Use a centering clip view so text + cursor are vertically centered together
        let clipView = CenteringClipView()
        clipView.drawsBackground = false
        scrollView.contentView = clipView

        let textView = ComposerNativeTextView()
        textView.delegate = context.coordinator
        textView.isRichText = false
        textView.importsGraphics = false
        textView.isEditable = isEnabled
        textView.isSelectable = true
        textView.drawsBackground = false
        textView.allowsUndo = true
        textView.font = NSFont(name: "Inter", size: 13) ?? NSFont.systemFont(ofSize: 13)
        textView.textColor = NSColor(VColor.textPrimary)
        textView.insertionPointColor = NSColor(VColor.accent)
        textView.textContainerInset = NSSize(width: 0, height: 8)
        textView.string = text

        if let container = textView.textContainer {
            container.lineFragmentPadding = 0
            container.widthTracksTextView = true
            container.containerSize = NSSize(width: scrollView.contentSize.width, height: .greatestFiniteMagnitude)
        }

        textView.minSize = NSSize(width: 0, height: 0)
        textView.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        textView.isHorizontallyResizable = false
        textView.isVerticallyResizable = true
        textView.autoresizingMask = [.width]

        scrollView.documentView = textView
        context.coordinator.textView = textView
        context.coordinator.configureCallbacks()
        context.coordinator.syncHeight()

        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        context.coordinator.parent = self
        context.coordinator.configureCallbacks()

        guard let textView = context.coordinator.textView else { return }

        textView.isEditable = isEnabled
        let oldPlaceholder = textView.placeholderText
        let oldGhostSuffix = textView.hasGhostSuffix
        textView.placeholderText = placeholder
        textView.placeholderColor = NSColor(VColor.textSecondary).withAlphaComponent(0.92)
        textView.hasGhostSuffix = hasGhostSuffix
        textView.isSlashMenuOpen = isSlashMenuOpen

        // Force redraw when placeholder or ghost suffix state changes so stale text doesn't persist
        if oldPlaceholder != placeholder || oldGhostSuffix != hasGhostSuffix {
            textView.needsDisplay = true
        }

        if context.coordinator.isWritingFromView == false, textView.string != text {
            textView.string = text
            textView.needsDisplay = true
        }

        // Register the composer with the window so typing auto-focuses it.
        if let zoomableWindow = textView.window as? TitleBarZoomableWindow {
            zoomableWindow.composerTextView = textView
        }

        if context.coordinator.lastFocusRequestID != focusRequestID {
            context.coordinator.lastFocusRequestID = focusRequestID
            DispatchQueue.main.async {
                guard textView.window?.firstResponder !== textView else { return }
                textView.window?.makeFirstResponder(textView)
            }
        }

        context.coordinator.syncHeight()
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: ComposerTextView
        weak var textView: ComposerNativeTextView?
        var isWritingFromView = false
        var lastFocusRequestID = -1
        private var lastReportedHeight: CGFloat = 0

        init(parent: ComposerTextView) {
            self.parent = parent
        }

        func configureCallbacks() {
            guard let textView else { return }
            textView.onSubmit = { [weak self] in
                self?.parent.onSubmit()
            }
            textView.onAcceptSuggestion = { [weak self] in
                self?.parent.onAcceptSuggestion()
            }
            textView.onPaste = { [weak self] in
                self?.parent.onPaste()
            }
            textView.onFocusChange = { [weak self] focused in
                self?.parent.onFocusChange(focused)
            }
            textView.onSlashNavigate = { [weak self] action in
                self?.parent.onSlashNavigate?(action)
            }
        }

        func textDidChange(_ notification: Notification) {
            guard let textView else { return }
            isWritingFromView = true
            parent.text = textView.string
            isWritingFromView = false
            syncHeight()
            // After large pastes the scroll position may not reflect the
            // insertion point. Scroll to the cursor so pasted text is visible.
            textView.scrollRangeToVisible(textView.selectedRange())
        }

        func syncHeight() {
            guard let textView,
                  let layoutManager = textView.layoutManager,
                  let textContainer = textView.textContainer else { return }

            layoutManager.ensureLayout(for: textContainer)
            let usedRect = layoutManager.usedRect(for: textContainer)
            let verticalPadding: CGFloat = 16 // 8pt top + 8pt bottom visual breathing room
            let rawHeight = ceil(usedRect.height + verticalPadding)
            let clampedHeight = min(max(rawHeight, parent.minHeight), parent.maxHeight)

            parent.onOverflowChange?(rawHeight > parent.maxHeight)

            if abs(lastReportedHeight - clampedHeight) > 0.5 {
                // When content shrinks (e.g. deleting from 2 lines back to 1),
                // reset the scroll position so text isn't clipped at the top.
                if clampedHeight < lastReportedHeight {
                    textView.scrollToBeginningOfDocument(nil)
                }
                lastReportedHeight = clampedHeight
                parent.onHeightChange(clampedHeight)
            }
        }
    }
}

private final class ComposerNativeTextView: NSTextView {
    private let placeholderVerticalOffset: CGFloat = 0
    var onSubmit: (() -> Void)?
    var onAcceptSuggestion: (() -> Void)?
    var onPaste: (() -> Void)?
    var onFocusChange: ((Bool) -> Void)?
    var onSlashNavigate: ((SlashNavigation) -> Void)?
    var isSlashMenuOpen = false
    var placeholderText: String?
    var placeholderColor: NSColor = .placeholderTextColor
    var hasGhostSuffix = false

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)

        guard string.isEmpty,
              !hasGhostSuffix,
              let placeholderText,
              !placeholderText.isEmpty else { return }

        let paragraph = NSMutableParagraphStyle()
        paragraph.lineBreakMode = .byTruncatingTail

        let attributes: [NSAttributedString.Key: Any] = [
            .font: font ?? NSFont.systemFont(ofSize: 13),
            .foregroundColor: placeholderColor,
            .paragraphStyle: paragraph,
        ]

        let linePadding = textContainer?.lineFragmentPadding ?? 0
        let x = textContainerInset.width + linePadding
        let width = max(0, bounds.width - x - textContainerInset.width - linePadding)

        // Draw at the standard text insertion position and let
        // CenteringClipView handle vertical centering of the whole
        // scroll content — avoids double-centering misalignment.
        let y = textContainerInset.height
        let rect = NSRect(x: x, y: y, width: width, height: bounds.height - y)

        (placeholderText as NSString).draw(in: rect, withAttributes: attributes)
    }

    override func didChangeText() {
        super.didChangeText()
        needsDisplay = true
        highlightSlashCommand()
    }

    private func highlightSlashCommand() {
        guard let layoutManager = layoutManager, let textStorage = textStorage else { return }
        let fullRange = NSRange(location: 0, length: textStorage.length)
        guard fullRange.length > 0 else { return }

        // Reset to default text color
        layoutManager.addTemporaryAttributes(
            [.foregroundColor: NSColor(VColor.textPrimary)],
            forCharacterRange: fullRange
        )

        // Highlight slash command token (e.g. /model, /help)
        let text = textStorage.string
        if let match = text.range(of: #"^/\w+"#, options: .regularExpression) {
            let nsRange = NSRange(match, in: text)
            layoutManager.addTemporaryAttributes(
                [.foregroundColor: NSColor(Sage._500)],
                forCharacterRange: nsRange
            )
        }
    }

    override func keyDown(with event: NSEvent) {
        let modifiers = event.modifierFlags.intersection([.shift, .command, .control, .option])

        // Tab accepts ghost suggestions in-place when available.
        if event.keyCode == 48, !modifiers.contains(.shift), hasGhostSuffix {
            onAcceptSuggestion?()
            return
        }

        // Slash menu navigation (arrow keys, escape)
        if isSlashMenuOpen && modifiers.isEmpty {
            switch event.keyCode {
            case 126: // Up arrow
                onSlashNavigate?(.up)
                return
            case 125: // Down arrow
                onSlashNavigate?(.down)
                return
            case 53: // Escape
                onSlashNavigate?(.dismiss)
                return
            default:
                break
            }
        }

        // Enter sends; Shift+Enter inserts newline.
        // If ghost suggestion is visible, accept it first then send.
        if event.keyCode == 36 || event.keyCode == 76 {
            if modifiers == [.shift] {
                insertNewline(nil)
                return
            }
            if modifiers.isEmpty {
                if hasGhostSuffix {
                    onAcceptSuggestion?()
                    onSubmit?()
                } else if isSlashMenuOpen {
                    onSlashNavigate?(.select)
                } else {
                    onSubmit?()
                }
                return
            }
            return
        }

        super.keyDown(with: event)
    }

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        if event.modifierFlags.contains(.command),
           event.charactersIgnoringModifiers?.lowercased() == "v" {
            onPaste?()
        }
        return super.performKeyEquivalent(with: event)
    }

    override func becomeFirstResponder() -> Bool {
        let focused = super.becomeFirstResponder()
        if focused { onFocusChange?(true) }
        return focused
    }

    override func resignFirstResponder() -> Bool {
        let resigned = super.resignFirstResponder()
        if resigned { onFocusChange?(false) }
        return resigned
    }
}

// MARK: - Centering Clip View

/// Custom NSClipView that vertically centers the document view when
/// the content is shorter than the visible area. This keeps cursor,
/// text, and placeholder all aligned to the visual center of the
/// composer field. When content grows beyond the clip view bounds,
/// normal scroll behavior takes over.
private final class CenteringClipView: NSClipView {
    override func constrainBoundsRect(_ proposedBounds: NSRect) -> NSRect {
        var rect = super.constrainBoundsRect(proposedBounds)
        if let textView = documentView as? NSTextView,
           let layoutManager = textView.layoutManager,
           let textContainer = textView.textContainer {
            layoutManager.ensureLayout(for: textContainer)
            let usedHeight = layoutManager.usedRect(for: textContainer).height
            // Include the textContainerInset in the total content height so
            // centering accounts for the top/bottom padding the text view adds.
            let insetHeight = textView.textContainerInset.height * 2
            let contentHeight = usedHeight + insetHeight
            if contentHeight < bounds.height {
                rect.origin.y = (contentHeight - bounds.height) / 2
            }
        }
        return rect
    }
}

// MARK: - Microphone Button

private struct MicrophoneButton: View {
    let isRecording: Bool
    let iconSize: CGFloat
    let action: () -> Void
    @State private var isPulsing = false

    var body: some View {
        Button(action: action) {
            ZStack {
                if isRecording {
                    Circle()
                        .fill(VColor.error.opacity(0.2))
                        .frame(width: 30, height: 30)
                        .scaleEffect(isPulsing ? 1.3 : 1.0)
                        .opacity(isPulsing ? 0.0 : 1.0)
                        .animation(.easeInOut(duration: 1.0).repeatForever(autoreverses: false), value: isPulsing)
                }

                Image(systemName: isRecording ? "mic.fill" : "mic")
                    .font(.system(size: iconSize, weight: .regular))
                    .foregroundColor(isRecording ? VColor.error : VColor.textSecondary.opacity(0.82))
            }
        }
        .accessibilityLabel(isRecording ? "Stop recording" : "Start voice input")
        .onChange(of: isRecording) {
            isPulsing = isRecording
        }
        .onAppear {
            isPulsing = isRecording
        }
    }
}

private struct ComposerActionButtonStyle: ButtonStyle {
    let isHovered: Bool
    let isFocused: Bool
    let size: CGFloat

    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        let isInteractive = isEnabled && (isHovered || configuration.isPressed || isFocused)
        let backgroundOpacity: Double = {
            if !isInteractive { return 0 }
            return configuration.isPressed ? 0.5 : 0.28
        }()

        return configuration.label
            .frame(width: size, height: size)
            .background(
                RoundedRectangle(cornerRadius: VRadius.md)
                    .fill(VColor.surfaceBorder.opacity(backgroundOpacity))
            )
            .overlay(
                RoundedRectangle(cornerRadius: VRadius.md)
                    .stroke(
                        isEnabled && isFocused
                            ? VColor.accent.opacity(0.72)
                            : VColor.surfaceBorder.opacity(isEnabled && isHovered ? 0.5 : 0),
                        lineWidth: isEnabled && isFocused ? 1.25 : 1
                    )
            )
            .contentShape(RoundedRectangle(cornerRadius: VRadius.md))
            .focusEffectDisabled()
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .animation(VAnimation.fast, value: configuration.isPressed)
            .animation(VAnimation.fast, value: isHovered)
            .animation(VAnimation.fast, value: isFocused)
    }
}

// MARK: - Slash Command Popup

private struct SlashCommandPopup: View {
    let commands: [SlashCommand]
    let selectedIndex: Int
    let onSelect: (SlashCommand) -> Void
    let avatarSeed: String
    let avatarPalette: DinoPalette
    let avatarOutfit: DinoOutfit

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(commands.enumerated()), id: \.element.name) { index, command in
                SlashCommandRow(
                    command: command,
                    isSelected: index == selectedIndex,
                    onSelect: { onSelect(command) },
                    avatarSeed: avatarSeed,
                    avatarPalette: avatarPalette,
                    avatarOutfit: avatarOutfit
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

private struct SlashCommandRow: View {
    let command: SlashCommand
    let isSelected: Bool
    let onSelect: () -> Void
    let avatarSeed: String
    let avatarPalette: DinoPalette
    let avatarOutfit: DinoOutfit
    @State private var isHovered = false

    var body: some View {
        Button(action: onSelect) {
            HStack(spacing: VSpacing.md) {
                DinoFaceView(seed: avatarSeed, palette: avatarPalette, outfit: avatarOutfit)
                    .frame(width: 28, height: 28)
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
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
        .onHover { hovering in
            isHovered = hovering
            if hovering { NSCursor.pointingHand.push() } else { NSCursor.pop() }
        }
    }
}

