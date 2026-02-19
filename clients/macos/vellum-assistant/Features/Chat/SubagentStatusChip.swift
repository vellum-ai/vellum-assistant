import VellumAssistantShared
import SwiftUI

struct SubagentStatusChip: View {
    let subagent: SubagentInfo

    @State private var phase: Int = 0
    @State private var timer: Timer?

    private var statusColor: Color {
        switch subagent.status {
        case .completed: return Emerald._500
        case .failed, .aborted: return Rose._500
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

    var body: some View {
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
                        .foregroundColor(Rose._400)
                        .lineLimit(2)
                }
            }

            Spacer()
        }
        .padding(.horizontal, VSpacing.sm)
        .padding(.vertical, VSpacing.xs)
        .background(
            RoundedRectangle(cornerRadius: VRadius.md)
                .fill(VColor.backgroundSubtle.opacity(0.3))
        )
        .onAppear { startDotAnimation() }
        .onDisappear { timer?.invalidate() }
        .onChange(of: subagent.status) { newStatus in
            if newStatus.isTerminal {
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

#Preview("SubagentStatusChip") {
    ZStack {
        VColor.background.ignoresSafeArea()
        VStack(spacing: VSpacing.md) {
            SubagentStatusChip(subagent: SubagentInfo(
                id: "1", label: "Researching API docs", status: .running
            ))
            SubagentStatusChip(subagent: SubagentInfo(
                id: "2", label: "Writing tests", status: .completed
            ))
            SubagentStatusChip(subagent: SubagentInfo(
                id: "3", label: "Deploying service", status: .failed
            ))
        }
        .padding()
        .frame(maxWidth: 520)
    }
    .frame(width: 600, height: 200)
}
