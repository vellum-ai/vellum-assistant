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

    @State private var startDate: Date = Date()
    @State private var isHovered: Bool = false

    static func formatElapsed(_ elapsed: TimeInterval) -> String {
        let seconds = Int(elapsed)
        if seconds < 60 { return "\(seconds)s" }
        let minutes = seconds / 60
        let remainingSeconds = seconds % 60
        return "\(minutes)m \(remainingSeconds)s"
    }

    private func displayLabel(elapsed: TimeInterval) -> String {
        if progressiveLabels.isEmpty { return label }
        let index = min(Int(elapsed / labelInterval), progressiveLabels.count - 1)
        return progressiveLabels[index]
    }

    var body: some View {
        if let onTap {
            Button(action: onTap) {
                indicatorContent
            }
            .buttonStyle(.plain)
            .vPointerCursor()
            .onHover { hovering in
                isHovered = hovering
            }
        } else {
            indicatorContent
        }
    }

    private var indicatorContent: some View {
        TimelineView(.periodic(from: .now, by: 0.4)) { context in
            let elapsed = context.date.timeIntervalSince(startDate)
            let phase = Int(elapsed / 0.4) % 3
            let currentLabel = displayLabel(elapsed: elapsed)
            let labelIndex = progressiveLabels.isEmpty ? 0 : min(Int(elapsed / labelInterval), progressiveLabels.count - 1)
            HStack(spacing: VSpacing.xs) {
                if showIcon {
                    VIconView(.terminal, size: 10)
                        .foregroundColor(VColor.contentSecondary)
                }

                Text(currentLabel)
                    .font(VFont.caption)
                    .foregroundColor(VColor.contentSecondary)
                    .animation(.easeInOut(duration: 0.3), value: labelIndex)

                ForEach(0..<3, id: \.self) { index in
                    Circle()
                        .fill(VColor.contentSecondary)
                        .frame(width: 5, height: 5)
                        .opacity(phase == index ? 1.0 : 0.4)
                }

                if elapsed >= 5 {
                    Text(Self.formatElapsed(elapsed))
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentTertiary)
                }

                if onTap != nil {
                    VIconView(.chevronRight, size: 9)
                        .foregroundColor(VColor.contentTertiary)
                }

                Spacer()
            }
            .padding(.horizontal, onTap != nil ? VSpacing.sm : 0)
            .padding(.vertical, VSpacing.xs)
            .background(
                RoundedRectangle(cornerRadius: VRadius.lg)
                    .fill(isHovered ? VColor.surfaceBase.opacity(0.6) : Color.clear)
            )
            .contentShape(RoundedRectangle(cornerRadius: VRadius.lg))
        }
        .onAppear {
            startDate = Date()
        }
    }
}

struct CodePreviewView: View {
    let code: String

    var body: some View {
        ScrollView {
            Text(displayCode)
                .font(VFont.monoSmall)
                .foregroundColor(VColor.contentSecondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(VSpacing.sm)
        }
        .frame(maxHeight: 120)
        .background(VColor.surfaceOverlay.opacity(0.6))
        .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.sm)
                .stroke(VColor.borderBase, lineWidth: 0.5)
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
