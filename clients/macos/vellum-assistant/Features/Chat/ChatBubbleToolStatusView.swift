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
        // When tools are rendered inline (interleaved content), skip the trailing
        // completed-tools pill — they're already visible between text blocks.
        // Still show running indicators, permission chips, and code previews.
        let toolsShownInline = hasInterleavedContent
        let hasCompletedTools = allToolCallsComplete && !hideToolCalls && !message.toolCalls.isEmpty && !toolsShownInline
        /// True when there is at least one tool call that hasn't finished yet.
        /// Always show running tools in trailingStatus (even if interleaved) to guarantee visibility.
        let hasActuallyRunningTool = !hideToolCalls && message.toolCalls.contains(where: { !$0.isComplete })
        /// All individual tool calls done but message still streaming (model generating next tool call).
        /// Hide once text is being streamed so the user doesn't see "Thinking" alongside the response.
        let toolsCompleteButStillStreaming = !hideToolCalls && !message.toolCalls.isEmpty
            && message.toolCalls.allSatisfy({ $0.isComplete }) && message.isStreaming && !hasText
        let hasInProgressTools = !message.toolCalls.isEmpty && !hideToolCalls && !allToolCallsComplete
        let hasPermission = decidedConfirmation != nil
        let hasStreamingCode = message.isStreaming && message.streamingCodePreview != nil && !(message.streamingCodePreview?.isEmpty ?? true)

        // Streaming but nothing visible yet — show a thinking indicator
        let isThinking = message.isStreaming && !hasText && message.toolCalls.isEmpty && !hasStreamingCode

        if isThinking {
            HStack(spacing: VSpacing.sm) {
                ProgressView()
                    .controlSize(.mini)
                    .scaleEffect(0.8)
                    .frame(width: 16, height: 16)

                Text("Thinking")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textSecondary)
                    .lineLimit(1)

                Spacer()
            }
            .padding(.horizontal, VSpacing.lg)
            .padding(.vertical, VSpacing.sm + 2)
            .background(
                RoundedRectangle(cornerRadius: VRadius.lg)
                    .fill(VColor.surface.opacity(0.7))
            )
            .overlay(
                RoundedRectangle(cornerRadius: VRadius.lg)
                    .stroke(VColor.surfaceBorder.opacity(0.6), lineWidth: 0.5)
            )
            .frame(maxWidth: 520, alignment: .leading)
        } else if hasStreamingCode {
            let rawName = message.streamingCodeToolName ?? ""
            let activeBuildingStatus = message.toolCalls.last(where: { !$0.isComplete })?.buildingStatus
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                RunningIndicator(
                    label: Self.friendlyRunningLabel(rawName, buildingStatus: activeBuildingStatus),
                    onTap: nil
                )
                CodePreviewView(code: message.streamingCodePreview!)
            }
            .frame(maxWidth: 520, alignment: .leading)
        } else if hasActuallyRunningTool && !permissionWasDenied {
            // In progress — show each tool call as an inline row (running ones get a spinner)
            let current = message.toolCalls.first(where: { !$0.isComplete })!
            if current.toolName == "claude_code" && !current.claudeCodeSteps.isEmpty {
                ClaudeCodeProgressView(steps: current.claudeCodeSteps, isRunning: true)
                    .frame(maxWidth: 520, alignment: .leading)
            } else {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    ForEach(message.toolCalls, id: \.id) { toolCall in
                        InlineToolCallRow(toolCall: toolCall)
                    }
                }
                .frame(maxWidth: 520, alignment: .leading)
            }
        } else if toolsCompleteButStillStreaming && !permissionWasDenied && !toolsShownInline {
            // All tools done but model is still working — show completed rows
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                ForEach(message.toolCalls, id: \.id) { toolCall in
                    InlineToolCallRow(toolCall: toolCall)
                }
            }
            .frame(maxWidth: 520, alignment: .leading)
        } else if hasCompletedTools || hasPermission || (hasInProgressTools && permissionWasDenied && !toolsShownInline) {
            // All done (or denied) — show inline tool rows + permission chip
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                if hasCompletedTools {
                    ForEach(message.toolCalls, id: \.id) { toolCall in
                        InlineToolCallRow(toolCall: toolCall)
                    }
                } else if hasInProgressTools && permissionWasDenied {
                    compactFailedToolChip
                }
                if let confirmation = decidedConfirmation {
                    HStack {
                        compactPermissionChip(confirmation)
                        Spacer()
                    }
                }
            }
            .padding(.top, VSpacing.xxs)
        }
    }

    /// Failed/denied tool chip — shown when the user denied permission.
    var compactFailedToolChip: some View {
        let uniqueNames = Array(Set(message.toolCalls.map(\.toolName))).sorted()
        let primary = uniqueNames.first ?? "Tool"
        let label = Self.friendlyRunningLabel(primary) + " failed"

        return HStack(spacing: VSpacing.xs) {
            Image(systemName: "xmark.circle.fill")
                .font(.system(size: 12))
                .foregroundColor(VColor.error)

            Text(label)
                .font(VFont.caption)
                .foregroundColor(VColor.textSecondary)
        }
        .padding(.horizontal, VSpacing.md)
        .padding(.vertical, VSpacing.xs)
        .background(
            Capsule().fill(VColor.surface)
        )
        .overlay(
            Capsule().stroke(VColor.surfaceBorder, lineWidth: 0.5)
        )
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
