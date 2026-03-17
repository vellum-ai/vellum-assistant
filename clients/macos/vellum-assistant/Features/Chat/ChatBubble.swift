import os
import SwiftUI
import VellumAssistantShared

// MARK: - Chat Bubble

struct ChatBubble: View {
    let message: ChatMessage
    /// Decided confirmation from the next message, rendered as a compact chip at the bottom.
    let decidedConfirmation: ToolConfirmationData?
    let onSurfaceAction: (String, String, [String: AnyCodable]?) -> Void
    let onDismissDocumentWidget: (String) -> Void
    let dismissedDocumentSurfaceIds: Set<String>
    var onReportMessage: ((String?) -> Void)?
    /// Called when a stripped surface scrolls into view and needs its data re-fetched.
    var onSurfaceRefetch: ((String, String) -> Void)?
    /// Called when expanding a tool call with truncated content to fetch the full text.
    var onRehydrate: (() -> Void)?
    var mediaEmbedSettings: MediaEmbedResolverSettings?
    /// Resolves the daemon HTTP port at call time so lazy-loaded video
    /// attachments always use the latest port after daemon restarts.
    var resolveHttpPort: (() -> Int?) = { nil }
    // Confirmation action callbacks (threaded to AssistantProgressView for inline bubbles)
    var onConfirmationAllow: ((String) -> Void)? = nil
    var onConfirmationDeny: ((String) -> Void)? = nil
    var onAlwaysAllow: ((String, String, String, String) -> Void)? = nil
    var onTemporaryAllow: ((String, String) -> Void)? = nil
    var activeConfirmationRequestId: String? = nil
    /// Called when the user taps "Retry" on a failed message.
    var onRetryFailedMessage: ((UUID) -> Void)?
    /// Called when the user taps "Retry" on an inline conversation error.
    var onRetryConversationError: (() -> Void)?

    var isLatestAssistantMessage: Bool = false
    /// When true, the assistant is still processing after tool calls completed.
    /// Renders an inline loading indicator in trailingStatus to avoid a separate
    /// standalone thinking row (which would stack a duplicate avatar).
    var isProcessingAfterTools: Bool = false
    /// Status text from the assistant activity state, forwarded for inline display.
    var processingStatusText: String?
    @State private var isHovered = false
    /// Stores async-parsed segments for large messages (>2000 chars) that missed the
    /// synchronous cache. Keyed by text content so multiple segments can be in flight.
    @State var asyncSegments: [String: [MarkdownSegment]] = [:]

    @State private var showCopyConfirmation = false
    @State private var copyConfirmationTimer: DispatchWorkItem?
    @State private var mediaEmbedIntents: [MediaEmbedIntent] = []
    /// Injected from the parent instead of observing the shared singleton directly.
    /// This avoids every ChatBubble in the list re-rendering whenever the overlay
    /// manager publishes any change (the "thundering herd" problem).
    var activeSurfaceId: String?

    @Environment(\.conversationZoomScale) var conversationZoomScale

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
        hasOverflowActions && !message.isStreaming && (isHovered || showCopyConfirmation)
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
            AnyShapeStyle(VColor.surfaceActive)
        } else if message.isError {
            AnyShapeStyle(VColor.systemNegativeStrong.opacity(0.1))
        } else {
            AnyShapeStyle(Color.clear)
        }
    }

    private var bubbleBorderOverlay: some View {
        // Always produce a non-Optional view type. Using @ViewBuilder with
        // a bare `if` (no else) wraps the result in Optional<StrokeBorderShapeView>.
        // Combined with the simplified textBubble return type (no _ConditionalContent),
        // the Optional variant triggers a SwiftUI attribute graph bug during lazy
        // list layout: the .none payload's undefined bytes get misinterpreted as
        // ARC references, causing swift_retain on read-only metadata (SIGBUS).
        RoundedRectangle(cornerRadius: VRadius.lg)
            .strokeBorder(VColor.systemNegativeStrong.opacity(0.3), lineWidth: 1)
            .opacity((message.isError || (isUser && message.status == .sendFailed)) ? 1 : 0)
    }

    func bubbleChrome<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        let isPlainAssistant = !isUser && !message.isError
        return content()
            .padding(.horizontal, isPlainAssistant ? 0 : VSpacing.lg)
            .padding(.vertical, isPlainAssistant ? 0 : VSpacing.md)
            // Inner frame: let content determine natural width (shrink-wrap for
            // user bubbles). Error messages expand to fill available width.
            .frame(maxWidth: message.isError ? .infinity : nil)
            .background(
                RoundedRectangle(cornerRadius: VRadius.lg)
                    .fill(bubbleFill)
            )
            .overlay {
                bubbleBorderOverlay
            }
            // Outer frame: cap the maximum width and position the bubble.
            .frame(maxWidth: message.isError ? .infinity : VSpacing.chatBubbleMaxWidth, alignment: isUser ? .trailing : .leading)
    }

    private var formattedTimestamp: String {
        let tz = ChatTimestampTimeZone.resolve()
        var calendar = Calendar.current
        calendar.timeZone = tz
        let formatter = DateFormatter()
        formatter.timeZone = tz
        formatter.dateStyle = .none
        formatter.timeStyle = .short
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

    private var detailedTimestamp: String {
        let tz = ChatTimestampTimeZone.resolve()
        let formatter = DateFormatter()
        formatter.timeZone = tz
        formatter.dateStyle = .full
        formatter.timeStyle = .long
        return formatter.string(from: message.timestamp)
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
        let _ = os_signpost(.event, log: PerfSignposts.log, name: "chatBubbleBody",
                            "id=%{public}s streaming=%d", message.id.uuidString, message.isStreaming ? 1 : 0)
        // Outer HStack: Spacer pushes the content group to the correct side.
        HStack(alignment: .top, spacing: 0) {
            if isUser { Spacer(minLength: 0) }

            VStack(alignment: isUser ? .trailing : .leading, spacing: VSpacing.sm) {
                    if !isUser && hasInterleavedContent {
                        interleavedContent
                    } else {
                        if message.isError && hasText {
                            InlineChatErrorAlert(
                                message: message.text,
                                conversationError: message.conversationError,
                                onRetry: onRetryConversationError
                            )
                        } else if shouldShowBubble {
                            bubbleContent
                        }

                        // Inline surfaces render below the bubble as full-width cards
                        // Skip surfaces that are currently shown in the floating overlay
                        if !message.inlineSurfaces.isEmpty {
                            ForEach(message.inlineSurfaces.filter { $0.id != activeSurfaceId }) { surface in
                                InlineSurfaceRouter(surface: surface, onAction: onSurfaceAction, onRefetch: onSurfaceRefetch)
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

                    // Per-message send failure indicator with inline retry button
                    if isUser && message.status == .sendFailed {
                        sendFailedIndicator
                    }

                    // Single unified status area at the bottom of the message:
                    // - In-progress: shows "Running a terminal command ..."
                    // - Complete: shows compact chips ("Ran a terminal command" + "Permission granted")
                    if !isUser {
                        trailingStatus
                    }

                    if hasOverflowActions {
                        overflowMenuButton
                            .opacity(showOverflowMenu ? 1 : 0)
                            .animation(VAnimation.fast, value: showOverflowMenu)
                    }
                }
                // Give this content priority so LazyVStack doesn't compress it,
                // which caused trailing tool chips to overlap long text content.
                // Uses layoutPriority instead of fixedSize to avoid forcing
                // full height measurement during lazy placement.
                .layoutPriority(1)
                // For non-streaming, non-interleaved messages, flatten the render
                // tree into a single compositing layer to reduce layout passes.
                // Skipped during streaming to avoid re-compositing on every token delta.
                // Also skipped for interleaved messages (text + tool calls + images)
                // where the complex view hierarchy makes re-compositing expensive —
                // async task completions (markdown parsing, image decoding) would
                // trigger full re-compositing of the entire message on every change.
                .modifier(ConditionalCompositingGroup(isActive: !message.isStreaming && !hasInterleavedContent))

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

    // MARK: - Send Failed Indicator

    private var sendFailedIndicator: some View {
        HStack(spacing: VSpacing.xs) {
            VIconView(.triangleAlert, size: 12)
                .foregroundColor(VColor.systemNegativeStrong)
            Text("Failed to send")
                .font(VFont.caption)
                .foregroundColor(VColor.systemNegativeStrong)
            Button {
                onRetryFailedMessage?(message.id)
            } label: {
                Text("Retry")
                    .font(VFont.caption.weight(.medium))
                    .foregroundColor(VColor.primaryBase)
            }
            .buttonStyle(.plain)
            .pointerCursor()
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
        HStack(spacing: 2) {
            Text(formattedTimestamp)
                .font(VFont.caption)
                .foregroundColor(VColor.contentTertiary)
                .help(detailedTimestamp)
            if hasCopyableText {
                Button {
                    copyMessageText()
                } label: {
                    VIconView(showCopyConfirmation ? .check : .copy, size: 11)
                        .foregroundColor(showCopyConfirmation ? VColor.systemPositiveStrong : VColor.contentTertiary)
                        .frame(width: 24, height: 24)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .pointerCursor()
                .accessibilityLabel(showCopyConfirmation ? "Copied" : "Copy message")
                .animation(VAnimation.fast, value: showCopyConfirmation)
            }
            if let onReportMessage, !isUser {
                Button {
                    onReportMessage(message.daemonMessageId)
                } label: {
                    VIconView(.bug, size: 11)
                        .foregroundColor(VColor.contentTertiary)
                        .frame(width: 24, height: 24)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .pointerCursor()
                .accessibilityLabel("Report message")
            }
        }
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

                if hasText {
                    let segments = resolveSegments(for: message.text, isStreaming: message.isStreaming)
                    // Always render through MarkdownSegmentView to keep view
                    // identity stable across async segment parsing transitions.
                    // When a large message first renders, resolveSegments returns
                    // [.text(text)] (plain placeholder) before async parsing
                    // completes with rich segments (tables, headings, etc.).
                    // Branching on hasRichContent used to switch between Text and
                    // MarkdownSegmentView — different view types that caused
                    // LazyVStack to use stale height measurements, resulting in
                    // content truncation and footer overlap.
                    MarkdownSegmentView(
                        segments: segments,
                        maxContentWidth: isUser ? nil : VSpacing.chatBubbleMaxWidth,
                        textColor: isUser ? VColor.contentDefault : VColor.contentDefault,
                        secondaryTextColor: isUser ? VColor.contentSecondary : VColor.contentSecondary,
                        mutedTextColor: isUser ? VColor.contentSecondary : VColor.contentTertiary,
                        tintColor: isUser ? VColor.contentDefault : VColor.primaryBase,
                        codeTextColor: isUser ? VColor.contentDefault : VColor.systemNegativeStrong,
                        codeBackgroundColor: isUser ? VColor.contentDefault.opacity(0.1) : VColor.surfaceActive,
                        hrColor: isUser ? VColor.contentDefault.opacity(0.3) : VColor.borderBase
                    )
                } else if !message.attachments.isEmpty {
                    Text(attachmentSummary)
                        .font(VFont.caption)
                        .foregroundColor(isUser ? VColor.contentSecondary : VColor.contentSecondary)
                }

                // Skip image attachments when they all come from tool calls shown inline
                if !partitioned.images.isEmpty && partitioned.images.count != inlineToolCallImageCount {
                    attachmentImageGrid(partitioned.images)
                }

                if !partitioned.videos.isEmpty {
                    VStack(alignment: .leading, spacing: VSpacing.sm) {
                        ForEach(partitioned.videos) { attachment in
                            InlineVideoAttachmentView(attachment: attachment, resolveHttpPort: resolveHttpPort)
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
        .task(id: "\(message.text)|\(message.isStreaming)") {
            // Async-parse large messages that missed the synchronous cache
            let text = message.text
            guard !message.isStreaming,
                  text.count > Self.asyncParseThreshold,
                  Self.segmentCache[text] == nil,
                  asyncSegments[text] == nil else { return }
            let result = await MarkdownParseActor.shared.parse(text)
            guard !Task.isCancelled else { return }
            asyncSegments[text] = result
            // Backfill synchronous cache with guardrails (size limit, byte
            // tracking, eviction) — mirrors the logic in cachedSegments.
            // Re-check cache after await to avoid double-counting bytes when
            // multiple bubbles parse the same text concurrently.
            if text.count <= Self.maxCacheableTextLength,
               Self.segmentCache[text] == nil {
                if Self.segmentCache.count >= Self.maxCacheSize {
                    if let lruKey = Self.segmentCache.min(by: { $0.value.accessTime < $1.value.accessTime })?.key {
                        Self.estimatedCacheBytes -= Self.estimatedBytes(for: lruKey)
                        Self.segmentCache.removeValue(forKey: lruKey)
                    }
                }
                Self.lruCounter += 1
                let cost = Self.estimatedBytes(for: text)
                Self.segmentCache[text] = (result, Self.lruCounter)
                Self.estimatedCacheBytes += cost
                Self.evictIfOverBudget()
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

    /// Length threshold above which a segment cache miss triggers async parsing
    /// instead of blocking the main thread.
    static let asyncParseThreshold = 2000

    // MARK: - LRU Caches
    //
    // Each cache entry stores (value, accessTime) where accessTime is a
    // monotonically increasing counter. On eviction the entry with the
    // lowest accessTime is removed (least-recently-used).

    // UInt64 to avoid silent overflow after billions of cache accesses in long-running sessions.
    @MainActor static var lruCounter: UInt64 = 0

    @MainActor static var segmentCache = [String: (value: [MarkdownSegment], accessTime: UInt64)]()
    static let maxCacheSize = 100

    // MARK: - Cache Guardrails
    //
    // Prevents a single huge message from consuming disproportionate cache
    // space.  Text over `maxCacheableTextLength` is parsed but never stored.
    // `estimatedCacheBytes` tracks a rough byte budget across all three
    // caches; when it exceeds `maxCacheBytes` the oldest entries are evicted.

    static let maxCacheableTextLength = 10_000
    static let maxCacheBytes = 5_000_000
    /// Rough byte estimate of all entries in segmentCache.  Updated on insert/evict.
    @MainActor static var estimatedCacheBytes: Int = 0

    /// Estimate the in-memory cost of caching the given text's parsed result.
    /// Uses `utf8.count * 10` as a conservative estimate: AttributedString carries
    /// significant overhead beyond raw bytes (attribute containers, font metrics,
    /// paragraph style objects), so 3x was too low and allowed the budget to be exceeded.
    static func estimatedBytes(for text: String) -> Int {
        text.utf8.count * 10
    }

    /// Evicts the oldest entries from segmentCache until
    /// `estimatedCacheBytes` drops below `maxCacheBytes`.
    @MainActor static func evictIfOverBudget() {
        while estimatedCacheBytes > maxCacheBytes {
            guard let lruKey = segmentCache.min(by: { $0.value.accessTime < $1.value.accessTime })?.key else { break }
            let cost = estimatedBytes(for: lruKey)
            segmentCache.removeValue(forKey: lruKey)
            estimatedCacheBytes -= cost
        }
    }

    // MARK: - Streaming Dedup Caches
    //
    // During streaming, the LRU caches above skip storing results to avoid
    // filling up with intermediate text states. However SwiftUI reevaluates
    // view bodies multiple times per token, often with identical text.
    // These single-entry caches hold the last-parsed streaming result so
    // redundant reevaluations return instantly without re-parsing.

    @MainActor static var lastStreamingSegments: (text: String, value: [MarkdownSegment])?
}

/// Applies `.compositingGroup()` only when active, to avoid re-compositing during streaming.
private struct ConditionalCompositingGroup: ViewModifier {
    let isActive: Bool

    func body(content: Content) -> some View {
        if isActive {
            content.compositingGroup()
        } else {
            content
        }
    }
}

