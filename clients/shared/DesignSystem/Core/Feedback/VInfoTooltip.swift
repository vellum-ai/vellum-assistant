import SwiftUI

/// A small info-circle icon that reliably shows a tooltip on hover.
///
/// Uses a non-interactive view with `.help()` so the tooltip appears on
/// hover without introducing a focusable button to VoiceOver or keyboard
/// navigation. The `.accessibilityHidden(true)` keeps it out of the
/// accessibility tree entirely — the adjacent label already conveys the
/// context, and the tooltip text is supplementary.
///
/// Usage:
/// ```swift
/// HStack(spacing: VSpacing.xs) {
///     Text("Label")
///     VInfoTooltip("Explanation of the label.")
/// }
/// ```
public struct VInfoTooltip: View {
    private let tooltip: String

    public init(_ tooltip: String) {
        self.tooltip = tooltip
    }

    public var body: some View {
        Image(systemName: "info.circle")
            .font(.system(size: 12))
            .foregroundColor(VColor.textMuted)
            .frame(width: 16, height: 16)
            .contentShape(Rectangle())
            .help(tooltip)
            .accessibilityHidden(true)
    }
}

#Preview("VInfoTooltip") {
    ZStack {
        VColor.background.ignoresSafeArea()
        VStack(alignment: .leading, spacing: 20) {
            HStack(spacing: VSpacing.xs) {
                Text("Some Setting")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textSecondary)
                VInfoTooltip("This is an explanation of the setting.")
            }
            HStack(spacing: VSpacing.xs) {
                Text("Another Setting")
                    .font(VFont.body)
                    .foregroundColor(VColor.textSecondary)
                VInfoTooltip("Hover over the icon to see this tooltip.")
            }
        }
        .padding()
    }
    .frame(width: 300, height: 120)
}
