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
    }

    @ViewBuilder
    var trailingStatus: some View {
        let hasToolCalls = !message.toolCalls.isEmpty && !hideToolCalls
        let hasStreamingCode = message.isStreaming && message.streamingCodePreview != nil
            && !(message.streamingCodePreview?.isEmpty ?? true)

        if hasToolCalls || hasStreamingCode || isProcessingAfterTools {
            // Unified progress view handles all tool/streaming/processing states
            AssistantProgressView(
                toolCalls: hideToolCalls ? [] : message.toolCalls,
                isStreaming: message.isStreaming,
                hasText: hasText,
                isProcessing: isProcessingAfterTools,
                processingStatusText: isProcessingAfterTools ? processingStatusText : nil,
                streamingCodePreview: message.streamingCodePreview,
                streamingCodeToolName: message.streamingCodeToolName,
                decidedConfirmation: decidedConfirmation,
                onRehydrate: onRehydrate
            )
            .frame(maxWidth: 520, alignment: .leading)
        } else if let confirmation = decidedConfirmation {
            // No tool display needed — only show permission chip.
            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .center, spacing: VSpacing.sm) {
                    compactPermissionChip(confirmation)
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
        return HStack(spacing: VSpacing.xs) {
            Group {
                switch confirmation.state {
                case .approved:
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundColor(VColor.success)
                case .denied:
                    Image(systemName: "xmark.circle.fill")
                        .foregroundColor(VColor.error)
                case .timedOut:
                    Image(systemName: "clock.fill")
                        .foregroundColor(VColor.textMuted)
                default:
                    EmptyView()
                }
            }
            .font(.system(size: 12))

            Text(isApproved ? "\(confirmation.toolCategory) allowed" :
                 confirmation.state == .denied ? "\(confirmation.toolCategory) denied" : "Timed out")
                .font(VFont.caption)
                .foregroundColor(isApproved ? VColor.success : VColor.textSecondary)
        }
        .padding(.horizontal, VSpacing.md)
        .padding(.vertical, VSpacing.xs)
        .background(
            Capsule().fill(isApproved ? VColor.success.opacity(0.1) : VColor.surface)
        )
        .overlay(
            Capsule().stroke(isApproved ? VColor.success.opacity(0.3) : VColor.surfaceBorder, lineWidth: 0.5)
        )
    }
}
