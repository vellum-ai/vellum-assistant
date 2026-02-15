import SwiftUI
import VellumAssistantShared

struct ComposerView: View {
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

    /// Bound to ChatView's state so it can compute composerReservedHeight for safe area insets.
    @Binding var editorContentHeight: CGFloat

    @State private var composerScrollOffset: CGFloat = 0
    @FocusState private var isComposerFocused: Bool

    /// The portion of the suggestion that extends beyond the current input.
    /// Returns nil when the composer content exceeds the max height (200pt) because
    /// the ghost text overlay is a sibling in the ZStack and would become misaligned
    /// once the TextEditor scrolls internally.
    private var ghostSuffix: String? {
        guard let suggestion else { return nil }
        guard editorContentHeight <= 200 else { return nil }
        if suggestion.hasPrefix(inputText) {
            let suffix = String(suggestion.dropFirst(inputText.count))
            return suffix.isEmpty ? nil : suffix
        }
        if inputText.isEmpty { return suggestion }
        return nil
    }

    var body: some View {
        VStack(spacing: 0) {
            if !pendingAttachments.isEmpty {
                attachmentStrip
            }

            if isComposerExpanded {
                // Expanded: text area on top, buttons on bottom row
                ZStack(alignment: .bottom) {
                    composerTextField
                        .frame(height: min(max(editorContentHeight, 28), 200))

                    if editorContentHeight > 200, !isScrolledToBottom {
                        LinearGradient(
                            colors: [VColor.surface.opacity(0), VColor.surface],
                            startPoint: .top,
                            endPoint: .bottom
                        )
                        .frame(height: 20)
                        .allowsHitTesting(false)
                    }
                }

                HStack(spacing: VSpacing.sm) {
                    Spacer()
                    composerActionButtons
                }
                .padding(.top, VSpacing.xs)
            } else {
                // Compact: text and buttons on the same row
                HStack(alignment: .center, spacing: VSpacing.sm) {
                    composerTextField
                        .frame(height: min(max(editorContentHeight, 28), 200))
                    composerActionButtons
                }
            }
        }
        .padding(.top, isComposerExpanded ? VSpacing.lg : VSpacing.sm)
        .padding(.bottom, VSpacing.sm)
        .padding(.leading, VSpacing.xl)
        .padding(.trailing, VSpacing.lg)
        .background(VColor.surface)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.xxl))
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.xxl)
                .stroke(VColor.surfaceBorder.opacity(0.5), lineWidth: 1)
        )
        .padding(.horizontal, VSpacing.xl)
        .padding(.top, VSpacing.md)
        .padding(.bottom, 18)
        .frame(maxWidth: 700)
        .frame(maxWidth: .infinity)
        .animation(VAnimation.fast, value: editorContentHeight)
        .onAppear { isComposerFocused = true }
        .onChange(of: isComposerFocused) { _, focused in
            // Re-focus the composer when it loses focus while the window is
            // still key (e.g. Cmd+Return resignsFirstResponder as a side effect).
            // Text selection in chat bubbles uses .textSelection(.enabled) which
            // doesn't steal focus, so this won't fight user interactions.
            if !focused, NSApp.keyWindow?.isKeyWindow == true {
                DispatchQueue.main.async {
                    isComposerFocused = true
                    // After re-focus, NSTextField selects all text by default.
                    // Clear the selection and place the cursor at the end.
                    DispatchQueue.main.async {
                        if let textView = NSApp.keyWindow?.firstResponder as? NSTextView {
                            let end = textView.string.count
                            textView.setSelectedRange(NSRange(location: end, length: 0))
                        }
                    }
                }
            }
        }
    }

    private var isComposerExpanded: Bool {
        editorContentHeight > 28
    }

    private var isScrolledToBottom: Bool {
        let maxOffset = editorContentHeight - 200
        return maxOffset <= 0 || composerScrollOffset >= maxOffset - 5
    }

    private var composerTextField: some View {
        ScrollViewReader { proxy in
        ScrollView(.vertical, showsIndicators: false) {
            ZStack(alignment: .leading) {
                TextField(
                    ghostSuffix != nil ? "" : "What would you like to do?",
                    text: $inputText,
                    axis: .vertical
                )
                .font(VFont.body)
                .foregroundColor(VColor.textPrimary)
                .lineSpacing(4)
                .textFieldStyle(.plain)
                .lineLimit(1...)
                .focused($isComposerFocused)
                .disabled(!hasAPIKey)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityLabel("Message")
                .overlay(alignment: .topLeading) {
                    if let ghostSuffix {
                        (Text(inputText)
                            .font(VFont.body)
                            .foregroundColor(.clear)
                        + Text(ghostSuffix)
                            .font(VFont.body)
                            .foregroundColor(VColor.textMuted.opacity(0.5)))
                            .lineSpacing(4)
                            .lineLimit(1...)
                            .fixedSize(horizontal: false, vertical: true)
                            .allowsHitTesting(false)
                            .accessibilityHidden(true)
                    }
                }
                .background(
                    GeometryReader { geo in
                        Color.clear
                            .onAppear { editorContentHeight = geo.size.height }
                            .onChange(of: geo.size.height) { _, h in
                                editorContentHeight = h
                            }
                    }
                )
            }
            .frame(minHeight: min(max(editorContentHeight, 28), 200), maxHeight: .infinity, alignment: .center)
            .background(ScrollOffsetReader(offset: $composerScrollOffset))

            // Invisible anchor for auto-scroll; extra height provides breathing room
            // so the last line isn't clipped by the fade gradient.
            Color.clear
                .frame(height: editorContentHeight > 200 ? 20 : 1)
                .id("composer-bottom")
        }
        .overlay(alignment: .topTrailing) {
            composerScrollIndicator
        }
        .scrollBounceBehavior(.basedOnSize)
        .scrollDisabled(editorContentHeight <= 200)
        .onChange(of: inputText) {
            if editorContentHeight > 200 {
                proxy.scrollTo("composer-bottom", anchor: .bottom)
            }
        }
        .onChange(of: editorContentHeight) {
            if editorContentHeight > 200 {
                proxy.scrollTo("composer-bottom", anchor: .bottom)
            }
        }
        .onKeyPress(.tab, phases: .down) { keyPress in
            if !keyPress.modifiers.contains(.shift), ghostSuffix != nil {
                onAcceptSuggestion()
                return .handled
            }
            return .ignored
        }
        .onKeyPress(.return, phases: .down) { keyPress in
            if keyPress.modifiers == .shift {
                if let textView = NSApp.keyWindow?.firstResponder as? NSTextView {
                    textView.insertNewlineIgnoringFieldEditor(nil)
                } else {
                    inputText += "\n"
                }
                return .handled
            }
            guard keyPress.modifiers.isEmpty else { return .ignored }
            inputText = inputText.replacingOccurrences(
                of: "\\n$", with: "", options: .regularExpression
            )
            if canSend {
                onSend()
            }
            return .handled
        }
        .onKeyPress(characters: CharacterSet(charactersIn: "v"), phases: .down) { keyPress in
            if keyPress.modifiers.contains(.command) {
                onPaste()
                return .ignored
            }
            return .ignored
        }
        } // ScrollViewReader
    }

    @ViewBuilder
    private var composerScrollIndicator: some View {
        let visibleHeight = min(max(editorContentHeight, 28), 200)
        let totalHeight = editorContentHeight

        if totalHeight > visibleHeight {
            let thumbRatio = visibleHeight / totalHeight
            let thumbHeight = max(thumbRatio * visibleHeight, 20)
            let maxScrollOffset = totalHeight - visibleHeight
            let progress = maxScrollOffset > 0
                ? min(max(composerScrollOffset / maxScrollOffset, 0), 1)
                : 0
            let thumbTravel = visibleHeight - thumbHeight - 4 // 2pt inset top+bottom
            let yOffset = 2 + progress * thumbTravel

            RoundedRectangle(cornerRadius: 2)
                .fill(Slate._400.opacity(0.5))
                .frame(width: 4, height: thumbHeight)
                .padding(.top, yOffset)
                .padding(.trailing, 4)
                .frame(maxHeight: .infinity, alignment: .top)
                .allowsHitTesting(false)
                .accessibilityHidden(true)
                .animation(VAnimation.fast, value: composerScrollOffset)
        }
    }

    @ViewBuilder
    private var composerActionButtons: some View {
        Group {
            if isSending {
                Button(action: onStop) {
                    ZStack {
                        Circle()
                            .fill(VColor.textPrimary)
                            .frame(width: 28, height: 28)
                        RoundedRectangle(cornerRadius: VRadius.xs)
                            .fill(VColor.surface)
                            .frame(width: 10, height: 10)
                    }
                }
                .buttonStyle(.plain)
                .frame(height: 28)
                .accessibilityLabel("Stop generation")
            } else {
                if canSend {
                    Button(action: onSend) {
                        ZStack {
                            Circle()
                                .fill(VColor.accent)
                                .frame(width: 28, height: 28)
                            Image(systemName: "arrow.up")
                                .font(.system(size: 14, weight: .bold))
                                .foregroundColor(.white)
                        }
                    }
                    .buttonStyle(.plain)
                    .frame(height: 28)
                    .accessibilityLabel("Send message")
                    .transition(.scale.combined(with: .opacity))
                } else {
                    MicrophoneButton(isRecording: isRecording, action: onMicrophoneToggle)
                        .disabled(!hasAPIKey)
                        .frame(height: 28)
                        .transition(.scale.combined(with: .opacity))
                }

                Button(action: onAttach) {
                    Image(systemName: "paperclip")
                        .font(.system(size: 16, weight: .medium))
                        .foregroundColor(VColor.textSecondary)
                        .frame(width: 28, height: 28)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Attach file")
                .disabled(!hasAPIKey)
            }
        }
        .animation(VAnimation.spring, value: canSend)
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
}

// MARK: - Microphone Button

private struct MicrophoneButton: View {
    let isRecording: Bool
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
                    .font(.system(size: 16, weight: .medium))
                    .foregroundColor(isRecording ? VColor.error : VColor.textSecondary)
                    .padding(6)
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(isRecording ? "Stop recording" : "Start voice input")
        .onChange(of: isRecording) {
            isPulsing = isRecording
        }
        .onAppear {
            isPulsing = isRecording
        }
    }
}

// MARK: - Composer Scroll Tracking

/// Reads the enclosing NSScrollView's content offset in real-time via AppKit notifications.
struct ScrollOffsetReader: NSViewRepresentable {
    @Binding var offset: CGFloat

    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        DispatchQueue.main.async {
            guard let scrollView = view.enclosingScrollView else { return }
            scrollView.contentView.postsBoundsChangedNotifications = true
            NotificationCenter.default.addObserver(
                context.coordinator,
                selector: #selector(Coordinator.boundsDidChange(_:)),
                name: NSView.boundsDidChangeNotification,
                object: scrollView.contentView
            )
        }
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {}

    func makeCoordinator() -> Coordinator {
        Coordinator(offset: $offset)
    }

    class Coordinator: NSObject {
        var offset: Binding<CGFloat>

        init(offset: Binding<CGFloat>) {
            self.offset = offset
        }

        deinit {
            NotificationCenter.default.removeObserver(self)
        }

        @objc func boundsDidChange(_ notification: Notification) {
            guard let clipView = notification.object as? NSClipView else { return }
            offset.wrappedValue = clipView.bounds.origin.y
        }
    }
}
