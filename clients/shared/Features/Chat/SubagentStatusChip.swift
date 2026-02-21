import SwiftUI

public struct SubagentStatusChip: View {
    let subagent: SubagentInfo
    var onAbort: (() -> Void)?
    var onTap: (() -> Void)?

    @State private var phase: Int = 0
    @State private var timer: Timer?

    private var statusColor: Color {
        switch subagent.status {
        case .completed: return Emerald._500
        case .failed, .aborted: return Danger._500
        default: return Violet._500
        }
    }

    private var statusIcon: String {
        switch subagent.status {
        case .completed: return "checkmark.circle.fill"
        case .failed: return "xmark.circle.fill"
        case .aborted: return "stop.circle.fill"
        default: return "circle.dotted"
        }
    }

    public init(subagent: SubagentInfo, onAbort: (() -> Void)? = nil, onTap: (() -> Void)? = nil) {
        self.subagent = subagent
        self.onAbort = onAbort
        self.onTap = onTap
    }

    public var body: some View {
        HStack(spacing: VSpacing.sm) {
            Image(systemName: statusIcon)
                .font(.system(size: 11))
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
                                    .opacity(dotOpacity(for: index))
                            }
                        }
                    }
                }

                if let error = subagent.error, !error.isEmpty {
                    Text(error)
                        .font(VFont.caption)
                        .foregroundColor(Danger._400)
                        .lineLimit(2)
                }
            }

            Spacer()

            if !subagent.isTerminal, let onAbort {
                Image(systemName: "xmark")
                    .font(.system(size: 9, weight: .bold))
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
        .onAppear { startDotAnimation() }
        .onDisappear { timer?.invalidate() }
        .onChange(of: subagent.status) {
            if subagent.status.isTerminal {
                timer?.invalidate()
                timer = nil
            }
        }
    }

    private func dotOpacity(for index: Int) -> Double {
        let active = phase % 3
        return index == active ? 1.0 : 0.3
    }

    private func startDotAnimation() {
        guard !subagent.isTerminal else { return }
        timer = Timer.scheduledTimer(withTimeInterval: 0.4, repeats: true) { _ in
            withAnimation(.easeInOut(duration: 0.2)) {
                phase += 1
            }
        }
    }
}
