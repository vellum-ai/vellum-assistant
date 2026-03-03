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
        /// True when there is at least one tool call that hasn't finished yet.
        let hasActuallyRunningTool = !hideToolCalls && message.toolCalls.contains(where: { !$0.isComplete })
        /// All individual tool calls done but message still streaming (model generating next tool call).
        /// Hide once text is being streamed so the user doesn't see "Thinking" alongside the response.
        let toolsCompleteButStillStreaming = !hideToolCalls && !message.toolCalls.isEmpty
            && message.toolCalls.allSatisfy({ $0.isComplete }) && message.isStreaming && !hasText
        let hasInProgressTools = !message.toolCalls.isEmpty && !hideToolCalls && !allToolCallsComplete
        let hasPermission = decidedConfirmation != nil
        let hasStreamingCode = message.isStreaming && message.streamingCodePreview != nil && !(message.streamingCodePreview?.isEmpty ?? true)

        if hasStreamingCode {
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
            // In progress — show live progress view with completed + running steps
            let current = message.toolCalls.first(where: { !$0.isComplete })!
            if current.toolName == "claude_code" && !current.claudeCodeSteps.isEmpty {
                ClaudeCodeProgressView(steps: current.claudeCodeSteps, isRunning: true)
                    .frame(maxWidth: 520, alignment: .leading)
            } else {
                LiveToolProgressView(toolCalls: message.toolCalls, isRunning: true)
                    .frame(maxWidth: 520, alignment: .leading)
            }
        } else if toolsCompleteButStillStreaming && !permissionWasDenied {
            // All tools done but model is still working (generating next tool call)
            LiveToolProgressView(toolCalls: message.toolCalls, isRunning: true, thinkingLabel: "Thinking")
                .frame(maxWidth: 520, alignment: .leading)
        } else if allToolCallsComplete && !permissionWasDenied && !message.toolCalls.isEmpty {
            // All tools finished successfully — show a compact completed summary with expandable steps.
            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .center, spacing: VSpacing.sm) {
                    UsedToolsList(toolCalls: message.toolCalls, isExpanded: $stepsExpanded)
                    Spacer()
                }
                if stepsExpanded {
                    StepsSection(toolCalls: message.toolCalls, onRehydrate: onRehydrate)
                }
            }
        } else if hasPermission || (hasInProgressTools && permissionWasDenied) {
            // Completed tool steps are hidden — only show permission chip or denied tool chip.
            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .center, spacing: VSpacing.sm) {
                    if hasInProgressTools && permissionWasDenied {
                        compactFailedToolChip
                    }
                    if let confirmation = decidedConfirmation {
                        compactPermissionChip(confirmation)
                    }
                    Spacer()
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
