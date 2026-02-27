import SwiftUI
import VellumAssistantShared

/// Describes the current state of a connection check.
struct ConnectionStatusInfo {
    let label: String
    let color: Color
    let icon: String
}

/// A reusable row that displays a labelled connection status with an animated
/// refresh button. Used for Platform, Gateway, and Tunnel status indicators.
struct ConnectionStatusRow: View {
    let label: String
    let status: ConnectionStatusInfo
    var isRefreshing: Bool = false
    var lastChecked: Date? = nil
    var onRefresh: (() -> Void)? = nil

    /// Label font — defaults to `VFont.bodyMedium` to match Gateway/Tunnel.
    var labelFont: Font = VFont.bodyMedium

    /// Fixed width for the label column so icons line up across rows.
    var labelWidth: CGFloat = 60

    @State private var spinning: Bool = false

    var body: some View {
        let isSpinning = isRefreshing || spinning

        HStack(spacing: VSpacing.sm) {
            Text(label)
                .font(labelFont)
                .foregroundColor(VColor.textSecondary)
                .frame(width: labelWidth, alignment: .leading)

            Image(systemName: status.icon)
                .foregroundColor(status.color)
                .font(.system(size: 12))

            Text(status.label)
                .font(VFont.body)
                .foregroundColor(status.color)

            if let onRefresh {
                let tooltipText: String = {
                    if isSpinning { return "Checking..." }
                    if let lastChecked { return "Last verified: \(relativeTimeString(from: lastChecked))" }
                    return "Test connection"
                }()

                Button {
                    guard !isSpinning else { return }
                    spinning = true
                    onRefresh()
                    Task {
                        try? await Task.sleep(nanoseconds: 500_000_000)
                        spinning = false
                    }
                } label: {
                    SpinningRefreshIcon(isSpinning: isSpinning)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Refresh \(label) status")
                .help(tooltipText)
            }

            Spacer()
        }
    }

    /// Returns a human-readable relative time string (e.g. "just now", "2 minutes ago").
    private func relativeTimeString(from date: Date) -> String {
        let seconds = Int(-date.timeIntervalSinceNow)
        if seconds < 5 { return "just now" }
        if seconds < 60 { return "\(seconds) seconds ago" }
        let minutes = seconds / 60
        if minutes == 1 { return "1 minute ago" }
        if minutes < 60 { return "\(minutes) minutes ago" }
        let hours = minutes / 60
        if hours == 1 { return "1 hour ago" }
        return "\(hours) hours ago"
    }
}

// MARK: - Spinning Refresh Icon

struct SpinningRefreshIcon: View {
    let isSpinning: Bool

    @State private var angle: Double = 0

    var body: some View {
        Image(systemName: "arrow.triangle.2.circlepath")
            .font(.system(size: 11, weight: .medium))
            .foregroundColor(isSpinning ? VColor.accent : VColor.textMuted)
            .rotationEffect(.degrees(angle))
            .frame(width: 24, height: 24)
            .contentShape(Rectangle())
            .task(id: isSpinning) {
                if isSpinning {
                    angle = 0
                    while !Task.isCancelled {
                        withAnimation(.linear(duration: 1)) {
                            angle += 360
                        }
                        try? await Task.sleep(nanoseconds: 1_000_000_000)
                    }
                } else {
                    angle = 0
                }
            }
    }
}
