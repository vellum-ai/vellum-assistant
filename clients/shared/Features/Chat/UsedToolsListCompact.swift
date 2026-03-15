import SwiftUI

/// Mobile-friendly compact tool execution summary. Shows a collapsible pill
/// ("Completed N steps") that expands to list tool names, status icons, and durations.
public struct UsedToolsListCompact: View {
    let toolCalls: [ToolCallData]
    @State private var isExpanded = false

    private var pillLabel: String {
        let count = toolCalls.count
        if count == 1 { return toolCalls[0].actionDescription }
        return "Completed \(count) steps"
    }

    private var pillIcon: VIcon { .circleCheck }

    private var pillIconColor: Color { VColor.systemPositiveStrong }

    public init(toolCalls: [ToolCallData]) {
        self.toolCalls = toolCalls
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Summary pill
            Button {
                withAnimation(VAnimation.fast) { isExpanded.toggle() }
            } label: {
                HStack(spacing: VSpacing.xs) {
                    VIconView(pillIcon, size: 10)
                        .foregroundColor(pillIconColor)

                    Text(pillLabel)
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentSecondary)
                        .lineLimit(1)

                    VIconView(.chevronRight, size: 9)
                        .foregroundColor(VColor.contentTertiary)
                        .rotationEffect(.degrees(isExpanded ? 90 : 0))
                        .animation(VAnimation.fast, value: isExpanded)
                }
                .padding(.horizontal, VSpacing.sm)
                .padding(.vertical, VSpacing.xs)
                .background(
                    RoundedRectangle(cornerRadius: VRadius.lg)
                        .fill(VColor.surfaceBase.opacity(0.3))
                )
                .contentShape(RoundedRectangle(cornerRadius: VRadius.lg))
            }
            .buttonStyle(.plain)

            // Expanded steps list
            if isExpanded {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(toolCalls.enumerated()), id: \.element.id) { index, toolCall in
                        CompactToolRow(toolCall: toolCall)

                        if index < toolCalls.count - 1 {
                            Divider()
                                .padding(.leading, 34)
                        }
                    }
                }
                .padding(.top, VSpacing.xs)
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .animation(VAnimation.fast, value: isExpanded)
    }
}

private struct CompactToolRow: View {
    let toolCall: ToolCallData

    var body: some View {
        HStack(spacing: VSpacing.sm) {
            // Status icon
            ZStack {
                RoundedRectangle(cornerRadius: VRadius.xs)
                    .fill(toolCall.isError ? VColor.systemNegativeStrong : VColor.systemPositiveStrong)
                    .frame(width: 20, height: 20)

                VIconView(toolCall.isError ? .x : .check, size: 9)
                    .foregroundColor(VColor.auxWhite)
            }

            // Tool description + duration
            VStack(alignment: .leading, spacing: VSpacing.xxs) {
                Text(toolCall.actionDescription)
                    .font(VFont.captionMedium)
                    .foregroundColor(toolCall.isError ? VColor.systemNegativeStrong : VColor.contentDefault)
                    .lineLimit(1)

                if let started = toolCall.startedAt, let completed = toolCall.completedAt {
                    Text(formatDuration(completed.timeIntervalSince(started)))
                        .font(VFont.small)
                        .foregroundColor(VColor.contentTertiary)
                }
            }

            Spacer()
        }
        .padding(.horizontal, VSpacing.sm)
        .padding(.vertical, VSpacing.xs)
    }

    private func formatDuration(_ s: TimeInterval) -> String {
        s < 60
            ? String(format: "%.1fs", s)
            : "\(Int(s) / 60)m \(Int(s) % 60)s"
    }
}
