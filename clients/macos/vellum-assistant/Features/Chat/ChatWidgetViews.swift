import SwiftUI
import VellumAssistantShared

// MARK: - Running Indicator

/// Minimal in-progress indicator for thinking and tool execution.
/// Supports progressive labels that cycle on a timer for long-running tools.
struct RunningIndicator: View {
    var label: String = "Running"
    /// Whether to show the terminal icon (appropriate for tool execution states).
    var showIcon: Bool = true
    /// Optional sequence of labels to cycle through over time.
    var progressiveLabels: [String] = []
    /// Seconds between each label transition.
    var labelInterval: TimeInterval = 6
    /// Optional tap handler — when set, the indicator becomes a clickable button.
    var onTap: (() -> Void)?

    @State private var phase: Int = 0
    @State private var timer: Timer?
    @State private var currentLabelIndex: Int = 0
    @State private var labelTimer: Timer?
    @State private var isHovered: Bool = false

    private var displayLabel: String {
        if progressiveLabels.isEmpty { return label }
        return progressiveLabels[min(currentLabelIndex, progressiveLabels.count - 1)]
    }

    var body: some View {
        if let onTap {
            Button(action: onTap) {
                indicatorContent
            }
            .buttonStyle(.plain)
            .onHover { hovering in
                isHovered = hovering
            }
        } else {
            indicatorContent
        }
    }

    private var indicatorContent: some View {
        HStack(spacing: VSpacing.xs) {
            if showIcon {
                Image(systemName: "terminal")
                    .font(.system(size: 10))
                    .foregroundColor(VColor.textSecondary)
            }

            Text(displayLabel)
                .font(VFont.caption)
                .foregroundColor(VColor.textSecondary)
                .animation(.easeInOut(duration: 0.3), value: currentLabelIndex)

            ForEach(0..<3, id: \.self) { index in
                Circle()
                    .fill(VColor.textSecondary)
                    .frame(width: 5, height: 5)
                    .opacity(dotOpacity(for: index))
            }

            if onTap != nil {
                Image(systemName: "chevron.right")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundColor(VColor.textMuted)
            }

            Spacer()
        }
        .padding(.horizontal, VSpacing.sm)
        .padding(.vertical, VSpacing.xs)
        .background(
            RoundedRectangle(cornerRadius: VRadius.lg)
                .fill(isHovered ? VColor.backgroundSubtle.opacity(0.6) : Color.clear)
        )
        .contentShape(RoundedRectangle(cornerRadius: VRadius.lg))
        .onAppear {
            startDotAnimation()
            startLabelCycling()
        }
        .onDisappear {
            timer?.invalidate()
            labelTimer?.invalidate()
        }
    }

    private func dotOpacity(for index: Int) -> Double {
        phase == index ? 1.0 : 0.4
    }

    private func startDotAnimation() {
        timer = Timer.scheduledTimer(withTimeInterval: 0.4, repeats: true) { _ in
            withAnimation(.easeInOut(duration: 0.3)) {
                phase = (phase + 1) % 3
            }
        }
    }

    private func startLabelCycling() {
        guard !progressiveLabels.isEmpty else { return }
        labelTimer = Timer.scheduledTimer(withTimeInterval: labelInterval, repeats: true) { _ in
            if currentLabelIndex < progressiveLabels.count - 1 {
                currentLabelIndex += 1
            }
        }
    }
}

struct CodePreviewView: View {
    let code: String

    var body: some View {
        ScrollView {
            Text(displayCode)
                .font(VFont.monoSmall)
                .foregroundColor(VColor.textSecondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(VSpacing.sm)
        }
        .frame(maxHeight: 120)
        .background(VColor.background.opacity(0.6))
        .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.sm)
                .stroke(VColor.surfaceBorder, lineWidth: 0.5)
        )
    }

    private var displayCode: String {
        let lines = code.components(separatedBy: "\n")
        if lines.count > 30 {
            return lines.suffix(30).joined(separator: "\n")
        }
        return code
    }
}
