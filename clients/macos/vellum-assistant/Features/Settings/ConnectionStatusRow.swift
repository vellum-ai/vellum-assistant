import SwiftUI
import VellumAssistantShared

/// Describes the current state of a connection check.
struct ConnectionStatusInfo {
    let label: String
    let color: Color
    let icon: String
}

// MARK: - Inline Connection Status

/// A compact status indicator (icon + text + refresh) designed to sit inline
/// next to a URL field. No label column — just the status badge and refresh.
struct InlineConnectionStatus: View {
    let status: ConnectionStatusInfo
    var isRefreshing: Bool = false
    var lastChecked: Date? = nil
    var accessibilityLabel: String = "connection"
    var onRefresh: (() -> Void)? = nil

    @State private var spinning: Bool = false

    var body: some View {
        let isSpinning = isRefreshing || spinning

        HStack(spacing: VSpacing.xs) {
            VIconView(SFSymbolMapping.icon(forSFSymbol: status.icon, fallback: .puzzle), size: 11)
                .foregroundColor(status.color)

            Text(status.label)
                .font(VFont.caption)
                .foregroundColor(status.color)
                .lineLimit(1)

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
                .accessibilityLabel("Refresh \(accessibilityLabel) status")
                .help(tooltipText)
            }
        }
        .fixedSize()
    }

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
        VIconView(.refreshCw, size: 11)
            .foregroundColor(isSpinning ? VColor.primaryBase : VColor.contentTertiary)
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
