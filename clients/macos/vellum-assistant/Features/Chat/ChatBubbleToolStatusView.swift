import SwiftUI
import VellumAssistantShared

// MARK: - Tool Status Views

extension ChatBubble {
    /// Whether all tool calls are complete and the message is done streaming.
    var allToolCallsComplete: Bool {
        !message.toolCalls.isEmpty && message.toolCalls.allSatisfy { $0.isComplete } && !message.isStreaming
    }

    /// Whether the permission was denied, meaning incomplete tools were blocked (not running).
    var permissionWasDenied: Bool {
        decidedConfirmation?.state == .denied || decidedConfirmation?.state == .timedOut
            || message.toolCalls.contains { $0.confirmationDecision == .denied || $0.confirmationDecision == .timedOut }
    }

    /// Builds an ordered list of `ProgressExpandedItem`s that folds thinking
    /// content into the progress card alongside tool calls.
    ///
    /// Returns `nil` when no thinking content should be folded — preserving
    /// the default tool-calls-only rendering path in `AssistantProgressView`.
    ///
    /// Two thinking sources are considered:
    /// 1. **Structured `thinkingSegments`** referenced by `contentOrder`
    ///    `.thinking(i)` entries.
    /// 2. **Inline `<thinking>` XML tags** embedded in `message.text`.
    var expandedItemsForProgressCard: [ProgressExpandedItem]? {
        let showThinking = MacOSClientFeatureFlagManager.shared.isEnabled("show-thinking-blocks")
        guard showThinking else { return nil }

        // --- Source 1: Structured thinking segments from contentOrder ---
        let hasStructuredThinking = message.contentOrder.contains { ref in
            if case .thinking = ref { return true }
            return false
        }

        if hasStructuredThinking {
            var items: [ProgressExpandedItem] = []
            let lastThinkingIndex = message.contentOrder.lastIndex { ref in
                if case .thinking = ref { return true }
                return false
            }
            for (orderIdx, ref) in message.contentOrder.enumerated() {
                switch ref {
                case .thinking(let i):
                    guard i < message.thinkingSegments.count else { continue }
                    let content = message.thinkingSegments[i]
                    guard !content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { continue }
                    let key = "\(message.id.uuidString)-th\(i)"
                    let isLast = orderIdx == lastThinkingIndex
                    let hasToolAfter = isLast && message.contentOrder.suffix(from: orderIdx + 1).contains {
                        if case .toolCall = $0 { return true }; return false
                    }
                    let streaming = message.isStreaming && isLast && !hasToolAfter
                    items.append(.thinking(content: content, expansionKey: key, isStreaming: streaming))
                case .toolCall(let i):
                    guard i < message.toolCalls.count else { continue }
                    items.append(.toolCall(message.toolCalls[i]))
                default:
                    break
                }
            }
            // Only return if we actually produced thinking items
            let hasThinkingItems = items.contains { item in
                if case .thinking = item { return true }
                return false
            }
            return hasThinkingItems ? items : nil
        }

        // --- Source 2: Inline <thinking> tags in message.text ---
        guard containsInlineThinkingTag(message.text),
              !message.toolCalls.isEmpty else {
            return nil
        }

        let chunks = parseInlineThinkingTags(message.text)
        let thinkingChunks: [(offset: Int, content: String)] = chunks.enumerated().compactMap { (idx, chunk) in
            if case .thinking(let body) = chunk { return (idx, body) }
            return nil
        }

        guard !thinkingChunks.isEmpty else { return nil }

        var items: [ProgressExpandedItem] = []

        // Determine if the last chunk overall is a thinking chunk (for isStreaming)
        let lastChunkIsThinking: Bool = {
            guard let last = chunks.last else { return false }
            if case .thinking = last { return true }
            return false
        }()

        for (i, tc) in thinkingChunks.enumerated() {
            let key = "\(message.id.uuidString)-th\(i)"
            let isLast = (i == thinkingChunks.count - 1) && lastChunkIsThinking
            items.append(.thinking(content: tc.content, expansionKey: key, isStreaming: message.isStreaming && isLast))
        }

        for toolCall in message.toolCalls {
            items.append(.toolCall(toolCall))
        }

        return items
    }

    @ViewBuilder
    var trailingStatus: some View {
        let inlineToolProgressRenderedInContent = shouldRenderToolProgressInline
        let hasToolCalls = !message.toolCalls.isEmpty
            && !inlineToolProgressRenderedInContent
        let hasStreamingCode = message.isStreaming && message.streamingCodePreview != nil
            && !(message.streamingCodePreview?.isEmpty ?? true)
            && !inlineToolProgressRenderedInContent
        let shouldShowProcessing = isProcessingAfterTools && !inlineToolProgressRenderedInContent

        // Use live confirmations if available, otherwise derive from persisted tool call data
        let effectiveConfirmations: [ToolConfirmationData] = {
            if let live = decidedConfirmation {
                return [live]
            }
            return message.derivedConfirmationsFromToolCalls()
        }()

        if hasToolCalls || hasStreamingCode || shouldShowProcessing {
            // Unified progress view handles all tool/streaming/processing states
            // ⚠️ No .frame(maxWidth:) in LazyVStack cells — see AGENTS.md.
            HStack(spacing: 0) {
                AssistantProgressView(
                    toolCalls: message.toolCalls,
                    isStreaming: message.isStreaming,
                    hasText: hasText,
                    isProcessing: shouldShowProcessing,
                    processingStatusText: shouldShowProcessing ? processingStatusText : nil,
                    streamingCodePreview: message.streamingCodePreview,
                    streamingCodeToolName: message.streamingCodeToolName,
                    decidedConfirmations: effectiveConfirmations,
                    expandedItems: expandedItemsForProgressCard,
                    onRehydrate: onRehydrate,
                    onConfirmationAllow: onConfirmationAllow,
                    onConfirmationDeny: onConfirmationDeny,
                    onAlwaysAllow: onAlwaysAllow,
                    onTemporaryAllow: onTemporaryAllow,
                    activeConfirmationRequestId: activeConfirmationRequestId,
                    progressUIState: $progressUIState,
                    suggestRuleToolCall: $suggestRuleToolCall,
                    suggestRuleSuggestion: $suggestRuleSuggestion
                )
                Spacer(minLength: 0)
            }

            // Inline image previews from completed tool calls (e.g. image generation)
            inlineToolCallImages(from: message.toolCalls)

            // When all tools are complete but the assistant is still streaming
            // without any text content yet, show a typing indicator below the
            // progress card so the user knows content is on the way.
            if message.isStreaming && !hasText
                && !message.toolCalls.isEmpty
                && message.toolCalls.allSatisfy({ $0.isComplete }) {
                HStack(spacing: 0) {
                    TypingIndicatorView()
                    Spacer(minLength: 0)
                }
                .padding(.top, VSpacing.xxs)
                .transition(.opacity)
            }
        } else if !effectiveConfirmations.isEmpty, !inlineToolProgressRenderedInContent {
            // No tool display needed — only show permission chips.
            // ⚠️ No .frame(maxWidth:) in LazyVStack cells — see AGENTS.md.
            HStack(alignment: .center, spacing: VSpacing.sm) {
                ForEach(Array(effectiveConfirmations.enumerated()), id: \.offset) { _, confirmation in
                    compactPermissionChip(confirmation)
                }
                Spacer(minLength: 0)
            }
            .padding(.top, VSpacing.xxs)
        } else if isStreamingContinuation {
            // Assistant is still generating after producing initial text.
            // Show a subtle typing indicator so the user knows more content is coming.
            HStack(spacing: 0) {
                TypingIndicatorView()
                Spacer(minLength: 0)
            }
            .padding(.top, VSpacing.xxs)
            .transition(.opacity)
        }
    }

    /// Maps raw daemon status text to a friendlier label for the inline indicator.
    static func friendlyProcessingLabel(_ statusText: String?) -> String {
        guard let text = statusText else { return "Wrapping up" }
        let lower = text.lowercased()
        if lower.contains("skill") { return "Applying capabilities" }
        if lower.contains("processing") { return "Processing results" }
        return text
    }

    func compactPermissionChip(_ confirmation: ToolConfirmationData) -> some View {
        let isApproved = confirmation.state == .approved
        let isDenied = confirmation.state == .denied
        let chipColor: Color = isApproved ? VColor.primaryBase : isDenied ? VColor.systemNegativeStrong : VColor.contentTertiary

        return HStack(spacing: VSpacing.xs) {
            switch confirmation.state {
            case .approved:
                VIconView(.circleCheck, size: 12)
                    .foregroundStyle(chipColor)
            case .denied:
                VIconView(.circleAlert, size: 12)
                    .foregroundStyle(chipColor)
            case .timedOut:
                VIconView(.clock, size: 12)
                    .foregroundStyle(chipColor)
            default:
                EmptyView()
            }

            Text(isApproved || isDenied ? "\(confirmation.toolCategory)" :
                 "Timed Out")
                .font(VFont.labelDefault)
                .foregroundStyle(chipColor)
        }
        .padding(EdgeInsets(top: VSpacing.xs, leading: VSpacing.sm, bottom: VSpacing.xs, trailing: VSpacing.sm))
        .overlay(
            Capsule().stroke(chipColor.opacity(0.3), lineWidth: 1)
        )
    }
}
