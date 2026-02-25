import SwiftUI

/// A small info-circle icon that reliably shows a tooltip on hover.
///
/// On macOS, plain `Image` views with `.help()` have inconsistent tooltip
/// tracking. Wrapping the icon in a `Button` ensures the system registers
/// the hover area and shows the tooltip every time.
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
        Button {} label: {
            Image(systemName: "info.circle")
                .font(.system(size: 12))
                .foregroundColor(VColor.textMuted)
                .frame(width: 16, height: 16)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(tooltip)
        .accessibilityLabel(tooltip)
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
