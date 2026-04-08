import os
import os.signpost
import SwiftUI
import VellumAssistantShared

// MARK: - Bubble Max Width Environment

/// The effective maximum width for chat bubble content, accounting for
/// the actual container width. Defaults to the static cap when the
/// container is wide enough.
private struct BubbleMaxWidthKey: EnvironmentKey {
    static let defaultValue: CGFloat = VSpacing.chatBubbleMaxWidth
}

extension EnvironmentValues {
    var bubbleMaxWidth: CGFloat {
        get { self[BubbleMaxWidthKey.self] }
        set { self[BubbleMaxWidthKey.self] = newValue }
    }
}

// MARK: - Chat Bubble

struct ChatBubble: View, Equatable {
    // MARK: - Equatable

    /// Compares only data properties, skipping closures which are never equal by value.
    /// https://airbnb.tech/mobile/understanding-and-improving-swiftui-performance/
    static func == (lhs: ChatBubble, rhs: ChatBubble) -> Bool {
        lhs.message == rhs.message
            && lhs.decidedConfirmation == rhs.decidedConfirmation
            && lhs.dismissedDocumentSurfaceIds == rhs.dismissedDocumentSurfaceIds
            && (lhs.onForkFromMessage != nil) == (rhs.onForkFromMessage != nil)
            && lhs.showInspectButton == rhs.showInspectButton
            && lhs.mediaEmbedSettings == rhs.mediaEmbedSettings
            && lhs.activeConfirmationRequestId == rhs.activeConfirmationRequestId
            && lhs.isLatestAssistantMessage == rhs.isLatestAssistantMessage
            && lhs.typographyGeneration == rhs.typographyGeneration
            && lhs.isProcessingAfterTools == rhs.isProcessingAfterTools
            && lhs.processingStatusText == rhs.processingStatusText
            && lhs.isTTSEnabled == rhs.isTTSEnabled
            && lhs.hideInlineAvatar == rhs.hideInlineAvatar
            && lhs.activeSurfaceId == rhs.activeSurfaceId
    }
    let message: ChatMessage
    /// Decided confirmation from the next message, rendered as a compact chip at the bottom.
    let decidedConfirmation: ToolConfirmationData?
    let onSurfaceAction: (String, String, [String: AnyCodable]?) -> Void
    let onDismissDocumentWidget: (String) -> Void
    let dismissedDocumentSurfaceIds: Set<String>
    var onForkFromMessage: ((String) -> Void)?
    var showInspectButton: Bool = false
    var onInspectMessage: ((String?) -> Void)?
    /// Called when a stripped surface scrolls into view and needs its data re-fetched.
    var onSurfaceRefetch: ((String, String) -> Void)?
    /// Called when expanding a tool call with truncated content to fetch the full text.
    var onRehydrate: (() -> Void)?
    var mediaEmbedSettings: MediaEmbedResolverSettings?
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
    var typographyGeneration: Int = 0
    @State private var avatarBounceScale: CGFloat = 1.0
    /// When true, the assistant is still processing after tool calls completed.
    /// Renders an inline loading indicator in trailingStatus to avoid a separate
    /// standalone thinking row (which would stack a duplicate avatar).
    var isProcessingAfterTools: Bool = false
    /// Status text from the assistant activity state, forwarded for inline display.
    var processingStatusText: String?
    /// Whether the message-tts feature flag is enabled. Passed from the parent.
    var isTTSEnabled: Bool = false
    /// When true, suppress the inline avatar on this bubble because
    /// `thinkingAvatarRow` is rendering one below the thinking indicator.
    var hideInlineAvatar: Bool = false
    /// Owned but never read in this body — only ChatBubbleOverflowMenu reads it,
    /// so hover changes invalidate only the overflow menu, not this view.
    @State private var hoverState = ChatBubbleHoverState()
    /// Raw pointer presence — always updated by onHover regardless of
    /// `supportsOverflowHover`, so we can re-derive hover state when
    /// the property transitions (e.g. streaming ends while cursor is over bubble).
    @State private var pointerIsOverBubble = false
    @Environment(\.bubbleMaxWidth) var bubbleMaxWidth
    /// Stores async-parsed segments for large messages (>500 chars) that missed the
    /// synchronous cache. Keyed by text content so multiple segments can be in flight.
    @State var asyncSegments: [String: [MarkdownSegment]] = [:]

    @State private var mediaEmbedIntents: [MediaEmbedIntent] = []
    // Cached interleaved content state — updated via .onChange(of:) to avoid
    // recomputing O(n) grouping on every body evaluation.
    // Eagerly initialized in init() so the first body evaluation uses the
    // correct layout path instead of flashing through the fallback layout.
    @State var cachedHasInterleavedContent: Bool
    @State var cachedContentGroups: [ContentGroup]
    /// Set of stableIds for tool-call groups that have non-empty text after them.
    @State var cachedToolGroupsWithTrailingText: Set<String>

    /// Interaction state for progress cards that must outlive lazy row churn.
    /// Consolidates step expansion, card expansion overrides, and rehydration
    /// tracking into a single `ProgressCardUIState` value. Lives here (not in
    /// AssistantProgressView) so it survives the trailing→interleaved rendering
    /// path switch that destroys and recreates AssistantProgressView mid-stream.
    @State var progressUIState: ProgressCardUIState = ProgressCardUIState()

    init(
        message: ChatMessage,
        decidedConfirmation: ToolConfirmationData?,
        onSurfaceAction: @escaping (String, String, [String: AnyCodable]?) -> Void,
        onDismissDocumentWidget: @escaping (String) -> Void,
        dismissedDocumentSurfaceIds: Set<String>,
        onForkFromMessage: ((String) -> Void)? = nil,
        showInspectButton: Bool = false,
        isTTSEnabled: Bool = false,
        onInspectMessage: ((String?) -> Void)? = nil,
        onSurfaceRefetch: ((String, String) -> Void)? = nil,
        onRehydrate: (() -> Void)? = nil,
        mediaEmbedSettings: MediaEmbedResolverSettings? = nil,
        onConfirmationAllow: ((String) -> Void)? = nil,
        onConfirmationDeny: ((String) -> Void)? = nil,
        onAlwaysAllow: ((String, String, String, String) -> Void)? = nil,
        onTemporaryAllow: ((String, String) -> Void)? = nil,
        activeConfirmationRequestId: String? = nil,
        onRetryFailedMessage: ((UUID) -> Void)? = nil,
        onRetryConversationError: (() -> Void)? = nil,
        isLatestAssistantMessage: Bool = false,
        typographyGeneration: Int = 0,
        isProcessingAfterTools: Bool = false,
        processingStatusText: String? = nil,
        activeSurfaceId: String? = nil,
        hideInlineAvatar: Bool = false
    ) {
        self.message = message
        self.decidedConfirmation = decidedConfirmation
        self.onSurfaceAction = onSurfaceAction
        self.onDismissDocumentWidget = onDismissDocumentWidget
        self.dismissedDocumentSurfaceIds = dismissedDocumentSurfaceIds
        self.onForkFromMessage = onForkFromMessage
        self.showInspectButton = showInspectButton
        self.isTTSEnabled = isTTSEnabled
        self.onInspectMessage = onInspectMessage
        self.onSurfaceRefetch = onSurfaceRefetch
        self.onRehydrate = onRehydrate
        self.mediaEmbedSettings = mediaEmbedSettings
        self.onConfirmationAllow = onConfirmationAllow
        self.onConfirmationDeny = onConfirmationDeny
        self.onAlwaysAllow = onAlwaysAllow
        self.onTemporaryAllow = onTemporaryAllow
        self.activeConfirmationRequestId = activeConfirmationRequestId
        self.onRetryFailedMessage = onRetryFailedMessage
        self.onRetryConversationError = onRetryConversationError
        self.isLatestAssistantMessage = isLatestAssistantMessage
        self.typographyGeneration = typographyGeneration
        self.isProcessingAfterTools = isProcessingAfterTools
        self.processingStatusText = processingStatusText
        self.activeSurfaceId = activeSurfaceId
        self.hideInlineAvatar = hideInlineAvatar

        // Eagerly compute interleaved content cache so the first body
        // evaluation uses the correct layout path (no flash).
        // Check the static cache first to avoid redundant O(k²) computation
        // for completed messages in old conversations during scroll.
        if let cached = Self.cachedInterleavedResult(for: message) {
            _cachedHasInterleavedContent = State(initialValue: cached.hasInterleaved)
            _cachedContentGroups = State(initialValue: cached.groups)
            _cachedToolGroupsWithTrailingText = State(initialValue: cached.trailingTextIds)
        } else {
            let interleaved = Self.computeHasInterleavedContent(message.contentOrder)
            _cachedHasInterleavedContent = State(initialValue: interleaved)

            if interleaved {
                let groups = Self.computeContentGroupsStatic(
                    contentOrder: message.contentOrder,
                    hasInterleavedContent: interleaved
                )
                _cachedContentGroups = State(initialValue: groups)

                var trailingTextIds = Set<String>()
                for group in groups {
                    guard case .toolCalls(let indices) = group else { continue }
                    if Self.computeHasTextAfterToolGroupStatic(
                        toolIndices: indices,
                        contentOrder: message.contentOrder,
                        textSegments: message.textSegments,
                        hasText: !message.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    ) {
                        trailingTextIds.insert(group.stableId)
                    }
                }
                _cachedToolGroupsWithTrailingText = State(initialValue: trailingTextIds)

                // Store in static cache for future init() calls
                Self.storeInterleavedResult(
                    InterleavedCacheValue(hasInterleaved: interleaved, groups: groups, trailingTextIds: trailingTextIds),
                    for: message
                )
            } else {
                _cachedContentGroups = State(initialValue: [])
                _cachedToolGroupsWithTrailingText = State(initialValue: [])

                // Store non-interleaved result in static cache
                Self.storeInterleavedResult(
                    InterleavedCacheValue(hasInterleaved: false, groups: [], trailingTextIds: []),
                    for: message
                )
            }
        }
    }
    /// Injected from the parent instead of observing the shared singleton directly.
    /// This avoids every ChatBubble in the list re-rendering whenever the overlay
    /// manager publishes any change (the "thundering herd" problem).
    var activeSurfaceId: String?

    var isUser: Bool { message.role == .user }
    var hasCopyableText: Bool {
        !message.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var canForkFromMessage: Bool {
        onForkFromMessage != nil && message.daemonMessageId != nil && !message.isStreaming
    }

    var canInspectMessage: Bool {
        showInspectButton && !isUser && message.daemonMessageId != nil
    }

    var supportsOverflowHover: Bool {
        !message.isStreaming && (hasCopyableText || canInspectMessage || canForkFromMessage)
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
            AnyShapeStyle(VColor.surfaceLift)
        } else if message.isError {
            AnyShapeStyle(VColor.systemNegativeStrong.opacity(0.1))
        } else {
            AnyShapeStyle(Color.clear)
        }
    }

    /// Wraps bubble content with padding, background fill/border, and
    /// width constraints.  Each message type gets only the modifiers it
    /// actually needs — modifiers that would evaluate to no-ops (e.g.
    /// `.padding(EdgeInsets())` or `.frame(maxWidth: nil)`) are omitted
    /// so SwiftUI doesn't create `_PaddingLayout` / `_FlexFrameLayout`
    /// wrappers that still recurse during `sizeThatFits`.
    @ViewBuilder
    func bubbleChrome<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        let isPlainAssistant = !isUser && !message.isError
        if message.isError {
            // ⚠️ Do NOT replace HStack+Spacer with .frame(maxWidth:, alignment:) here.
            // FlexFrame alignment queries recurse through all children — see AGENTS.md.
            HStack(spacing: 0) {
                content()
                    .padding(EdgeInsets(top: VSpacing.md, leading: VSpacing.lg,
                                        bottom: VSpacing.md, trailing: VSpacing.lg))
                Spacer(minLength: 0)
            }
            .background {
                bubbleChromeBackground
            }
        } else if isPlainAssistant {
            // Plain assistant: no chrome padding, no inner frame.
            content()
                .background {
                    bubbleChromeBackground
                }
        } else {
            // User messages (non-error): chrome padding, no inner frame.
            content()
                .padding(EdgeInsets(top: VSpacing.md, leading: VSpacing.lg,
                                    bottom: VSpacing.md, trailing: VSpacing.lg))
                .background {
                    bubbleChromeBackground
                }
        }
    }

    /// Background fill and optional error border shared across all
    /// `bubbleChrome` branches.
    @ViewBuilder
    private var bubbleChromeBackground: some View {
        RoundedRectangle(cornerRadius: VRadius.lg)
            .fill(bubbleFill)
        // Border rendered in the background layer — always present
        // but 0 opacity when not an error/failed message. Avoids
        // an Optional return type which can trigger a SwiftUI AG
        // bug (swift_retain on read-only metadata / SIGBUS).
        RoundedRectangle(cornerRadius: VRadius.lg)
            .strokeBorder(VColor.systemNegativeStrong.opacity(0.3), lineWidth: 1)
            .opacity((message.isError || (isUser && message.status == .sendFailed)) ? 1 : 0)
    }

    /// Surfaces not currently shown in the floating overlay, computed once per body evaluation.
    private var visibleInlineSurfaces: [InlineSurfaceData] {
        message.inlineSurfaces.filter { $0.id != activeSurfaceId }
    }

    /// Whether the text/attachment bubble should be rendered.
    /// Tool calls for assistant messages render outside the bubble as separate chips,
    /// so only show the bubble when there's actual text or attachment content.
    /// Attachment warnings render independently outside the bubble (via
    /// `attachmentWarningBanners`) and must NOT trigger bubble display — otherwise
    /// a warning-only message produces an empty bubble chrome with nothing inside.
    ///
    /// NOTE: When inline surfaces are present, the bubble is intentionally hidden
    /// even if the message also contains text. This is by design — the assistant's
    /// text in these cases is typically a preamble (e.g. "Here's what I built:")
    /// that should not appear above the rendered dynamic UI surface.
    private var shouldShowBubble: Bool {
        if isUser { return true }
        let surfaces = visibleInlineSurfaces
        if !surfaces.isEmpty {
            // Show bubble text when all visible surfaces are completed (collapsed to chips)
            let allCompleted = surfaces.allSatisfy { $0.completionState != nil }
            if !allCompleted { return false }
        }
        return hasText || !message.attachments.isEmpty
    }

    var body: some View {
        #if DEBUG
        let _ = os_signpost(.event, log: PerfSignposts.log, name: "chatBubbleBody",
                            "id=%{public}s streaming=%d", message.id.uuidString, message.isStreaming ? 1 : 0)
        #endif
        // ⚠️ Do NOT replace HStack+Spacer with .frame(maxWidth:, alignment:) here.
        // FlexFrame alignment queries recurse through all children — see AGENTS.md.
        HStack(spacing: 0) {
            if isUser { Spacer(minLength: 0) }
            // Outer VStack ensures a single resolved subview for the parent
            // LazyVStack, avoiding duplicate .id(message.id) from MessageCellView
            // that caused incorrect width proposals at narrow window sizes (LUM-688).
            // The avatar sits outside the inner .compositingGroup() scope so
            // CAShapeLayer animations (breathing, blink, twitch) are unaffected.
            VStack(alignment: isUser ? .trailing : .leading, spacing: VSpacing.sm) {
            // --- Message content (composited) ---
            VStack(alignment: isUser ? .trailing : .leading, spacing: VSpacing.sm) {
                if !isUser && cachedHasInterleavedContent {
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
                    if !visibleInlineSurfaces.isEmpty {
                        ForEach(visibleInlineSurfaces) { surface in
                            InlineSurfaceRouter(surface: surface, onAction: onSurfaceAction, onRefetch: onSurfaceRefetch)
                        }
                    }

                    // Document widget for document_create tool calls
                    if let documentToolCall = message.toolCalls.first(where: { $0.toolName == "document_create" && $0.isComplete }) {
                        documentWidget(for: documentToolCall)
                    }
                }

                if !cachedHasInterleavedContent {
                    attachmentWarningBanners(message.attachmentWarnings)
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

                ChatBubbleOverflowMenu(
                    message: message,
                    hoverState: hoverState,
                    isTTSEnabled: isTTSEnabled,
                    showInspectButton: showInspectButton,
                    onForkFromMessage: onForkFromMessage,
                    onInspectMessage: onInspectMessage
                )
            }
            // Give this content priority so LazyVStack doesn't compress it,
            // which caused trailing tool chips to overlap long text content.
            // Uses layoutPriority instead of fixedSize to avoid forcing
            // full height measurement during lazy placement.
            .layoutPriority(1)
            .compositingGroup()

            // --- Avatar (outside compositing group) ---
            // Placed after the composited content VStack so CAShapeLayer
            // animations on the NSView-backed AnimatedAvatarView are not
            // affected by .compositingGroup() flattening layer effects.
            if isLatestAssistantMessage && !isUser && !hideInlineAvatar {
                inlineAvatar
            }
            }
            if !isUser { Spacer(minLength: 0) }
        }
        .contentShape(Rectangle())
        .onChange(of: message.contentOrder) { _, _ in recomputeInterleavedContentCache() }
        .onChange(of: message.textSegments) { _, _ in recomputeInterleavedContentCache() }
        .onHover { hovering in
            pointerIsOverBubble = hovering
            let shouldHover = hovering && supportsOverflowHover
            if hoverState.isHovered != shouldHover {
                hoverState.isHovered = shouldHover
            }
        }
        .onChange(of: supportsOverflowHover) { _, supports in
            let shouldHover = pointerIsOverBubble && supports
            if hoverState.isHovered != shouldHover {
                hoverState.isHovered = shouldHover
            }
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

    // MARK: - Inline Avatar

    @ViewBuilder
    private var inlineAvatar: some View {
        let appearance = AvatarAppearanceManager.shared
        let avatarSize = ConversationAvatarFollower.avatarSize

        Group {
            if appearance.customAvatarImage != nil {
                VAvatarImage(image: appearance.chatAvatarImage, size: avatarSize)
                    .scaleEffect(avatarBounceScale)
                    .onTapGesture { triggerBounce() }
            } else if let bodyShape = appearance.characterBodyShape,
                      let eyeStyle = appearance.characterEyeStyle,
                      let color = appearance.characterColor {
                AnimatedAvatarView(bodyShape: bodyShape, eyeStyle: eyeStyle, color: color,
                                   size: avatarSize, blinkEnabled: true, pokeEnabled: true,
                                   isStreaming: message.isStreaming)
                    .frame(width: avatarSize, height: avatarSize)
                    .scaleEffect(avatarBounceScale)
                    .onTapGesture { triggerBounce() }
            } else {
                VAvatarImage(image: appearance.chatAvatarImage, size: avatarSize)
                    .scaleEffect(avatarBounceScale)
                    .onTapGesture { triggerBounce() }
            }
        }
        // Ensure the tap-triggered bounce animation is preserved despite the
        // parent LazyVStack's .transaction { $0.animation = nil } suppression.
        .animation(.spring(response: 0.3, dampingFraction: 0.5), value: avatarBounceScale)
    }

    private func triggerBounce() {
        withAnimation(.spring(response: 0.3, dampingFraction: 0.4)) {
            avatarBounceScale = 1.15
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
            withAnimation(.spring(response: 0.3, dampingFraction: 0.5)) {
                avatarBounceScale = 1.0
            }
        }
    }

    // MARK: - Send Failed Indicator

    private var sendFailedIndicator: some View {
        HStack(spacing: VSpacing.xs) {
            VIconView(.triangleAlert, size: 12)
                .foregroundStyle(VColor.systemNegativeStrong)
            Text("Failed to send")
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.systemNegativeStrong)
            ChatEquatableButton(textLabel: "Retry", style: .ghost, size: .inline) {
                onRetryFailedMessage?(message.id)
            }
            .equatable()
        }
        .textSelection(.disabled)
    }

    // MARK: - Bubble Content

    var hasText: Bool {
        !message.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var bubbleContent: some View {
        let partitioned = partitionedAttachments
        return bubbleChrome {
            VStack(alignment: .leading, spacing: VSpacing.sm) {
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
                        isStreaming: message.isStreaming,
                        typographyGeneration: typographyGeneration,
                        maxContentWidth: isUser ? max(bubbleMaxWidth - 2 * VSpacing.lg, 0) : bubbleMaxWidth,
                        textColor: isUser ? VColor.contentDefault : VColor.contentDefault,
                        secondaryTextColor: isUser ? VColor.contentSecondary : VColor.contentSecondary,
                        mutedTextColor: isUser ? VColor.contentSecondary : VColor.contentTertiary,
                        tintColor: isUser ? VColor.contentDefault : VColor.primaryBase,
                        codeTextColor: isUser ? VColor.contentDefault : VColor.systemNegativeStrong,
                        codeBackgroundColor: isUser ? VColor.contentDefault.opacity(0.1) : VColor.surfaceActive,
                        hrColor: isUser ? VColor.contentDefault.opacity(0.3) : VColor.borderBase
                    )
                    .equatable()
                } else if !message.attachments.isEmpty {
                    Text(attachmentSummary)
                        .font(VFont.labelDefault)
                        .foregroundStyle(isUser ? VColor.contentSecondary : VColor.contentSecondary)
                }

                let visibleImages = visibleAttachmentImages(partitioned.images)
                if !visibleImages.isEmpty {
                    attachmentImageGrid(visibleImages)
                }

                if !partitioned.videos.isEmpty {
                    VStack(alignment: .leading, spacing: VSpacing.sm) {
                        ForEach(partitioned.videos) { attachment in
                            InlineVideoAttachmentView(attachment: attachment)
                        }
                    }
                }

                if !partitioned.audios.isEmpty {
                    VStack(alignment: .leading, spacing: VSpacing.sm) {
                        ForEach(partitioned.audios) { attachment in
                            InlineAudioAttachmentView(attachment: attachment)
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
        // NOTE: The per-segment .task(id:) in ChatBubbleTextContent handles
        // async parsing for each individual text segment. A prior whole-message
        // .task(id:) here parsed message.text (all segments joined), but
        // resolveSegments looks up individual segment text — so the whole-message
        // result was cached under a key never queried, producing only a wasted
        // @State update and re-render per message. Removed to eliminate the
        // redundant re-render cycle.
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
    /// instead of blocking the main thread. Set to 500 so that most assistant
    /// messages (routinely 1000+ chars) are parsed off the main thread on cache
    /// miss, reducing scroll jank from synchronous markdown parsing.
    static let asyncParseThreshold = 500

    // MARK: - Segment Cache
    //
    // NSCache handles eviction automatically based on countLimit and
    // totalCostLimit, eliminating the O(n) min(by:) scans of the old
    // hand-rolled LRU dictionary.

    @MainActor static var segmentCache: NSCache<NSString, SegmentCacheEntry> = {
        let cache = NSCache<NSString, SegmentCacheEntry>()
        cache.countLimit = 500
        cache.totalCostLimit = 5_000_000
        return cache
    }()

    // MARK: - Cache Guardrails
    //
    // Prevents a single huge message from consuming disproportionate cache
    // space.  Text over `maxCacheableTextLength` is parsed but never stored.

    static let maxCacheableTextLength = 10_000

    // MARK: - Streaming Dedup Caches
    //
    // During streaming, the segment cache skips storing results to avoid
    // filling up with intermediate text states. However SwiftUI reevaluates
    // view bodies multiple times per token, often with identical text.
    // These single-entry caches hold the last-parsed streaming result so
    // redundant reevaluations return instantly without re-parsing.

    @MainActor static var lastStreamingSegments: (text: String, value: [MarkdownSegment])?

    /// Timestamp of the last streaming markdown parse. Used with
    /// `streamingParseThrottleInterval` to throttle O(n) re-parsing
    /// during streaming of large messages with tables.
    @MainActor static var lastStreamingParseTime: TimeInterval = 0

    /// Streaming text length above which markdown parsing is throttled.
    static let streamingParseThrottleThreshold = 2000

    /// Minimum interval between streaming markdown parses for large text.
    /// 150ms allows ~7 updates/sec — visually smooth while preventing
    /// CPU saturation from synchronous O(n) table parsing on every chunk.
    static let streamingParseThrottleInterval: TimeInterval = 0.15
}

/// NSObject wrapper for `[MarkdownSegment]` to satisfy NSCache's NSObject value requirement.
final class SegmentCacheEntry: NSObject {
    let segments: [MarkdownSegment]
    init(_ segments: [MarkdownSegment]) { self.segments = segments }
}
