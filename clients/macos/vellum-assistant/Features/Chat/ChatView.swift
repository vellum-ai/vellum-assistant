import SwiftUI

struct ChatView: View {
    let messages: [ChatMessage]
    @Binding var inputText: String
    let isThinking: Bool
    let isSending: Bool
    let errorText: String?
    let pendingQueuedCount: Int
    let suggestion: String?
    let pendingAttachments: [ChatAttachment]
    let onSend: () -> Void
    let onStop: () -> Void
    let onDismissError: () -> Void
    let onAcceptSuggestion: () -> Void
    let onAttach: () -> Void
    let onConfirmationAllow: (String) -> Void
    let onConfirmationDeny: (String) -> Void

    /// The portion of the suggestion that extends beyond the current input.
    private var ghostSuffix: String? {
        guard let suggestion else { return nil }
        if suggestion.hasPrefix(inputText) {
            let suffix = String(suggestion.dropFirst(inputText.count))
            return suffix.isEmpty ? nil : suffix
        }
        if inputText.isEmpty { return suggestion }
        return nil
    }

    /// Triggers auto-scroll when the last message's text length changes (e.g. during streaming).
    private var streamingScrollTrigger: Int {
        messages.last?.text.count ?? 0
    }

    var body: some View {
        ZStack(alignment: .bottom) {
            Image("bg", bundle: ResourceBundle.bundle)
                .resizable()
                .scaledToFit()
                .opacity(0.3)
                .allowsHitTesting(false)

            VStack(spacing: 0) {
                messageList
                if let errorText {
                    errorBanner(errorText)
                }
                queueSummary
                composerArea
            }
        }
    }

    // MARK: - Message List

    private var messageList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: VSpacing.md) {
                    ForEach(messages) { message in
                        if let confirmation = message.confirmation {
                            ToolConfirmationBubble(
                                confirmation: confirmation,
                                onAllow: { onConfirmationAllow(confirmation.requestId) },
                                onDeny: { onConfirmationDeny(confirmation.requestId) }
                            )
                            .id(message.id)
                            .transition(.opacity.combined(with: .move(edge: .bottom)))
                        } else {
                            ChatBubble(message: message)
                                .id(message.id)
                                .transition(.opacity.combined(with: .move(edge: .bottom)))
                        }
                    }

                    if isThinking {
                        ThinkingIndicator()
                            .id("thinking-indicator")
                            .transition(.opacity.combined(with: .move(edge: .bottom)))
                    }
                }
                .padding(.horizontal, VSpacing.xl)
                .padding(.vertical, VSpacing.md)
                .frame(maxWidth: 700)
                .frame(maxWidth: .infinity)
            }
            .scrollContentBackground(.hidden)
            .onChange(of: messages.count) {
                withAnimation(VAnimation.standard) {
                    if let lastMessage = messages.last {
                        proxy.scrollTo(lastMessage.id, anchor: .bottom)
                    }
                }
            }
            .onChange(of: isThinking) {
                if isThinking {
                    withAnimation(VAnimation.standard) {
                        proxy.scrollTo("thinking-indicator", anchor: .bottom)
                    }
                }
            }
            .onChange(of: streamingScrollTrigger) {
                withAnimation(VAnimation.fast) {
                    if let lastMessage = messages.last {
                        proxy.scrollTo(lastMessage.id, anchor: .bottom)
                    }
                }
            }
        }
    }

    // MARK: - Error Banner

    private func errorBanner(_ text: String) -> some View {
        HStack(spacing: VSpacing.sm) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(VFont.caption)

            Text(text)
                .font(VFont.caption)
                .lineLimit(2)

            Spacer()

            Button {
                onDismissError()
            } label: {
                Image(systemName: "xmark")
                    .font(VFont.caption)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Dismiss error")
        }
        .foregroundColor(.white)
        .padding(.horizontal, VSpacing.lg)
        .padding(.vertical, VSpacing.sm)
        .background(VColor.error)
    }

    // MARK: - Queue Summary

    @ViewBuilder
    private var queueSummary: some View {
        if pendingQueuedCount > 0 {
            HStack(spacing: VSpacing.xs) {
                Image(systemName: "text.line.first.and.arrowtriangle.forward")
                    .font(VFont.caption)
                Text(pendingQueuedCount == 1
                     ? "1 message queued, sending automatically"
                     : "\(pendingQueuedCount) messages queued, sending automatically")
                    .font(VFont.caption)
            }
            .foregroundColor(VColor.textSecondary)
            .padding(.horizontal, VSpacing.lg)
            .padding(.vertical, VSpacing.xs)
            .transition(.opacity)
        }
    }

    // MARK: - Composer Area

    private var composerArea: some View {
        HStack(spacing: VSpacing.sm) {
            // Leading chat icon
            VCircleButton(icon: "phone.fill", label: "Phone") { }

            // Text field with ghost suffix overlay
            ZStack(alignment: .leading) {
                TextField("", text: $inputText, axis: .vertical)
                    .textFieldStyle(.plain)
                    .font(VFont.mono)
                    .foregroundColor(VColor.textPrimary)
                    .lineLimit(1...3)
                    .onKeyPress(.tab, phases: .down) { keyPress in
                        if !keyPress.modifiers.contains(.shift), ghostSuffix != nil {
                            onAcceptSuggestion()
                            return .handled
                        }
                        return .ignored
                    }
                    .onKeyPress(.return, phases: .down) { keyPress in
                        if keyPress.modifiers.contains(.shift) { return .ignored }
                        if canSend { onSend() }
                        return .handled
                    }
                    .onSubmit { if canSend { onSend() } }

                if let ghostSuffix {
                    Text(inputText + ghostSuffix)
                        .font(VFont.mono)
                        .foregroundColor(.clear)
                        .lineLimit(1...3)
                        .overlay(alignment: .leading) {
                            HStack(spacing: 0) {
                                Text(inputText)
                                    .font(VFont.mono)
                                    .foregroundColor(.clear)
                                Text(ghostSuffix)
                                    .font(VFont.mono)
                                    .foregroundColor(VColor.textMuted.opacity(0.5))
                            }
                        }
                        .allowsHitTesting(false)
                        .accessibilityHidden(true)
                }
            }

            // Attachment / Stop button
            if isSending {
                Button(action: onStop) {
                    Image(systemName: "stop.circle.fill")
                        .font(.system(size: 20, weight: .medium))
                        .foregroundColor(VColor.error)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Stop generation")
            } else {
                Button(action: onAttach) {
                    Image(systemName: "paperclip")
                        .font(.system(size: 16, weight: .medium))
                        .foregroundColor(VColor.textSecondary)
                        .padding(10)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Attach file")
            }
        }
        .padding(VSpacing.xs)
        .background(VColor.surface)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.pill))
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.pill)
                .stroke(VColor.surfaceBorder.opacity(0.5), lineWidth: 1)
        )
        .padding(.horizontal, VSpacing.xl)
        .padding(.vertical, VSpacing.lg)
        .frame(maxWidth: 700)
        .frame(maxWidth: .infinity)
    }

    private var canSend: Bool {
        !inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !pendingAttachments.isEmpty
    }
}

// MARK: - Chat Bubble

private struct ChatBubble: View {
    let message: ChatMessage

    private var isUser: Bool { message.role == .user }

    private var statusLabel: String? {
        switch message.status {
        case .queued(let position):
            return position > 0 ? "Queued (\(ordinal(position)) in line)" : "Queued"
        case .processing:
            return "Sending\u{2026}"
        case .sent:
            return nil
        }
    }

    private var bubbleOpacity: Double {
        switch message.status {
        case .queued: return 0.7
        case .processing: return 0.85
        case .sent: return 1.0
        }
    }

    private var formattedTimestamp: String {
        let calendar = Calendar.current
        let formatter = DateFormatter()
        formatter.dateFormat = "H:mm"
        let timeString = formatter.string(from: message.timestamp)
        if calendar.isDateInToday(message.timestamp) {
            return "Today, \(timeString)"
        } else {
            let dayFormatter = DateFormatter()
            dayFormatter.dateFormat = "MMM d"
            return "\(dayFormatter.string(from: message.timestamp)), \(timeString)"
        }
    }

    var body: some View {
        HStack {
            if isUser { Spacer(minLength: 0) }

            VStack(alignment: isUser ? .trailing : .leading, spacing: 2) {
                bubbleContent

                if let label = statusLabel {
                    Text(label)
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                }

                Text(formattedTimestamp)
                    .font(VFont.caption)
                    .foregroundColor(VColor.textMuted)
            }

            if !isUser { Spacer(minLength: 0) }
        }
    }

    private var hasText: Bool {
        !message.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var imageAttachments: [ChatAttachment] {
        message.attachments.filter { $0.mimeType.hasPrefix("image/") }
    }

    private var fileAttachments: [ChatAttachment] {
        message.attachments.filter { !$0.mimeType.hasPrefix("image/") }
    }

    private var bubbleContent: some View {
        VStack(alignment: .leading, spacing: hasText && !message.attachments.isEmpty ? VSpacing.sm : 0) {
            if hasText {
                Text(markdownText)
                    .font(VFont.mono)
                    .foregroundColor(isUser ? .white : VColor.textPrimary)
                    .tint(isUser ? .white : VColor.accent)
                    .textSelection(.enabled)
            }

            if !imageAttachments.isEmpty {
                attachmentImageGrid
            }

            if !fileAttachments.isEmpty {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    ForEach(fileAttachments) { attachment in
                        fileAttachmentChip(attachment)
                    }
                }
            }
        }
        .padding(.horizontal, VSpacing.lg)
        .padding(.vertical, VSpacing.md)
        .background(
            RoundedRectangle(cornerRadius: VRadius.md)
                .fill(isUser ? VColor.accent : VColor.surface.opacity(0.5))
        )
        .frame(maxWidth: 500, alignment: isUser ? .trailing : .leading)
        .opacity(bubbleOpacity)
    }

    private var attachmentImageGrid: some View {
        // Wrap images in a flexible horizontal layout
        HStack(alignment: .top, spacing: VSpacing.sm) {
            ForEach(imageAttachments) { attachment in
                attachmentImage(attachment)
            }
        }
    }

    private func attachmentImage(_ attachment: ChatAttachment) -> some View {
        Group {
            if let nsImage = nsImage(for: attachment) {
                Image(nsImage: nsImage)
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .frame(maxWidth: 280)
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                    .onTapGesture {
                        openImageInPreview(attachment)
                    }
            }
        }
    }

    private func fileAttachmentChip(_ attachment: ChatAttachment) -> some View {
        HStack(spacing: VSpacing.xs) {
            Image(systemName: fileIcon(for: attachment.mimeType))
                .font(VFont.caption)
                .foregroundColor(isUser ? .white.opacity(0.8) : VColor.textSecondary)

            Text(attachment.filename)
                .font(VFont.caption)
                .foregroundColor(isUser ? .white : VColor.textPrimary)
                .lineLimit(1)

            Text(formattedFileSize(base64Length: attachment.data.count))
                .font(VFont.small)
                .foregroundColor(isUser ? .white.opacity(0.6) : VColor.textMuted)
        }
        .padding(.horizontal, VSpacing.sm)
        .padding(.vertical, VSpacing.xs)
        .background(
            RoundedRectangle(cornerRadius: VRadius.sm)
                .fill(isUser ? Color.white.opacity(0.15) : VColor.surfaceBorder.opacity(0.5))
        )
    }

    private func nsImage(for attachment: ChatAttachment) -> NSImage? {
        if let thumbnailData = attachment.thumbnailData, let img = NSImage(data: thumbnailData) {
            return img
        }
        if let data = Data(base64Encoded: attachment.data), let img = NSImage(data: data) {
            return img
        }
        return nil
    }

    private func openImageInPreview(_ attachment: ChatAttachment) {
        guard let data = Data(base64Encoded: attachment.data) else { return }
        let tempDir = FileManager.default.temporaryDirectory
        let fileURL = tempDir.appendingPathComponent(attachment.filename)
        do {
            try data.write(to: fileURL)
            NSWorkspace.shared.open(fileURL)
        } catch {
            // Silently fail — not critical
        }
    }

    private func fileIcon(for mimeType: String) -> String {
        if mimeType.hasPrefix("text/") { return "doc.text.fill" }
        if mimeType == "application/pdf" { return "doc.fill" }
        if mimeType.contains("zip") || mimeType.contains("archive") { return "doc.zipper" }
        if mimeType.contains("json") || mimeType.contains("xml") { return "doc.text.fill" }
        return "doc.fill"
    }

    private func formattedFileSize(base64Length: Int) -> String {
        let bytes = base64Length * 3 / 4
        if bytes < 1024 { return "\(bytes) B" }
        let kb = Double(bytes) / 1024
        if kb < 1024 { return String(format: "%.1f KB", kb) }
        let mb = kb / 1024
        return String(format: "%.1f MB", mb)
    }

    private var markdownText: AttributedString {
        let options = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .inlineOnlyPreservingWhitespace
        )
        return (try? AttributedString(markdown: message.text, options: options))
            ?? AttributedString(message.text)
    }

    private func ordinal(_ n: Int) -> String {
        let suffix: String
        let ones = n % 10
        let tens = (n / 10) % 10
        if tens == 1 {
            suffix = "th"
        } else {
            switch ones {
            case 1: suffix = "st"
            case 2: suffix = "nd"
            case 3: suffix = "rd"
            default: suffix = "th"
            }
        }
        return "\(n)\(suffix)"
    }
}

// MARK: - Thinking Indicator

private struct ThinkingIndicator: View {
    @State private var phase: Int = 0
    @State private var timer: Timer?

    var body: some View {
        HStack(spacing: VSpacing.xs) {
            Text("Thinking")
                .font(VFont.caption)
                .foregroundColor(VColor.textSecondary)

            ForEach(0..<3, id: \.self) { index in
                Circle()
                    .fill(VColor.textSecondary)
                    .frame(width: 5, height: 5)
                    .opacity(dotOpacity(for: index))
            }

            Spacer()
        }
        .onAppear { startAnimation() }
        .onDisappear { timer?.invalidate() }
    }

    private func dotOpacity(for index: Int) -> Double {
        phase == index ? 1.0 : 0.4
    }

    private func startAnimation() {
        timer = Timer.scheduledTimer(withTimeInterval: 0.4, repeats: true) { _ in
            withAnimation(.easeInOut(duration: 0.3)) {
                phase = (phase + 1) % 3
            }
        }
    }
}

// MARK: - Preview

#if DEBUG
#Preview("ChatView") {
    @Previewable @State var text = ""

    let sampleMessages: [ChatMessage] = [
        ChatMessage(role: .assistant, text: "Hello! How can I help you today?"),
        ChatMessage(role: .user, text: "Can you tell me about SwiftUI?"),
        ChatMessage(
            role: .assistant,
            text: "SwiftUI is a declarative framework for building user interfaces across Apple platforms. It uses a reactive data-binding model and composable view hierarchy."
        ),
        ChatMessage(role: .user, text: "That sounds great, thanks!"),
    ]

    ZStack {
        VColor.background.ignoresSafeArea()
        ChatView(
            messages: sampleMessages,
            inputText: $text,
            isThinking: true,
            isSending: false,
            errorText: nil,
            pendingQueuedCount: 0,
            suggestion: "That sounds great, thanks!",
            pendingAttachments: [],
            onSend: {},
            onStop: {},
            onDismissError: {},
            onAcceptSuggestion: {},
            onAttach: {},
            onConfirmationAllow: { _ in },
            onConfirmationDeny: { _ in }
        )
    }
    .frame(width: 600, height: 500)
}
#endif
