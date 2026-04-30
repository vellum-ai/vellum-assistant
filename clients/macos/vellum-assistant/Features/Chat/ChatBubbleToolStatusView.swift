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

    /// Extracted thinking content for the progress card when the message has
    /// both inline thinking tags and tool calls. Returns nil when thinking
    /// should not render inside the progress card (no tags, no tool calls,
    /// or feature flag disabled).
    var thinkingContentForProgressCard: String? {
        guard containsInlineThinkingTag(message.text),
              !message.toolCalls.isEmpty,
              MacOSClientFeatureFlagManager.shared.isEnabled("show-thinking-blocks") else {
            return nil
        }
        let chunks = parseInlineThinkingTags(message.text)
        let bodies = chunks.compactMap { chunk -> String? in
            if case .thinking(let body) = chunk { return body }
            return nil
        }
        let joined = bodies.joined(separator: "\n")
        return joined.isEmpty ? nil : joined
    }

    /// Whether thinking content is currently streaming into the progress card.
    /// True when the message is streaming, thinking content exists, and the
    /// last parsed chunk is a `.thinking` case (i.e. we are mid-thought).
    var thinkingIsStreamingForProgressCard: Bool {
        guard message.isStreaming, thinkingContentForProgressCard != nil else { return false }
        let chunks = parseInlineThinkingTags(message.text)
        if case .thinking = chunks.last { return true }
        return false
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
                    thinkingContent: thinkingContentForProgressCard,
                    thinkingIsStreaming: thinkingIsStreamingForProgressCard,
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
