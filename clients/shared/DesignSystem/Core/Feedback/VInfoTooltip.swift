import SwiftUI

/// A small info-circle icon that reliably shows a tooltip on hover.
///
/// Uses a non-interactive view with `.help()` so the tooltip appears on
/// hover without introducing a focusable button to VoiceOver or keyboard
/// navigation. The tooltip text is exposed as an accessibility label so
/// VoiceOver users can hear the supplementary information.
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
        VIconView(.info, size: 12)
            .foregroundColor(VColor.contentTertiary)
            .frame(width: 16, height: 16)
            .contentShape(Rectangle())
            .help(tooltip)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(tooltip)
    }
}

#Preview("VInfoTooltip") {
    ZStack {
        VColor.surfaceOverlay.ignoresSafeArea()
        VStack(alignment: .leading, spacing: 20) {
            HStack(spacing: VSpacing.xs) {
                Text("Some Setting")
                    .font(VFont.caption)
                    .foregroundColor(VColor.contentSecondary)
                VInfoTooltip("This is an explanation of the setting.")
            }
            HStack(spacing: VSpacing.xs) {
                Text("Another Setting")
                    .font(VFont.body)
                    .foregroundColor(VColor.contentSecondary)
                VInfoTooltip("Hover over the icon to see this tooltip.")
            }
        }
        .padding()
    }
    .frame(width: 300, height: 120)
}
