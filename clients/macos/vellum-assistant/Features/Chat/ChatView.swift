import SwiftUI
import VellumAssistantShared
import UniformTypeIdentifiers

struct ChatView: View {
    let messages: [ChatMessage]
    @Binding var inputText: String
    let hasAPIKey: Bool
    let isThinking: Bool
    let isSending: Bool
    let errorText: String?
    let pendingQueuedCount: Int
    let suggestion: String?
    let pendingAttachments: [ChatAttachment]
    let isRecording: Bool
    let onOpenSettings: () -> Void
    let onSend: () -> Void
    let onStop: () -> Void
    let onDismissError: () -> Void
    let onAcceptSuggestion: () -> Void
    let onAttach: () -> Void
    let onRemoveAttachment: (String) -> Void
    let onDropFiles: ([URL]) -> Void
    let onDropImageData: (Data, String?) -> Void
    let onPaste: () -> Void
    let onMicrophoneToggle: () -> Void
    let onConfirmationAllow: (String) -> Void
    let onConfirmationDeny: (String) -> Void
    let onAddTrustRule: (String, String, String, String) -> Bool
    let onSurfaceAction: (String, String, [String: AnyCodable]?) -> Void
    let onRegenerate: () -> Void

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
        let last = messages.last
        return (last?.text.count ?? 0) + (last?.toolCalls.count ?? 0) + (last?.inlineSurfaces.count ?? 0)
    }

    @State private var isDropTargeted = false

    var body: some View {
        ZStack {
            VStack(spacing: 0) {
                apiKeyBanner
                messageList
                if let errorText {
                    errorBanner(errorText)
                }
                queueSummary
                composerArea
            }
            .background(alignment: .bottom) {
                chatBackground
            }
            .background(VColor.chatBackground)

            // Drop target overlay
            if isDropTargeted {
                RoundedRectangle(cornerRadius: VRadius.lg)
                    .stroke(VColor.accent, style: StrokeStyle(lineWidth: 2, dash: [8, 4]))
                    .background(
                        RoundedRectangle(cornerRadius: VRadius.lg)
                            .fill(VColor.accent.opacity(0.08))
                    )
                    .overlay {
                        VStack(spacing: VSpacing.sm) {
                            Image(systemName: "arrow.down.doc.fill")
                                .font(.system(size: 28, weight: .medium))
                                .foregroundColor(VColor.accent)
                            Text("Drop files here")
                                .font(VFont.bodyMedium)
                                .foregroundColor(VColor.accent)
                        }
                    }
                    .padding(VSpacing.lg)
                    .allowsHitTesting(false)
                    .transition(.opacity)
            }
        }
        .onDrop(of: [.fileURL, .image, .png, .tiff], isTargeted: $isDropTargeted) { providers in
            handleDrop(providers: providers)
        }
    }

    @ViewBuilder
    private var chatBackground: some View {
        if let url = ResourceBundle.bundle.url(forResource: "background", withExtension: "png"),
           let nsImage = NSImage(contentsOf: url) {
            Image(nsImage: nsImage)
                .resizable()
                .scaledToFit()
                .allowsHitTesting(false)
        }
    }

    /// Handle dropped items — supports both file URLs and raw image data.
    private func handleDrop(providers: [NSItemProvider]) -> Bool {
        var urls: [URL] = []
        var imageDataItems: [NSItemProvider] = []
        let group = DispatchGroup()

        for provider in providers {
            if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
                // File URL drop (e.g. dragging a saved file)
                group.enter()
                _ = provider.loadObject(ofClass: URL.self) { url, _ in
                    DispatchQueue.main.async {
                        if let url { urls.append(url) }
                        group.leave()
                    }
                }
            } else if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier)
                        || provider.hasItemConformingToTypeIdentifier(UTType.png.identifier)
                        || provider.hasItemConformingToTypeIdentifier(UTType.tiff.identifier) {
                // Raw image data drop (e.g. dragging a screenshot thumbnail)
                imageDataItems.append(provider)
            }
        }

        // Load image data items
        for provider in imageDataItems {
            // Try PNG first, then TIFF, then generic image
            let typeIdentifier: String
            if provider.hasItemConformingToTypeIdentifier(UTType.png.identifier) {
                typeIdentifier = UTType.png.identifier
            } else if provider.hasItemConformingToTypeIdentifier(UTType.tiff.identifier) {
                typeIdentifier = UTType.tiff.identifier
            } else {
                typeIdentifier = UTType.image.identifier
            }

            let suggestedName = provider.suggestedName
            group.enter()
            provider.loadDataRepresentation(forTypeIdentifier: typeIdentifier) { data, _ in
                DispatchQueue.main.async {
                    if let data {
                        onDropImageData(data, suggestedName)
                    }
                    group.leave()
                }
            }
        }

        group.notify(queue: .main) {
            if !urls.isEmpty { onDropFiles(urls) }
        }
        return true
    }

    // MARK: - Message List

    private func shouldShowTimestamp(at index: Int) -> Bool {
        if index == 0 { return true }
        let current = messages[index].timestamp
        let previous = messages[index - 1].timestamp
        // Always show a divider when crossing a calendar-day boundary
        if !Calendar.current.isDate(current, inSameDayAs: previous) { return true }
        let gap = current.timeIntervalSince(previous)
        return gap > 300
    }

    private var messageList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: VSpacing.lg) {
                    ForEach(Array(messages.enumerated()), id: \.element.id) { index, message in
                        if shouldShowTimestamp(at: index) {
                            TimestampDivider(date: message.timestamp)
                        }

                        if let confirmation = message.confirmation {
                            ToolConfirmationBubble(
                                confirmation: confirmation,
                                onAllow: { onConfirmationAllow(confirmation.requestId) },
                                onDeny: { onConfirmationDeny(confirmation.requestId) },
                                onAddTrustRule: onAddTrustRule
                            )
                            .id(message.id)
                            .transition(.opacity.combined(with: .move(edge: .bottom)))
                        } else {
                            ChatBubble(message: message, onSurfaceAction: onSurfaceAction)
                                .id(message.id)
                                .transition(.opacity.combined(with: .move(edge: .bottom)))
                        }

                        // Regenerate button on the last assistant message
                        if message.role == .assistant
                            && !message.isStreaming
                            && index == messages.count - 1
                            && !isSending {
                            HStack {
                                Button(action: onRegenerate) {
                                    Image(systemName: "arrow.trianglehead.counterclockwise")
                                        .font(.system(size: 13, weight: .medium))
                                        .foregroundColor(VColor.textMuted)
                                }
                                .buttonStyle(.plain)
                                .accessibilityLabel("Regenerate response")
                                .help("Regenerate response")
                                Spacer()
                            }
                            .padding(.top, -VSpacing.sm)
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
        VStack(spacing: 0) {
            if !pendingAttachments.isEmpty {
                attachmentStrip
            }

            HStack(spacing: VSpacing.sm) {
                // Text field with ghost suffix overlay
                ZStack(alignment: .leading) {
                    TextField("", text: $inputText, axis: .vertical)
                        .textFieldStyle(.plain)
                        .font(VFont.body)
                        .foregroundColor(VColor.textPrimary)
                        .lineLimit(1...3)
                        .disabled(!hasAPIKey)
                        .accessibilityLabel("Message")
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
                        .onKeyPress(characters: CharacterSet(charactersIn: "v"), phases: .down) { keyPress in
                            if keyPress.modifiers.contains(.command) {
                                onPaste()
                                return .ignored
                            }
                            return .ignored
                        }
                        .onSubmit { if canSend { onSend() } }

                    if let ghostSuffix {
                        Text(inputText + ghostSuffix)
                            .font(VFont.body)
                            .foregroundColor(.clear)
                            .lineLimit(1...3)
                            .overlay(alignment: .leading) {
                                HStack(spacing: 0) {
                                    Text(inputText)
                                        .font(VFont.body)
                                        .foregroundColor(.clear)
                                    Text(ghostSuffix)
                                        .font(VFont.body)
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
                    .accessibilityLabel("Stop generation")
                } else {
                    MicrophoneButton(isRecording: isRecording, action: onMicrophoneToggle)
                        .disabled(!hasAPIKey)

                    Button(action: onAttach) {
                        Image(systemName: "paperclip")
                            .font(.system(size: 16, weight: .medium))
                            .foregroundColor(VColor.textSecondary)
                            .padding(6)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Attach file")
                    .disabled(!hasAPIKey)
                }
            }
        }
        .padding(.horizontal, VSpacing.xl)
        .padding(.vertical, VSpacing.sm)
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

    // MARK: - Attachment Preview Strip

    private var attachmentStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: VSpacing.sm) {
                ForEach(pendingAttachments) { attachment in
                    attachmentChip(attachment)
                }
            }
            .padding(.horizontal, VSpacing.sm)
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

    // MARK: - Attachment Helpers

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

    private var canSend: Bool {
        hasAPIKey && (!inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !pendingAttachments.isEmpty)
    }

    @ViewBuilder
    private var apiKeyBanner: some View {
        if !hasAPIKey {
            HStack(spacing: VSpacing.sm) {
                Image(systemName: "key.fill")
                    .font(VFont.caption)
                Text("API key not set. Add one in Settings to start chatting.")
                    .font(VFont.caption)
                    .lineLimit(2)
                Spacer()
                Button("Open Settings", action: onOpenSettings)
                    .buttonStyle(.borderedProminent)
            }
            .padding(.horizontal, VSpacing.lg)
            .padding(.vertical, VSpacing.sm)
            .foregroundColor(.white)
            .background(VColor.warning)
        }
    }
}

// MARK: - Chat Bubble

private struct ChatBubble: View {
    let message: ChatMessage
    let onSurfaceAction: (String, String, [String: AnyCodable]?) -> Void

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

    private var bubbleFill: AnyShapeStyle {
        if isUser {
            AnyShapeStyle(
                LinearGradient(
                    colors: [Meadow.userBubbleGradientStart, Meadow.userBubbleGradientEnd],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                )
            )
        } else {
            AnyShapeStyle(VColor.surface)
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

    /// Whether the text/attachment bubble should be rendered.
    /// Tool calls for assistant messages render outside the bubble as separate chips,
    /// so only show the bubble when there's actual text or attachment content.
    ///
    /// NOTE: When inline surfaces are present, the bubble is intentionally hidden
    /// even if the message also contains text. This is by design — the assistant's
    /// text in these cases is typically a preamble (e.g. "Here's what I built:")
    /// that should not appear above the rendered dynamic UI surface.
    private var shouldShowBubble: Bool {
        if isUser { return true }
        if !message.inlineSurfaces.isEmpty { return false }
        return hasText || !message.attachments.isEmpty
    }

    var body: some View {
        HStack {
            if isUser { Spacer(minLength: 0) }

            VStack(alignment: isUser ? .trailing : .leading, spacing: VSpacing.sm) {
                if shouldShowBubble {
                    bubbleContent
                }

                // Tool calls render outside the bubble as compact chips.
                // Hidden when inline surfaces are present — the dynamic UI replaces the tool output.
                if !isUser && !message.toolCalls.isEmpty && message.inlineSurfaces.isEmpty {
                    VStack(alignment: .leading, spacing: VSpacing.xs) {
                        ForEach(message.toolCalls) { toolCall in
                            ToolCallChip(toolCall: toolCall)
                        }
                    }
                    .frame(maxWidth: 520, alignment: .leading)
                }

                // Inline surfaces render below the bubble as full-width cards
                if !message.inlineSurfaces.isEmpty {
                    ForEach(message.inlineSurfaces) { surface in
                        InlineSurfaceRouter(surface: surface, onAction: onSurfaceAction)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }

                if let label = statusLabel {
                    Text(label)
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                }
            }

            if !isUser { Spacer(minLength: 0) }
        }
    }

    private var hasText: Bool {
        !message.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var attachmentSummary: String {
        let count = message.attachments.count
        if count == 1 {
            return "Sent \(message.attachments[0].filename)"
        }
        return "Sent \(count) attachments"
    }

    /// Partitions attachments into decoded images and non-image files in a single pass,
    /// avoiding redundant base64 decoding and NSImage construction across render calls.
    private var partitionedAttachments: (images: [(ChatAttachment, NSImage)], files: [ChatAttachment]) {
        var images: [(ChatAttachment, NSImage)] = []
        var files: [ChatAttachment] = []
        for attachment in message.attachments {
            if attachment.mimeType.hasPrefix("image/"), let img = nsImage(for: attachment) {
                images.append((attachment, img))
            } else {
                files.append(attachment)
            }
        }
        return (images, files)
    }

    private var bubbleContent: some View {
        let partitioned = partitionedAttachments
        return VStack(alignment: .leading, spacing: VSpacing.sm) {
            if let skillInvocation = message.skillInvocation {
                SkillInvocationChip(data: skillInvocation)
            }

            if hasText {
                Text(markdownText)
                    .font(VFont.body)
                    .foregroundColor(isUser ? .white : VColor.textPrimary)
                    .tint(isUser ? .white : VColor.accent)
                    .textSelection(.enabled)
            } else if !message.attachments.isEmpty {
                Text(attachmentSummary)
                    .font(VFont.caption)
                    .foregroundColor(isUser ? .white.opacity(0.8) : VColor.textSecondary)
            }

            if !partitioned.images.isEmpty {
                attachmentImageGrid(partitioned.images)
            }

            if !partitioned.files.isEmpty {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    ForEach(partitioned.files) { attachment in
                        fileAttachmentChip(attachment)
                    }
                }
            }

            // User messages keep tool calls inside the bubble
            if isUser && !message.toolCalls.isEmpty {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    ForEach(message.toolCalls) { toolCall in
                        ToolCallChip(toolCall: toolCall)
                    }
                }
            }
        }
        .padding(.horizontal, VSpacing.lg)
        .padding(.vertical, VSpacing.md)
        .background(
            RoundedRectangle(cornerRadius: VRadius.lg)
                .fill(bubbleFill)
        )
        .vShadow(VShadow.sm)
        .frame(maxWidth: 520, alignment: isUser ? .trailing : .leading)
        .opacity(bubbleOpacity)
    }

    private func attachmentImageGrid(_ images: [(ChatAttachment, NSImage)]) -> some View {
        HStack(alignment: .top, spacing: VSpacing.sm) {
            ForEach(images, id: \.0.id) { attachment, nsImage in
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

            Text(formattedFileSize(base64Length: attachment.dataLength))
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
        let trimmed = message.text.trimmingCharacters(in: .whitespacesAndNewlines)
        let options = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .inlineOnlyPreservingWhitespace
        )
        return (try? AttributedString(markdown: trimmed, options: options))
            ?? AttributedString(trimmed)
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

// MARK: - Timestamp Divider

private struct TimestampDivider: View {
    let date: Date

    private var formattedTime: String {
        let calendar = Calendar.current
        let formatter = DateFormatter()
        formatter.dateFormat = "h:mm a"
        let timeString = formatter.string(from: date)
        if calendar.isDateInToday(date) {
            return "Today at \(timeString)"
        } else if calendar.isDateInYesterday(date) {
            return "Yesterday at \(timeString)"
        } else {
            let dayFormatter = DateFormatter()
            dayFormatter.dateFormat = "MMM d"
            return "\(dayFormatter.string(from: date)) at \(timeString)"
        }
    }

    var body: some View {
        HStack(spacing: VSpacing.sm) {
            line
            Text(formattedTime)
                .font(VFont.caption)
                .foregroundColor(VColor.textMuted)
            line
        }
        .padding(.vertical, VSpacing.xs)
    }

    private var line: some View {
        Rectangle()
            .fill(VColor.surfaceBorder.opacity(0.3))
            .frame(height: 0.5)
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

// MARK: - Preview

#if DEBUG
struct ChatView_Preview: PreviewProvider {
    static var previews: some View {
        ChatViewPreviewWrapper()
            .frame(width: 600, height: 500)
            .previewDisplayName("ChatView")
    }
}

private struct ChatViewPreviewWrapper: View {
    @State private var text = ""

    private let sampleMessages: [ChatMessage] = [
        ChatMessage(role: .assistant, text: "Hello! How can I help you today?"),
        ChatMessage(role: .user, text: "Can you tell me about SwiftUI?"),
        ChatMessage(
            role: .assistant,
            text: "SwiftUI is a declarative framework for building user interfaces across Apple platforms. It uses a reactive data-binding model and composable view hierarchy."
        ),
        ChatMessage(role: .user, text: "That sounds great, thanks!"),
    ]

    var body: some View {
        ZStack {
            VColor.background.ignoresSafeArea()
            ChatView(
                messages: sampleMessages,
                inputText: $text,
                hasAPIKey: true,
                isThinking: true,
                isSending: false,
                errorText: nil,
                pendingQueuedCount: 0,
                suggestion: "That sounds great, thanks!",
                pendingAttachments: [],
                isRecording: false,
                onOpenSettings: {},
                onSend: {},
                onStop: {},
                onDismissError: {},
                onAcceptSuggestion: {},
                onAttach: {},
                onRemoveAttachment: { _ in },
                onDropFiles: { _ in },
                onDropImageData: { _, _ in },
                onPaste: {},
                onMicrophoneToggle: {},
                onConfirmationAllow: { _ in },
                onConfirmationDeny: { _ in },
                onAddTrustRule: { _, _, _, _ in true },
                onSurfaceAction: { _, _, _ in },
                onRegenerate: {}
            )
        }
    }
}
#endif
