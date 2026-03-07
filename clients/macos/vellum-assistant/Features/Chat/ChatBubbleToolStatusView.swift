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
            AssistantProgressView(
                toolCalls: message.toolCalls,
                isStreaming: message.isStreaming,
                hasText: hasText,
                isProcessing: shouldShowProcessing,
                processingStatusText: shouldShowProcessing ? processingStatusText : nil,
                streamingCodePreview: message.streamingCodePreview,
                streamingCodeToolName: message.streamingCodeToolName,
                decidedConfirmations: effectiveConfirmations,
                onRehydrate: onRehydrate
            )
            .frame(maxWidth: 520, alignment: .leading)
        } else if !effectiveConfirmations.isEmpty, !inlineToolProgressRenderedInContent {
            // No tool display needed — only show permission chips.
            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .center, spacing: VSpacing.sm) {
                    ForEach(Array(effectiveConfirmations.enumerated()), id: \.offset) { _, confirmation in
                        compactPermissionChip(confirmation)
                    }
                    Spacer()
                }
            }
            .padding(.top, VSpacing.xxs)
        }
    }

    /// Maps raw daemon status text to a friendlier label for the inline indicator.
    static func friendlyProcessingLabel(_ statusText: String?) -> String {
        guard let text = statusText else { return "Thinking" }
        let lower = text.lowercased()
        if lower.contains("skill") { return "Applying capabilities" }
        if lower.contains("processing") { return "Processing results" }
        return text
    }

    func compactPermissionChip(_ confirmation: ToolConfirmationData) -> some View {
        let isApproved = confirmation.state == .approved
        let isDenied = confirmation.state == .denied
        let chipColor: Color = isApproved ? VColor.iconAccent : isDenied ? VColor.error : VColor.textMuted

        return HStack(spacing: VSpacing.xs) {
            Group {
                switch confirmation.state {
                case .approved:
                    VIconView(.circleCheck, size: 12)
                        .foregroundColor(chipColor)
                case .denied:
                    VIconView(.circleAlert, size: 12)
                        .foregroundColor(chipColor)
                case .timedOut:
                    VIconView(.clock, size: 12)
                        .foregroundColor(chipColor)
                default:
                    EmptyView()
                }
            }

            Text(isApproved ? "\(confirmation.toolCategory) Allowed" :
                 isDenied ? "\(confirmation.toolCategory) Denied" : "Timed Out")
                .font(VFont.captionMedium)
                .foregroundColor(chipColor)
        }
        .padding(.horizontal, VSpacing.sm)
        .padding(.vertical, VSpacing.xs)
        .background(
            Capsule().fill(Color.clear)
        )
        .overlay(
            Capsule().stroke(chipColor.opacity(0.3), lineWidth: 1)
        )
    }
}
