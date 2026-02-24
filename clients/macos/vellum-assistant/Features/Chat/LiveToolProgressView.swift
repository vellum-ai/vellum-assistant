import SwiftUI
import VellumAssistantShared

/// Shows real-time progress of tool calls within a single assistant message.
/// Completed tool calls appear with checkmarks; the currently running tool shows
/// a pulsing indicator. Mirrors the style of `ClaudeCodeProgressView`.
struct LiveToolProgressView: View {
    let toolCalls: [ToolCallData]
    let isRunning: Bool
    /// When set, shown as the header label instead of the current tool's running label.
    /// Used for the "all tools done but still streaming" state.
    var thinkingLabel: String? = nil

    @State private var isExpanded: Bool = true
    @State private var userHasToggled: Bool = false

    private var currentCall: ToolCallData? {
        toolCalls.first(where: { !$0.isComplete })
    }

    private var headerLabel: String {
        if let thinkingLabel { return thinkingLabel }
        if isRunning, let current = currentCall {
            return ChatBubble.friendlyRunningLabel(
                current.toolName,
                inputSummary: current.inputSummary,
                buildingStatus: current.buildingStatus
            )
        }
        return "Completed \(toolCalls.count) step\(toolCalls.count == 1 ? "" : "s")"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header button
            Button(action: {
                withAnimation(VAnimation.fast) {
                    isExpanded.toggle()
                    userHasToggled = true
                }
            }) {
                HStack(spacing: VSpacing.sm) {
                    if isRunning {
                        Circle()
                            .fill(VColor.accent)
                            .frame(width: 8, height: 8)
                            .modifier(LiveToolPulsingModifier())
                    } else {
                        Image(systemName: "checkmark.circle.fill")
                            .font(.system(size: 12))
                            .foregroundColor(VColor.success)
                    }

                    Text(headerLabel)
                        .font(VFont.caption)
                        .foregroundColor(VColor.textSecondary)

                    Spacer()

                    Image(systemName: "chevron.right")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundColor(VColor.textMuted)
                        .rotationEffect(.degrees(isExpanded ? 90 : 0))
                }
            }
            .buttonStyle(.plain)
            .padding(.horizontal, VSpacing.sm)
            .padding(.vertical, VSpacing.xs)

            // Expanded step list
            if isExpanded {
                VStack(alignment: .leading, spacing: VSpacing.xxs) {
                    ForEach(toolCalls) { toolCall in
                        HStack(spacing: VSpacing.sm) {
                            if toolCall.isComplete {
                                Image(systemName: toolCall.isError ? "xmark.circle.fill" : "checkmark.circle.fill")
                                    .font(.system(size: 10))
                                    .foregroundColor(toolCall.isError ? VColor.error : VColor.success)
                                    .frame(width: 14)
                            } else {
                                Circle()
                                    .fill(VColor.accent)
                                    .frame(width: 6, height: 6)
                                    .modifier(LiveToolPulsingModifier())
                                    .frame(width: 14)
                            }

                            if toolCall.isComplete {
                                Text(toolCall.actionDescription)
                                    .font(VFont.captionMedium)
                                    .foregroundColor(toolCall.isError ? VColor.error : VColor.textSecondary)
                                    .lineLimit(1)
                                    .truncationMode(.tail)
                            } else {
                                Text(ChatBubble.friendlyRunningLabel(
                                    toolCall.toolName,
                                    inputSummary: toolCall.inputSummary,
                                    buildingStatus: toolCall.buildingStatus
                                ))
                                    .font(VFont.captionMedium)
                                    .foregroundColor(VColor.textSecondary)
                                    .lineLimit(1)
                                    .truncationMode(.tail)
                            }

                            Spacer()
                        }
                        .padding(.horizontal, VSpacing.sm)
                        .padding(.vertical, VSpacing.xxs)
                    }
                }
                .padding(.bottom, VSpacing.xs)
            }
        }
        .background(VColor.surface.opacity(0.5))
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
        .onChange(of: isRunning) { _, newValue in
            if !newValue && !userHasToggled {
                withAnimation(VAnimation.fast) {
                    isExpanded = false
                }
            }
        }
    }
}

private struct LiveToolPulsingModifier: ViewModifier {
    @State private var isPulsing = false

    func body(content: Content) -> some View {
        content
            .opacity(isPulsing ? 0.4 : 1.0)
            .animation(
                Animation.easeInOut(duration: 1.0).repeatForever(autoreverses: true),
                value: isPulsing
            )
            .onAppear { isPulsing = true }
    }
}
