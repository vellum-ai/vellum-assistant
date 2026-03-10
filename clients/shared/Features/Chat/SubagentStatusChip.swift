import SwiftUI

public struct SubagentStatusChip: View {
    let subagent: SubagentInfo
    var onAbort: (() -> Void)?
    var onTap: (() -> Void)?

    private var statusColor: Color {
        switch subagent.status {
        case .completed: return VColor.success
        case .failed, .aborted: return VColor.error
        default: return VColor.statusRunning
        }
    }

    private var statusIcon: VIcon {
        switch subagent.status {
        case .completed: return .circleCheck
        case .failed: return .circleX
        case .aborted: return .circleStop
        default: return .circleDot
        }
    }

    public init(subagent: SubagentInfo, onAbort: (() -> Void)? = nil, onTap: (() -> Void)? = nil) {
        self.subagent = subagent
        self.onAbort = onAbort
        self.onTap = onTap
    }

    public var body: some View {
        if subagent.isTerminal {
            chipContent(phase: 0)
        } else {
            TimelineView(.periodic(from: .now, by: 0.4)) { context in
                chipContent(phase: Int(context.date.timeIntervalSince1970 / 0.4) % 3)
            }
        }
    }

    @ViewBuilder
    private func chipContent(phase: Int) -> some View {
        HStack(spacing: VSpacing.sm) {
            VIconView(statusIcon, size: 11)
                .foregroundColor(statusColor)

            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: VSpacing.xs) {
                    Text(subagent.label)
                        .font(VFont.captionMedium)
                        .foregroundColor(VColor.textPrimary)

                    if !subagent.isTerminal {
                        // Animated dots
                        HStack(spacing: 2) {
                            ForEach(0..<3, id: \.self) { index in
                                Circle()
                                    .fill(VColor.textSecondary)
                                    .frame(width: 4, height: 4)
                                    .opacity(phase % 3 == index ? 1.0 : 0.3)
                            }
                        }
                    }
                }

                if let error = subagent.error, !error.isEmpty {
                    Text(error)
                        .font(VFont.caption)
                        .foregroundColor(VColor.error)
                        .lineLimit(2)
                }
            }

            Spacer()

            if !subagent.isTerminal, let onAbort {
                VIconView(.x, size: 9)
                    .foregroundColor(VColor.textMuted)
                    .padding(VSpacing.xs)
                    .contentShape(Rectangle())
                    .highPriorityGesture(TapGesture().onEnded { onAbort() })
                    .accessibilityAddTraits(.isButton)
                    .accessibilityLabel("Abort subagent")
            }
        }
        .padding(.horizontal, VSpacing.sm)
        .padding(.vertical, VSpacing.xs)
        .background(
            RoundedRectangle(cornerRadius: VRadius.md)
                .fill(VColor.backgroundSubtle.opacity(0.3))
        )
        .contentShape(Rectangle())
        .onTapGesture { onTap?() }
    }
}
