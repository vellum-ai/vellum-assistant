import SwiftUI
import VellumAssistantShared

// MARK: - Chat Bubble

struct ChatBubble: View {
    let message: ChatMessage
    /// When true, tool call chips are suppressed because a nearby message has inline surfaces.
    let hideToolCalls: Bool
    /// Decided confirmation from the next message, rendered as a compact chip at the bottom.
    let decidedConfirmation: ToolConfirmationData?
    let onSurfaceAction: (String, String, [String: AnyCodable]?) -> Void
    let onDismissDocumentWidget: (String) -> Void
    let dismissedDocumentSurfaceIds: Set<String>
    var onReportMessage: ((String?) -> Void)?
    var mediaEmbedSettings: MediaEmbedResolverSettings?
    var daemonHttpPort: Int?
    var showAvatar: Bool = true
    var isLatestAssistantMessage: Bool = false

    @State private var appearance = AvatarAppearanceManager.shared
    @State private var isHovered = false

    @State private var showCopyConfirmation = false
    @State private var copyConfirmationTimer: DispatchWorkItem?
    @State private var mediaEmbedIntents: [MediaEmbedIntent] = []
    @State var stepsExpanded = false
    /// Injected from the parent instead of observing the shared singleton directly.
    /// This avoids every ChatBubble in the list re-rendering whenever the overlay
    /// manager publishes any change (the "thundering herd" problem).
    var activeSurfaceId: String?

    var isUser: Bool { message.role == .user }
    private var canReportMessage: Bool {
        !isUser && onReportMessage != nil
    }
    private var hasCopyableText: Bool {
        !message.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
    private var hasOverflowActions: Bool {
        hasCopyableText || canReportMessage
    }
    private var showOverflowMenu: Bool {
        hasOverflowActions && (isHovered || showCopyConfirmation)
    }

    /// Composite identity for the `.task` modifier so it re-runs when either
    /// the message text or the embed settings change.
    /// Returns a stable value while the message is streaming to avoid
    /// cancelling and relaunching the async media embed resolution
    /// (NSDataDetector + regex + HTTP HEAD probes) on every token delta.
    private var mediaEmbedTaskID: String {
        if message.isStreaming { return "streaming-\(message.id)" }
        let s = mediaEmbedSettings
        return "\(message.text)|\(s?.enabled ?? false)|\(s?.enabledSince?.timeIntervalSince1970 ?? 0)|\(s?.allowedDomains ?? [])"
    }

    private var bubbleFill: AnyShapeStyle {
        if isUser {
            AnyShapeStyle(VColor.userBubble)
        } else if message.isError {
            AnyShapeStyle(VColor.error.opacity(0.1))
        } else {
            AnyShapeStyle(Color.clear)
        }
    }

    @ViewBuilder
    private var bubbleBorderOverlay: some View {
        if message.isError {
            RoundedRectangle(cornerRadius: VRadius.lg)
                .strokeBorder(VColor.error.opacity(0.3), lineWidth: 1)
        }
    }

    func bubbleChrome<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        let isPlainAssistant = !isUser && !message.isError
        let overflowOffset: CGFloat = message.isError ? -(24 + VSpacing.sm) : (24 + VSpacing.sm)
        return content()
            .padding(.horizontal, isPlainAssistant ? 0 : VSpacing.lg)
            .padding(.vertical, isPlainAssistant ? 0 : VSpacing.md)
            .frame(maxWidth: message.isError ? .infinity : nil, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: VRadius.lg)
                    .fill(bubbleFill)
            )
            .overlay {
                bubbleBorderOverlay
            }
            .overlay(alignment: isUser ? .topLeading : .topTrailing) {
                if hasOverflowActions {
                    overflowMenuButton
                        .opacity(showOverflowMenu ? 1 : 0)
                        .animation(VAnimation.fast, value: showOverflowMenu)
                        .offset(x: isUser ? -(24 + VSpacing.sm) : overflowOffset)
                }
            }
            .frame(maxWidth: message.isError ? .infinity : 520, alignment: isUser ? .trailing : .leading)
    }

    private var formattedTimestamp: String {
        let tz = ChatTimestampTimeZone.resolve()
        var calendar = Calendar.current
        calendar.timeZone = tz
        let formatter = DateFormatter()
        formatter.timeZone = tz
        formatter.dateFormat = "H:mm"
        let timeString = formatter.string(from: message.timestamp)
        if calendar.isDateInToday(message.timestamp) {
            return "Today, \(timeString)"
        } else {
            let dayFormatter = DateFormatter()
            dayFormatter.timeZone = tz
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
        // Filter out the surface shown in the floating overlay
        let visibleSurfaces = message.inlineSurfaces.filter { $0.id != activeSurfaceId }
        if !visibleSurfaces.isEmpty {
            // Show bubble text when all visible surfaces are completed (collapsed to chips)
            let allCompleted = visibleSurfaces.allSatisfy { $0.completionState != nil }
            if !allCompleted { return false }
        }
        return hasText || !message.attachments.isEmpty
    }

    var body: some View {
        // Outer HStack: Spacer pushes the content group to the correct side.
        HStack(alignment: .top, spacing: 0) {
            if isUser { Spacer(minLength: 0) }

            // Content group with absolutely-positioned avatar so text alignment
            // stays consistent whether or not the avatar is visible.
            // Assistant messages reserve left space (28pt avatar + 8pt gap) for the overlay avatar.
            VStack(alignment: isUser ? .trailing : .leading, spacing: VSpacing.sm) {
                    if !isUser && hasInterleavedContent {
                        interleavedContent
                    } else {
                        if shouldShowBubble {
                            bubbleContent
                        }

                        // Inline surfaces render below the bubble as full-width cards
                        // Skip surfaces that are currently shown in the floating overlay
                        if !message.inlineSurfaces.isEmpty {
                            ForEach(message.inlineSurfaces.filter { $0.id != activeSurfaceId }) { surface in
                                InlineSurfaceRouter(surface: surface, onAction: onSurfaceAction)
                            }
                        }

                        // Document widget for document_create tool calls
                        if let documentToolCall = message.toolCalls.first(where: { $0.toolName == "document_create" && $0.isComplete }) {
                            documentWidget(for: documentToolCall)
                        }
                    }

                    // Media embeds rendered below the text, preserving source order
                    ForEach(mediaEmbedIntents.indices, id: \.self) { idx in
                        switch mediaEmbedIntents[idx] {
                        case .image(let url):
                            InlineImageEmbedView(url: url)
                        case .video(let provider, let videoID, let embedURL):
                            InlineVideoEmbedCard(provider: provider, videoID: videoID, embedURL: embedURL)
                        }
                    }

                    // Single unified status area at the bottom of the message:
                    // - In-progress: shows "Running a terminal command ..."
                    // - Complete: shows compact chips ("Ran a terminal command" + "Permission granted")
                    if !isUser {
                        trailingStatus
                    }
                }
                // Prevent LazyVStack from compressing the bubble height, which causes the
                // trailing tool-chip to overlap long text content.
                .fixedSize(horizontal: false, vertical: true)
                .contextMenu {}
                .overlay(alignment: .topTrailing) {
                    if !isUser && !shouldShowBubble && !hasInterleavedContent && hasOverflowActions {
                        overflowMenuButton
                            .opacity(showOverflowMenu ? 1 : 0)
                            .animation(VAnimation.fast, value: showOverflowMenu)
                            .offset(x: 24 + VSpacing.sm)
                    }
                }
                .overlay(alignment: .topLeading) {
                    if !isUser && showAvatar {
                        Image(nsImage: appearance.chatAvatarImage)
                            .interpolation(.none)
                            .resizable()
                            .aspectRatio(contentMode: .fill)
                            .frame(width: 28, height: 28)
                            .clipShape(Circle())
                            .offset(x: -(28 + VSpacing.sm), y: 2)
                    }
                }
                .padding(.leading, isUser ? 0 : 28 + VSpacing.sm)

            if !isUser { Spacer(minLength: 0) }
        }
        .contentShape(Rectangle())
        .onHover { hovering in
            isHovered = hovering
        }
        .task(id: mediaEmbedTaskID) {
            guard !message.isStreaming else { return }
            guard let settings = mediaEmbedSettings else {
                mediaEmbedIntents = []
                return
            }
            let resolved = await MediaEmbedResolver.resolve(message: message, settings: settings)
            guard !Task.isCancelled else { return }
            mediaEmbedIntents = resolved
        }
    }

    // MARK: - Overflow Menu

    private func copyMessageText() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(message.text, forType: .string)
        copyConfirmationTimer?.cancel()
        showCopyConfirmation = true
        let timer = DispatchWorkItem { showCopyConfirmation = false }
        copyConfirmationTimer = timer
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5, execute: timer)
    }

    private var overflowMenuButton: some View {
        Menu {
            if hasCopyableText {
                Button("Copy message") {
                    copyMessageText()
                }
            }
            if let onReportMessage, !isUser {
                Button("Export response for diagnostics") {
                    onReportMessage(message.daemonMessageId)
                }
            }
        } label: {
            Image(systemName: showCopyConfirmation ? "checkmark" : "ellipsis")
                .font(.system(size: 11, weight: .medium))
                .foregroundColor(showCopyConfirmation ? VColor.success : VColor.textMuted)
                .frame(width: 24, height: 24)
                .contentShape(Rectangle())
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .tint(showCopyConfirmation ? VColor.success : VColor.textMuted)
        .frame(width: 24, height: 24)
        .accessibilityLabel("Message actions")
        .animation(VAnimation.fast, value: showCopyConfirmation)
    }

    // MARK: - Bubble Content

    var hasText: Bool {
        !message.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var bubbleContent: some View {
        let partitioned = partitionedAttachments
        return bubbleChrome {
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                if let skillInvocation = message.skillInvocation {
                    SkillInvocationChip(data: skillInvocation)
                }

                if message.isError && hasText {
                    HStack(alignment: .top, spacing: VSpacing.sm) {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .font(.system(size: 13, weight: .medium))
                            .foregroundColor(VColor.error)
                            .padding(.top, 1)
                        Text(message.text)
                            .font(.system(size: 13))
                            .foregroundColor(VColor.textPrimary)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                } else if hasText {
                    let segments = Self.cachedSegments(for: message.text)
                    let hasRichContent = segments.contains(where: {
                        switch $0 {
                        case .table, .image, .heading, .codeBlock, .horizontalRule, .list: return true
                        case .text: return false
                        }
                    })
                    if hasRichContent {
                        MarkdownSegmentView(
                            segments: segments,
                            maxContentWidth: nil,
                            textColor: isUser ? VColor.userBubbleText : VColor.textPrimary,
                            secondaryTextColor: isUser ? VColor.userBubbleTextSecondary : VColor.textSecondary,
                            mutedTextColor: isUser ? VColor.userBubbleTextSecondary : VColor.textMuted,
                            tintColor: isUser ? VColor.userBubbleText : VColor.accent,
                            codeBackgroundColor: isUser ? VColor.userBubbleText.opacity(0.1) : VColor.backgroundSubtle,
                            hrColor: isUser ? VColor.userBubbleText.opacity(0.3) : VColor.surfaceBorder
                        )
                    } else {
                        Text(markdownText)
                            .font(.system(size: 13))
                            .foregroundColor(isUser ? VColor.userBubbleText : VColor.textPrimary)
                            .tint(isUser ? VColor.userBubbleText : VColor.accent)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                } else if !message.attachments.isEmpty {
                    Text(attachmentSummary)
                        .font(VFont.caption)
                        .foregroundColor(isUser ? VColor.userBubbleTextSecondary : VColor.textSecondary)
                }

                if !partitioned.images.isEmpty {
                    attachmentImageGrid(partitioned.images)
                }

                if !partitioned.videos.isEmpty {
                    VStack(alignment: .leading, spacing: VSpacing.sm) {
                        ForEach(partitioned.videos) { attachment in
                            InlineVideoAttachmentView(attachment: attachment, daemonHttpPort: daemonHttpPort)
                        }
                    }
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
        }
    }

    // MARK: - Document Widget

    @ViewBuilder
    private func documentWidget(for toolCall: ToolCallData) -> some View {
        let parsed = DocumentResultParser.parse(from: toolCall)

        if let surfaceId = parsed.surfaceId, !dismissedDocumentSurfaceIds.contains(surfaceId) {
            DocumentReopenWidget(
                documentTitle: parsed.title,
                onReopen: {
                    NotificationCenter.default.post(
                        name: .openDocumentEditor,
                        object: nil,
                        userInfo: ["documentSurfaceId": surfaceId]
                    )
                },
                onDismiss: {
                    onDismissDocumentWidget(surfaceId)
                }
            )
            .padding(.top, VSpacing.sm)
        }
    }

    // MARK: - Caches

    @MainActor static var segmentCache = [String: [MarkdownSegment]]()
    @MainActor static var markdownCache = [String: AttributedString]()
    /// Separate cache for inline markdown (used by interleaved text segments).
    /// Kept distinct from `markdownCache` because `markdownText` applies
    /// slash-command highlighting before caching, which would contaminate
    /// inline results (and vice versa) if they shared a dictionary.
    @MainActor static var inlineMarkdownCache = [String: AttributedString]()
    static let maxCacheSize = 100
}
