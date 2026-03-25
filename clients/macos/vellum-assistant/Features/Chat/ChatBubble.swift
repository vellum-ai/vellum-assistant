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
    @State private var avatarBounceScale: CGFloat = 1.0
    /// When true, the assistant is still processing after tool calls completed.
    /// Renders an inline loading indicator in trailingStatus to avoid a separate
    /// standalone thinking row (which would stack a duplicate avatar).
    var isProcessingAfterTools: Bool = false
    /// Status text from the assistant activity state, forwarded for inline display.
    var processingStatusText: String?
    /// Whether the message-tts feature flag is enabled. Passed from the parent.
    var isTTSEnabled: Bool = false
    /// When true, hide the inline avatar (e.g. thinking indicator is showing it instead).
    var hideInlineAvatar: Bool = false
    @State private var audioPlayer = MessageAudioPlayer()
    @State private var isHovered = false
    /// Stores async-parsed segments for large messages (>500 chars) that missed the
    /// synchronous cache. Keyed by text content so multiple segments can be in flight.
    @State var asyncSegments: [String: [MarkdownSegment]] = [:]

    @State private var showCopyConfirmation = false
    @State private var showTTSSetupPopover = false
    @State private var copyConfirmationTimer: DispatchWorkItem?
    @State private var mediaEmbedIntents: [MediaEmbedIntent] = []
    // Cached interleaved content state — updated via .onChange(of:) to avoid
    // recomputing O(n) grouping on every body evaluation.
    // Eagerly initialized in init() to prevent first-frame flash where the
    // wrong layout path renders before .onAppear fires.
    @State var cachedHasInterleavedContent: Bool
    @State var cachedContentGroups: [ContentGroup]
    /// Set of stableIds for tool-call groups that have non-empty text after them.
    @State var cachedToolGroupsWithTrailingText: Set<String>

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
    private var hasCopyableText: Bool {
        !message.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
    private var canInspectMessage: Bool {
        showInspectButton && !isUser && message.daemonMessageId != nil
    }
    var canForkFromMessage: Bool {
        onForkFromMessage != nil && message.daemonMessageId != nil && !message.isStreaming
    }
    private var hasOverflowActions: Bool {
        hasCopyableText || canInspectMessage || canForkFromMessage
    }
    private var showOverflowMenu: Bool {
        hasOverflowActions && !message.isStreaming && (isHovered || showCopyConfirmation || audioPlayer.isPlaying || audioPlayer.isLoading || showTTSSetupPopover)
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

    private static let timeFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = .autoupdatingCurrent
        f.dateStyle = .none
        f.timeStyle = .short
        return f
    }()

    private static let dayFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = .autoupdatingCurrent
        f.dateFormat = "MMM d"
        return f
    }()

    private static let detailedFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = .autoupdatingCurrent
        f.dateStyle = .full
        f.timeStyle = .long
        return f
    }()

    private var formattedTimestamp: String {
        let tz = ChatTimestampTimeZone.resolve()
        var calendar = Calendar.current
        calendar.timeZone = tz
        Self.timeFormatter.timeZone = tz
        let timeString = Self.timeFormatter.string(from: message.timestamp)
        if calendar.isDateInToday(message.timestamp) {
            return "Today, \(timeString)"
        } else {
            Self.dayFormatter.timeZone = tz
            return "\(Self.dayFormatter.string(from: message.timestamp)), \(timeString)"
        }
    }

    private var detailedTimestamp: String {
        let tz = ChatTimestampTimeZone.resolve()
        Self.detailedFormatter.timeZone = tz
        return Self.detailedFormatter.string(from: message.timestamp)
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
        let _ = os_signpost(.event, log: PerfSignposts.log, name: "chatBubbleBody",
                            "id=%{public}s streaming=%d", message.id.uuidString, message.isStreaming ? 1 : 0)
        // Outer HStack: Spacer pushes the content group to the correct side.
        HStack(alignment: .top, spacing: 0) {
            if isUser { Spacer(minLength: 0) }

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
                .modifier(ConditionalCompositingGroup(isActive: !message.isStreaming && !cachedHasInterleavedContent))

            if !isUser { Spacer(minLength: 0) }
        }
        .contentShape(Rectangle())
        .onAppear { recomputeInterleavedContentCache() }
        .onChange(of: message.contentOrder) { _, _ in recomputeInterleavedContentCache() }
        .onChange(of: message.textSegments) { _, _ in recomputeInterleavedContentCache() }
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

        // Avatar below the latest assistant message, left-aligned
        if isLatestAssistantMessage && !isUser && !hideInlineAvatar {
            HStack {
                inlineAvatar
                Spacer()
            }
            .padding(.top, VSpacing.sm)
        }
    }

    // MARK: - Inline Avatar

    @ViewBuilder
    private var inlineAvatar: some View {
        let appearance = AvatarAppearanceManager.shared
        let avatarSize = ConversationAvatarFollower.avatarSize

        if appearance.customAvatarImage != nil {
            VAvatarImage(image: appearance.chatAvatarImage, size: avatarSize)
                .scaleEffect(avatarBounceScale)
                .onTapGesture { triggerBounce() }
        } else if let bodyShape = appearance.characterBodyShape,
                  let eyeStyle = appearance.characterEyeStyle,
                  let color = appearance.characterColor {
            AnimatedAvatarView(bodyShape: bodyShape, eyeStyle: eyeStyle, color: color,
                               size: avatarSize, blinkEnabled: true, pokeEnabled: true)
                .frame(width: avatarSize, height: avatarSize)
                .modifier(AvatarWiggleModifier(isActive: message.isStreaming))
                .scaleEffect(avatarBounceScale)
                .onTapGesture { triggerBounce() }
        } else {
            VAvatarImage(image: appearance.chatAvatarImage, size: avatarSize)
                .scaleEffect(avatarBounceScale)
                .onTapGesture { triggerBounce() }
        }
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
            VButton(label: "Retry", style: .ghost, size: .inline) {
                onRetryFailedMessage?(message.id)
            }
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
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentTertiary)
                .help(detailedTimestamp)
            if hasCopyableText {
                VButton(
                    label: showCopyConfirmation ? "Copied" : "Copy message",
                    iconOnly: (showCopyConfirmation ? VIcon.check : VIcon.copy).rawValue,
                    style: .ghost,
                    iconSize: 24,
                    iconColor: showCopyConfirmation ? VColor.systemPositiveStrong : VColor.contentTertiary
                ) {
                    copyMessageText()
                }
                .vTooltip(showCopyConfirmation ? "Copied" : "Copy", edge: .bottom)
                .animation(VAnimation.fast, value: showCopyConfirmation)
            }
            if !isUser && hasCopyableText && isTTSEnabled && message.daemonMessageId != nil {
                ttsButton
            }
            if let onForkFromMessage, let daemonMessageId = message.daemonMessageId, !message.isStreaming {
                VButton(
                    label: "Fork from here",
                    iconOnly: VIcon.gitBranch.rawValue,
                    style: .ghost,
                    iconSize: 24,
                    iconColor: VColor.contentTertiary
                ) {
                    onForkFromMessage(daemonMessageId)
                }
                .vTooltip("Fork from here", edge: .bottom)
            }
            if showInspectButton, !isUser, let daemonMsgId = message.daemonMessageId {
                VButton(
                    label: "Inspect LLM context",
                    iconOnly: VIcon.fileCode.rawValue,
                    style: .ghost,
                    iconSize: 24,
                    iconColor: VColor.contentTertiary
                ) {
                    onInspectMessage?(daemonMsgId)
                }
                .vTooltip("Inspect", edge: .bottom)
            }
        }
    }

    // MARK: - TTS Button

    @ViewBuilder
    private var ttsButton: some View {
        if audioPlayer.isLoading {
            ProgressView()
                .controlSize(.small)
                .frame(width: 24, height: 24)
                .tint(VColor.contentTertiary)
        } else if audioPlayer.isPlaying {
            VButton(
                label: "Stop audio",
                iconOnly: VIcon.square.rawValue,
                style: .ghost,
                iconSize: 24,
                iconColor: VColor.systemPositiveStrong
            ) {
                audioPlayer.stop()
            }
        } else if let daemonMessageId = message.daemonMessageId {
            ttsIdleButton(daemonMessageId: daemonMessageId)
        }
    }

    @ViewBuilder
    private func ttsIdleButton(daemonMessageId: String) -> some View {
        let button = VButton(
            label: "Play as audio",
            iconOnly: VIcon.volume2.rawValue,
            style: .ghost,
            iconSize: 24,
            iconColor: audioPlayer.error != nil ? VColor.systemNegativeStrong : VColor.contentTertiary
        ) {
            Task {
                await audioPlayer.playMessage(
                    messageId: daemonMessageId,
                    conversationId: nil
                )
                if audioPlayer.isNotConfigured {
                    showTTSSetupPopover = true
                }
            }
        }

        if audioPlayer.isNotConfigured {
            button
                .popover(isPresented: $showTTSSetupPopover, arrowEdge: .bottom) {
                    ttsSetupPopoverContent
                }
        } else if audioPlayer.isFeatureDisabled {
            button
                .vTooltip("Text-to-speech is not enabled", edge: .bottom)
        } else {
            button
                .vTooltip("Read aloud", edge: .bottom)
        }
    }

    private var ttsSetupPopoverContent: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text("Read aloud isn't set up yet")
                .font(VFont.titleSmall)
                .foregroundStyle(VColor.contentEmphasized)
            Text("Connect a Fish Audio voice to hear messages spoken aloud.")
                .font(VFont.bodyMediumDefault)
                .foregroundStyle(VColor.contentSecondary)
            HStack(spacing: VSpacing.md) {
                VButton(label: "Set Up", style: .primary) {
                    showTTSSetupPopover = false
                    AppDelegate.shared?.showSettingsTab("Voice")
                }
                Button {
                    if let url = URL(string: "https://fish.audio") {
                        NSWorkspace.shared.open(url)
                    }
                } label: {
                    Text("Learn more")
                        .underline()
                        .font(VFont.bodyMediumLighter)
                        .foregroundStyle(VColor.primaryBase)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(VSpacing.lg)
        .frame(maxWidth: 280)
        .background(VColor.surfaceOverlay)
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
                        isStreaming: message.isStreaming,
                        maxContentWidth: isUser ? nil : VSpacing.chatBubbleMaxWidth,
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
        .task(id: "\(message.text)|\(message.isStreaming)") {
            // Async-parse large messages that missed the synchronous cache
            let text = message.text
            guard !message.isStreaming,
                  text.count > Self.asyncParseThreshold,
                  Self.segmentCache.object(forKey: text as NSString) == nil,
                  asyncSegments[text] == nil else { return }
            let result = await MarkdownParseActor.shared.parse(text)
            guard !Task.isCancelled else { return }
            asyncSegments[text] = result
            // Backfill synchronous cache with cost tracking.
            // Re-check cache after await to avoid double-inserting when
            // multiple bubbles parse the same text concurrently.
            if text.count <= Self.maxCacheableTextLength,
               Self.segmentCache.object(forKey: text as NSString) == nil {
                Self.segmentCache.setObject(
                    SegmentCacheEntry(result),
                    forKey: text as NSString,
                    cost: text.utf8.count * 10
                )
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
}

/// NSObject wrapper for `[MarkdownSegment]` to satisfy NSCache's NSObject value requirement.
final class SegmentCacheEntry: NSObject {
    let segments: [MarkdownSegment]
    init(_ segments: [MarkdownSegment]) { self.segments = segments }
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

// MARK: - Avatar Wiggle Modifier

/// Applies a gentle wiggle animation (rotation + scale breathing) while active,
/// signaling the assistant is streaming/thinking.
struct AvatarWiggleModifier: ViewModifier {
    let isActive: Bool

    @State private var wiggleAngle: Double = 0
    @State private var breathScale: CGFloat = 1.0

    func body(content: Content) -> some View {
        content
            .rotationEffect(.degrees(wiggleAngle))
            .scaleEffect(breathScale)
            .onChange(of: isActive) {
                if isActive {
                    startWiggle()
                } else {
                    stopWiggle()
                }
            }
            .onAppear {
                if isActive {
                    startWiggle()
                }
            }
    }

    private func startWiggle() {
        withAnimation(.easeInOut(duration: 0.8).repeatForever(autoreverses: true)) {
            wiggleAngle = 3
        }
        withAnimation(.easeInOut(duration: 1.2).repeatForever(autoreverses: true)) {
            breathScale = 1.03
        }
    }

    private func stopWiggle() {
        withAnimation(.easeOut(duration: 0.3)) {
            wiggleAngle = 0
            breathScale = 1.0
        }
    }
}
