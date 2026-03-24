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
            .foregroundStyle(VColor.contentTertiary)
            .frame(width: 16, height: 16)
            .contentShape(Rectangle())
            .help(tooltip)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(tooltip)
    }
}

